/**
 * High-level NSF player: owns the machine, calls the file's INIT and PLAY
 * routines on the schedule the header asks for, and hands back audio at
 * whatever rate the host wants.
 *
 * An NSF is a program, not a log of register writes, so "playing" it means
 * running a 6502 while the sound unit is clocked alongside. PLAY is entered by
 * pushing a return address that points nowhere the file can reach; when the
 * program counter arrives there, the routine has returned and the CPU is idle
 * until the next call is due. Between the two, only the sound unit runs.
 */

import { CPU6502, type CPUState } from "./cpu6502.js";
import { NSFBus } from "./bus.js";
import { NTSC_CPU_CLOCK, PAL_CPU_CLOCK, mixAPU } from "./apu.js";
import {
  CIC_RATIO,
  CicDecimator,
  FDS_MIX_LEVEL,
  HalfBand,
  MASTER_OUTPUT_LEVEL,
  NesFilter,
  VRC6_MIX_LEVEL,
  VRC7_MIX_LEVEL,
  N163_MIX_LEVEL,
} from "./mixer.js";
import { mixVRC6 } from "./vrc6.js";
import { Resampler } from "./resampler.js";
import { isNSFFile, parseNSF, type NSFFile } from "./nsf-file.js";
import { restore, snapshot } from "./state.js";

export { isNSFFile };

/** Address the CPU lands on when INIT or PLAY returns; nothing is mapped here. */
const SENTINEL = 0x5af0;

/** Cycles INIT is given before the player gives up waiting for it to return. */
const INIT_CYCLE_LIMIT = 4_000_000;

/**
 * Samples computed in full at the end of a skip, to settle the filters: ten
 * time constants of the 37 Hz high pass at 44.1 kHz, after which what is left
 * of a standing offset is below the last bit.
 */
const FILTER_PRIME_SAMPLES = 2048;

/**
 * Longest span the machine is advanced in one go.
 *
 * Between calls to the file's PLAY routine the CPU has nothing to do and the
 * sound unit may have nothing to change either, so there is no upper limit in
 * the hardware - but a bound keeps the samples produced by one step to a size
 * the pending buffer can hold, and keeps a seek from overshooting its target by
 * more than it can correct.
 */
const MAX_ADVANCE_CYCLES = 1024;

const DEFAULT_PLAY_SECONDS = 150;
const DEFAULT_FADE_SECONDS = 5;

/** Channels in the order they appear in {@link NSFPlayer.channelCapture}. */
export const CHANNEL_COUNT = 23;
export const CH_PULSE1 = 0;
export const CH_PULSE2 = 1;
export const CH_TRIANGLE = 2;
export const CH_NOISE = 3;
export const CH_DMC = 4;
export const CH_FDS = 5;
export const CH_VRC6_PULSE1 = 6;
export const CH_VRC6_PULSE2 = 7;
export const CH_VRC6_SAW = 8;
/** First of the VRC7's six FM channels, which run consecutively from here. */
export const CH_VRC7 = 9;
const VRC7_CHANNELS = 6;
/** First of the N163's eight wavetable channels; channel 8 is the last. */
export const CH_N163 = 15;
const N163_CHANNELS = 8;

export type ChannelKind =
  | "pulse"
  | "triangle"
  | "noise"
  | "dmc"
  | "fds"
  | "vrc6-pulse"
  | "vrc6-saw"
  | "vrc7"
  | "n163";

export interface ChannelStatus {
  index: number;
  kind: ChannelKind;
  /** True while the channel is contributing something audible. */
  active: boolean;
  /** Level as the channel's own DAC sees it, normalised to 0..1. */
  level: number;
  /** MIDI note number, fractional; null for the channels with no pitch. */
  note: number | null;
  /** Timer period as the registers hold it. */
  period: number;
  /** Duty for a pulse, mode for the noise, rate index for the DMC, instrument
   *  for a VRC7 channel, wavetable address for an N163 one. */
  detail: number;
  /** Retriggers since load, for telling a new note from a held one. */
  keyOnCount: number;
}

export interface NSFPlayerOptions {
  /** Output sample rate. Defaults to 44100. */
  sampleRate?: number;
  /** Force PAL timing. Defaults to whatever the file declares. */
  pal?: boolean;
  /** Track length in seconds when the file gives none. Defaults to 150. */
  defaultPlaySeconds?: number;
  /** Fade length in seconds when the file gives none. Defaults to 5. */
  defaultFadeSeconds?: number;
}

/** A complete, transferable player snapshot. */
export interface NSFPlayerState {
  cpu: CPUState;
  apu: unknown;
  fds: unknown;
  vrc6: unknown;
  vrc7: unknown;
  n163: unknown;
  ram: Uint8Array;
  /** The banks a driver can write to, and which bank each one is. */
  banks: { bank: number; data: Uint8Array }[];
  bankMap: Int32Array;
  cpuIdle: boolean;
  cyclesToPlay: number;
  outputSample: number;
  cpuCycle: number;
  resampler: unknown;
  cic: unknown;
  halfBand: unknown;
  filter: unknown;
  channelHp: Float64Array;
}

export class NSFPlayer {
  readonly sampleRate: number;

  private file: NSFFile | null = null;
  private bus: NSFBus | null = null;
  private cpu: CPU6502 | null = null;

  private pal = false;
  private cpuClock = NTSC_CPU_CLOCK;
  /** CPU cycles between PLAY calls. */
  private playPeriod = 0;

  private cic = new CicDecimator();
  private halfBand = new HalfBand();
  private resampler: Resampler | null = null;
  private filter: NesFilter;

  private trackIndex = 0;
  private cpuIdle = true;
  /** Cycles until the next PLAY call; kept as a running balance so that a slow
   *  PLAY routine borrows from the next frame instead of shifting the tempo. */
  private cyclesToPlay = 0;

  /** Output samples produced since the track started. */
  private outputSample = 0;
  /** CPU cycles run since the track started. */
  private cpuCycle = 0;

  private readonly options: Required<NSFPlayerOptions>;

  /** Bit per channel: 1 = left out of the mix. Emulation is unaffected. */
  private channelMask = 0;

  /** Per-channel accumulators for the current output sample. */
  private chAcc = new Float64Array(CHANNEL_COUNT);
  private chAccCount = 0;
  /** One-pole state for the per-channel DC blockers. */
  private channelHp = new Float64Array(CHANNEL_COUNT);
  private chHpCoef = 0;

  /** Whether {@link channelCapture} is filled during rendering. */
  channelCaptureEnabled = false;
  private channelCaptureBuffer = new Int16Array(0);
  private channelCaptureCount = 0;

  constructor(options: NSFPlayerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    this.options = {
      sampleRate: this.sampleRate,
      pal: options.pal ?? false,
      defaultPlaySeconds: options.defaultPlaySeconds ?? DEFAULT_PLAY_SECONDS,
      defaultFadeSeconds: options.defaultFadeSeconds ?? DEFAULT_FADE_SECONDS,
    };
    this.filter = new NesFilter(this.sampleRate);
    this.chHpCoef = Math.exp((-2 * Math.PI * 30) / this.sampleRate);
  }

  /**
   * Per-channel output for the samples the last render produced: CHANNEL_COUNT int16 per
   * output sample, in the CH_* order, each with its own standing offset removed
   * so a scope shows a waveform rather than an envelope.
   */
  get channelCapture(): Int16Array {
    return this.channelCaptureBuffer;
  }

  /** Output samples captured by the last render. */
  get channelCaptureLength(): number {
    return this.channelCaptureCount;
  }

  /** The wavetable an N163 channel (0-7) is playing, one 4-bit sample per byte;
   *  null with no N163. */
  n163Wave(ch: number): Uint8Array | null {
    return this.bus?.n163?.wave(ch) ?? null;
  }

  /** The FDS wavetable (64 six-bit samples), or null with no FDS channel. */
  get fdsWave(): Uint8Array | null {
    return this.bus?.fds?.wave ?? null;
  }

  // ------------------------------------------------------------------ loading

  load(input: Uint8Array | ArrayBuffer | NSFFile, track?: number): void {
    const file =
      input instanceof ArrayBuffer
        ? parseNSF(new Uint8Array(input))
        : input instanceof Uint8Array
          ? parseNSF(input)
          : input;
    this.file = file;

    this.pal = this.options.pal || file.region === "pal";
    this.cpuClock = this.pal ? PAL_CPU_CLOCK : NTSC_CPU_CLOCK;
    const speedUs = this.pal ? file.palSpeedUs : file.ntscSpeedUs;
    this.playPeriod = Math.max(1, Math.round((speedUs * this.cpuClock) / 1e6));

    this.bus = new NSFBus(file, this.pal);
    this.cpu = new CPU6502(this.bus);

    // Three stages: the decimator at the CPU clock, a half-band halving what it
    // leaves, then the windowed sinc down to the host's rate.
    const inRate = this.cpuClock / CIC_RATIO / 2;
    this.resampler = new Resampler(inRate, this.sampleRate);

    // One advance yields at most one sample per decimated input.
    this.maxSamplesPerAdvance =
      Math.ceil((MAX_ADVANCE_CYCLES * this.sampleRate) / this.cpuClock) + 1;
    const room = Math.ceil(MAX_ADVANCE_CYCLES / CIC_RATIO) + 8;
    this.cicOut = new Float64Array(room);
    this.pendingSamples = new Float64Array(room);
    this.pendingCount = 0;
    this.pendingRead = 0;

    this.setTrack(track ?? file.startTrack);
  }

  get nsf(): NSFFile | null {
    return this.file;
  }

  get track(): number {
    return this.trackIndex;
  }

  get trackCount(): number {
    return this.file?.trackCount ?? 0;
  }

  /** Restart the machine on `track` and run its INIT routine. */
  setTrack(track: number): void {
    const file = this.file;
    const bus = this.bus;
    const cpu = this.cpu;
    if (file == null || bus == null || cpu == null) throw new Error("nsf: no file loaded");

    this.trackIndex = Math.max(0, Math.min(file.trackCount - 1, track));
    this.playOverride = null;
    this.outputSample = 0;
    this.cpuCycle = 0;
    this.cyclesToPlay = 0;
    this.chAcc.fill(0);
    this.chAccCount = 0;
    this.channelHp.fill(0);
    this.cic.clear();
    this.halfBand.clear();
    this.resampler?.clear();
    this.filter.clear();

    bus.reset();
    cpu.reset();

    // The state the spec has a player establish before INIT: silence, a frame
    // counter in four-step mode, and the header's banks in place.
    for (let a = 0x4000; a <= 0x4013; a++) bus.write(a, 0);
    bus.write(0x4015, 0x00);
    bus.write(0x4015, 0x0f);
    bus.write(0x4017, 0x40);
    if (file.chips.fds) {
      // Give the FDS channel a defined starting point too: silent, envelopes at
      // the usual master speed, wavetable open for the driver to fill.
      bus.write(0x4080, 0x80);
      bus.write(0x4084, 0x80);
      bus.write(0x4089, 0x80);
      bus.write(0x408a, 0xe8);
    }
    bus.applyInitialBanks();

    this.pendingCount = 0;
    this.pendingRead = 0;
    this.refreshMix(true);

    cpu.a = this.trackIndex;
    cpu.x = this.pal ? 1 : 0;
    cpu.y = 0;
    this.enter(file.initAddress, true);

    // INIT is expected to return. An NSF2 file may declare that it does not, and
    // a broken file may simply hang, so the wait is bounded either way.
    //
    // Whatever the machine emits while INIT runs is thrown away: the routine is
    // setting up, and its output is not part of the track. The resampler still
    // advances through it, as it would on the hardware.
    const limit = file.nonReturningInit ? this.playPeriod : INIT_CYCLE_LIMIT;
    let spent = 0;
    this.discardOutput = true;
    while (!this.cpuIdle && spent < limit) spent += this.stepMachine();
    this.discardOutput = false;
    this.pendingCount = 0;
    this.pendingRead = 0;
  }

  /**
   * Push a sentinel return address and jump; the routine's RTS lands on it.
   *
   * INIT is entered with interrupts masked, as the spec has it. PLAY is not:
   * the interrupt flag belongs to the driver by then, and a file using its own
   * IRQ would have it taken away on every frame.
   */
  private enter(address: number, maskInterrupts = false): void {
    const cpu = this.cpu!;
    cpu.s = 0xff;
    cpu.push2(SENTINEL - 1);
    cpu.pc = address;
    if (maskInterrupts) cpu.fi = 1;
    this.cpuIdle = false;
  }

  // ---------------------------------------------------------------- rendering

  /**
   * Run the machine for one instruction, or one idle cycle, and clock the sound
   * unit for exactly as long. Returns the cycles that passed.
   */
  /** Samples reached during the current {@link skip}. */
  private skippedSamples = 0;
  /** True while {@link skip} is running: computed samples are thrown away. */
  private discardOutput = false;

  private stepMachine(audible = true): number {
    const cpu = this.cpu!;
    const bus = this.bus!;
    const file = this.file!;

    let cycles: number;
    if (this.cpuIdle) {
      // Between PLAY calls the CPU has nothing to do, so the whole wait can be
      // taken in one step - except for a file that handles its own interrupts,
      // where the CPU has to be given the chance to see one arrive.
      cycles = file.irqSupport
        ? 1
        : Math.max(1, Math.min(this.cyclesToPlay, this.advanceLimit));
    } else {
      cpu.irqLine = file.irqSupport && bus.apu.irqAsserted;
      cycles = cpu.step();
      if (cpu.pc === SENTINEL || cpu.jammed) this.cpuIdle = true;
    }

    this.clockDevices(cycles, audible);
    // Cycles the DMC's DMA stole go to the CPU, which pays them on its next
    // instruction.
    const stall = bus.takeStall();
    if (stall > 0 && !this.cpuIdle) cpu.stall(stall);

    this.cpuCycle += cycles;
    this.cyclesToPlay -= cycles;
    return cycles;
  }

  /**
   * Samples the machine has produced but the caller has not taken yet.
   *
   * One advance can cross several sample positions, so output is queued here
   * rather than handed back one at a time.
   */
  private pendingSamples = new Float64Array(0);
  private pendingCount = 0;
  private pendingRead = 0;
  /** Decimated samples from a single advance. */
  private cicOut = new Float64Array(0);

  /** Cap on one advance; lowered near the end of a skip so it lands exactly. */
  private advanceLimit = MAX_ADVANCE_CYCLES;
  /** Most samples a full-length advance can produce, at this sample rate. */
  private maxSamplesPerAdvance = 1;

  /**
   * Whether {@link skip} runs the last stretch in full to settle the analogue
   * filters.
   *
   * On for a player whose output will be heard, where a seek would otherwise
   * land on a step of up to half full scale. Off is for a look-ahead scanner:
   * it never renders, so the filters mean nothing to it and priming would cost
   * it most of the speed a skip is for.
   */
  filterPrimeOnSkip = true;

  /** Channel levels the last mix was computed from, and its result. Most CPU
   *  cycles change nothing, so the mixer is skipped rather than repeated. */
  private lastLevels = new Int32Array(CHANNEL_COUNT);
  /** The same levels unquantised, for the per-channel capture. */
  private chLast = new Float64Array(CHANNEL_COUNT);
  private lastMixed = 0;
  /** The N163's DAC as last mixed, with the mute mask applied. */
  private lastN163 = 0;

  /**
   * Advance the machine `cycles` CPU cycles and produce whatever output falls
   * inside, in as few steps as the sound unit allows.
   *
   * Each step runs to the next cycle at which something could change. Within a
   * step the mix is constant, so all but its final cycle carry the value already
   * in hand and only the last one needs the mixer - which is the whole point:
   * fewer than one cycle in a hundred changes anything.
   */
  private clockDevices(cycles: number, audible = true): void {
    const bus = this.bus!;
    const apu = bus.apu;
    const fds = bus.fds;
    const vrc6 = bus.vrc6;
    const vrc7 = bus.vrc7;
    const n163 = bus.n163;
    // Per-channel accumulation only earns its cost when something is actually
    // going to look at the waveforms.
    const capture = this.channelCaptureEnabled;

    // The CPU has just run, and a register write of its own changes a level
    // straight away - from the first cycle of this span, not the last.
    this.refreshMix();

    let remaining = cycles;
    while (remaining > 0) {
      let step = apu.cyclesToEvent();
      if (fds != null) {
        const f = fds.cyclesToEvent();
        if (f < step) step = f;
      }
      if (vrc6 != null) {
        const v = vrc6.cyclesToEvent();
        if (v < step) step = v;
      }
      if (vrc7 != null) {
        const v = vrc7.cyclesToEvent();
        if (v < step) step = v;
      }
      if (n163 != null) {
        const v = n163.cyclesToEvent();
        if (v < step) step = v;
      }
      if (step > remaining) step = remaining;
      if (step > this.advanceLimit) step = this.advanceLimit;
      if (step < 1) step = 1;

      // Everything before the final cycle of the span carries the value already
      // in hand.
      if (step > 1) this.feed(this.lastMixed, step - 1, audible, capture);

      apu.advance(step);
      if (fds != null) fds.clock(step);
      if (vrc6 != null) vrc6.advance(step);
      if (vrc7 != null) vrc7.advance(step);
      if (n163 != null) n163.clock(step);
      remaining -= step;

      this.refreshMix();
      this.feed(this.lastMixed, 1, audible, capture);
    }
  }

  /**
   * Bring the held mix in step with the machine's current outputs.
   *
   * The advance loop carries this value forward as the one every cycle of the
   * next span begins with, so it has to be re-derived after anything that can
   * change a level: an advance, a register write the CPU has just made, a track
   * change, a restored state, a change of mute mask. Unchanged levels cost only
   * the comparison, which is the case better than 99% of the time.
   */
  private refreshMix(force = false): void {
    const bus = this.bus;
    if (bus == null) return;
    const apu = bus.apu;
    const fds = bus.fds;
    const mask = this.channelMask;
    const p1 = apu.pulse1.output;
    const p2 = apu.pulse2.output;
    const tri = apu.triangle.output;
    const noise = apu.noise.output;
    const dmc = apu.dmc.output;
    const fdsOut = fds != null ? fds.output : 0;
    const vrc6 = bus.vrc6;
    const v1 = vrc6 != null ? vrc6.pulse1.output : 0;
    const v2 = vrc6 != null ? vrc6.pulse2.output : 0;
    const vsaw = vrc6 != null ? vrc6.saw.output : 0;
    const vrc7 = bus.vrc7;
    // Levels for the per-channel capture, which wants them unquantised.
    const chLast = this.chLast;
    const last = this.lastLevels;
    chLast[0] = p1;
    chLast[1] = p2;
    chLast[2] = tri;
    chLast[3] = noise;
    chLast[4] = dmc;
    chLast[5] = fdsOut;
    chLast[6] = v1;
    chLast[7] = v2;
    chLast[8] = vsaw;
    // The VRC7 changes on every one of its samples while anything is sounding,
    // so its channels are compared as a group, and only when it is there.
    let vrc7Changed = false;
    if (vrc7 != null) {
      const out = vrc7.out;
      for (let i = 0; i < VRC7_CHANNELS; i++) {
        const v = out[i];
        chLast[CH_VRC7 + i] = v;
        if (v !== last[CH_VRC7 + i]) {
          last[CH_VRC7 + i] = v;
          vrc7Changed = true;
        }
      }
    }
    // The N163 has one DAC, switched between its channels, so it is one level
    // to compare; the channels' own held outputs are only for the capture.
    let n163Changed = false;
    const n163 = bus.n163;
    if (n163 != null) {
      const out = n163.channelOut;
      for (let i = 0; i < N163_CHANNELS; i++) chLast[CH_N163 + i] = out[i];
      const masked = mask & (1 << (CH_N163 + n163.outputChannel));
      const dac = masked ? 0 : n163.output;
      if (dac !== this.lastN163) {
        this.lastN163 = dac;
        n163Changed = true;
      }
    }
    // The FDS output is a float, so it is compared as a scaled integer; a
    // difference too small to survive that is too small to hear.
    const fdsLevel = fds != null ? (fdsOut * 65536) | 0 : 0;
    if (
      !force &&
      !vrc7Changed &&
      !n163Changed &&
      p1 === last[0] &&
      p2 === last[1] &&
      tri === last[2] &&
      noise === last[3] &&
      dmc === last[4] &&
      fdsLevel === last[5] &&
      v1 === last[6] &&
      v2 === last[7] &&
      vsaw === last[8]
    ) {
      return;
    }
    last[0] = p1;
    last[1] = p2;
    last[2] = tri;
    last[3] = noise;
    last[4] = dmc;
    last[5] = fdsLevel;
    last[6] = v1;
    last[7] = v2;
    last[8] = vsaw;
    let mixed =
      mixAPU(
        mask & 0x01 ? 0 : p1,
        mask & 0x02 ? 0 : p2,
        mask & 0x04 ? 0 : tri,
        mask & 0x08 ? 0 : noise,
        mask & 0x10 ? 0 : dmc
      ) + (mask & 0x20 ? 0 : fdsOut * FDS_MIX_LEVEL);
    if (vrc6 != null) {
      mixed +=
        mixVRC6(
          mask & 0x40 ? 0 : v1,
          mask & 0x80 ? 0 : v2,
          mask & 0x100 ? 0 : vsaw
        ) * VRC6_MIX_LEVEL;
    }
    if (vrc7 != null) {
      const out = vrc7.out;
      let sum = 0;
      for (let i = 0; i < VRC7_CHANNELS; i++) {
        if (!(mask & (1 << (CH_VRC7 + i)))) sum += out[i];
      }
      mixed += (sum / 4096) * VRC7_MIX_LEVEL;
    }
    if (n163 != null) mixed += (this.lastN163 / 120) * N163_MIX_LEVEL;
    this.lastMixed = mixed;
  }

  /**
   * Push a run of one mixed value through the rate reduction.
   *
   * The per-channel capture is accumulated here rather than by the caller,
   * because this is where the sample boundaries inside the run are known: each
   * decimated output stands for a fixed number of CPU cycles, and a capture
   * taken at one of them has to cover exactly the cycles up to it - the same
   * division a per-cycle loop would arrive at.
   */
  private feed(value: number, count: number, audible: boolean, capture: boolean): void {
    if (count <= 0) return;
    const cicOut = this.cicOut;
    const ratio = this.cic.ratio;
    const startPhase = this.cic.phase;
    const n = this.cic.pushRun(value, count, cicOut);
    const chLast = this.chLast;
    const acc = this.chAcc;

    if (n === 0) {
      if (capture) {
        for (let c = 0; c < CHANNEL_COUNT; c++) acc[c] += chLast[c] * count;
        this.chAccCount += count;
      }
      return;
    }

    const resampler = this.resampler!;
    const halfBand = this.halfBand;
    let consumed = 0;
    for (let i = 0; i < n; i++) {
      if (capture) {
        const cycles = i === 0 ? ratio - startPhase : ratio;
        consumed += cycles;
        for (let c = 0; c < CHANNEL_COUNT; c++) acc[c] += chLast[c] * cycles;
        this.chAccCount += cycles;
      }
      if (!halfBand.push(cicOut[i])) continue;
      if (!resampler.push(halfBand.value, audible)) continue;
      if (!audible) {
        this.skippedSamples++;
        if (capture) this.chAccReset();
        continue;
      }
      const sample = this.filter.process(resampler.value);
      if (this.discardOutput) {
        // A primed sample during a skip: the filter needed it, the caller does
        // not.
        this.skippedSamples++;
        if (capture) this.chAccReset();
        continue;
      }
      if (this.pendingCount >= this.pendingSamples.length) {
        // Only reachable if a caller advances further in one go than the queue
        // was sized for; growing beats dropping audio.
        const grown = new Float64Array(Math.max(64, this.pendingCount * 2));
        grown.set(this.pendingSamples);
        this.pendingSamples = grown;
      }
      this.pendingSamples[this.pendingCount++] = sample;
      if (capture) this.captureChannels();
    }

    if (capture) {
      // Cycles that did not complete a decimated output belong to the run too.
      const leftover = count - consumed;
      if (leftover > 0) {
        for (let c = 0; c < CHANNEL_COUNT; c++) acc[c] += chLast[c] * leftover;
        this.chAccCount += leftover;
      }
    }
  }

  private chAccReset(): void {
    this.chAcc.fill(0);
    this.chAccCount = 0;
  }

  /** Full-scale value of each channel's own DAC, for normalising the capture. */
  private static readonly CH_SCALE = [
    15, 15, 15, 15, 127, 1, 15, 15, 31, 4096, 4096, 4096, 4096, 4096, 4096,
    120, 120, 120, 120, 120, 120, 120, 120,
  ];

  private captureChannels(): void {
    const need = (this.channelCaptureCount + 1) * CHANNEL_COUNT;
    if (need > this.channelCaptureBuffer.length) {
      const grown = new Int16Array(
        Math.max(need, this.channelCaptureBuffer.length * 2, CHANNEL_COUNT * 1024)
      );
      grown.set(this.channelCaptureBuffer);
      this.channelCaptureBuffer = grown;
    }
    const at = this.channelCaptureCount * CHANNEL_COUNT;
    // Zero would mean an advance crossed two sample instants without the
    // machine being stepped between them, leaving nothing to average. That
    // cannot happen at this machine's event rate - the CPU is visited far more
    // often than the output is sampled - but reading it as silence would draw
    // as a trace snapping to zero, so it falls back to the level in hand.
    const n = this.chAccCount;
    const coef = this.chHpCoef;
    const chLast = this.chLast;
    for (let c = 0; c < CHANNEL_COUNT; c++) {
      const raw = (n > 0 ? this.chAcc[c] / n : chLast[c]) / NSFPlayer.CH_SCALE[c];
      // Each channel's DAC is unipolar, so its own offset is removed here.
      this.channelHp[c] = coef * this.channelHp[c] + (1 - coef) * raw;
      const v = (raw - this.channelHp[c]) * 24000;
      this.channelCaptureBuffer[at + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
    }
    this.channelCaptureCount++;
    this.chAccReset();
  }

  /**
   * Render `count` mono samples into the supplied buffers. Both channels get
   * the same signal: the NES mixes to one output, and anything else would be an
   * invention.
   */
  renderInto(left: Int16Array, right: Int16Array, offset: number, count: number): number {
    if (this.file == null) return 0;
    this.channelCaptureCount = 0;

    let produced = 0;
    while (produced < count) {
      // Hand out whatever the machine has already made.
      while (this.pendingRead < this.pendingCount && produced < count) {
        const v = Math.round(this.pendingSamples[this.pendingRead++] * MASTER_OUTPUT_LEVEL);
        const clipped = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        if (clipped !== v) this.clippedSamples++;
        left[offset + produced] = clipped;
        right[offset + produced] = clipped;
        produced++;
      }
      if (this.pendingRead >= this.pendingCount) {
        this.pendingRead = 0;
        this.pendingCount = 0;
      }
      if (produced >= count) break;

      if (this.cpuIdle && this.cyclesToPlay <= 0 && !this.file.noPlayCalls) {
        this.cyclesToPlay += this.playPeriod;
        this.enter(this.file.playAddress);
      }
      this.stepMachine();
    }

    this.applyFade(left, right, offset, count);
    this.outputSample += count;
    return count;
  }

  /**
   * Advance `count` output samples without producing audio.
   *
   * Used to fast-forward to a seek target and to run a look-ahead scanner. The
   * machine and the decimator run exactly as they would for real playback - the
   * emulation is the point - but the resampling kernel and the per-channel
   * capture are skipped, and the analogue filter is left to settle again on the
   * next real sample.
   */
  skip(count: number): void {
    if (this.file == null || count <= 0) return;
    this.channelCaptureCount = 0;
    this.skippedSamples = 0;
    this.discardOutput = true;

    // Samples already computed but not handed out count towards the skip.
    while (this.pendingRead < this.pendingCount && this.skippedSamples < count) {
      this.pendingRead++;
      this.skippedSamples++;
    }
    if (this.pendingRead >= this.pendingCount) {
      this.pendingRead = 0;
      this.pendingCount = 0;
    }

    // The last stretch is computed in full and discarded, so the analogue
    // filter is settled by the time real samples resume. Without it a seek
    // lands on a step of up to half full scale as the high passes recharge.
    const primeAt = this.filterPrimeOnSkip ? Math.max(0, count - FILTER_PRIME_SAMPLES) : count;

    while (this.skippedSamples < count) {
      // One full-length advance can cross tens of sample positions, which would
      // overshoot both the target and the point the priming starts at. Once
      // either is within reach, step cycle by cycle: it costs a fraction of a
      // millisecond, and the skip then lands on exactly the sample asked for.
      this.advanceLimit =
        this.skippedSamples + this.maxSamplesPerAdvance >= primeAt ? 1 : MAX_ADVANCE_CYCLES;
      if (this.cpuIdle && this.cyclesToPlay <= 0 && !this.file.noPlayCalls) {
        this.cyclesToPlay += this.playPeriod;
        this.enter(this.file.playAddress);
      }
      this.stepMachine(this.skippedSamples >= primeAt);
    }

    this.advanceLimit = MAX_ADVANCE_CYCLES;
    this.discardOutput = false;
    this.outputSample += count;
  }

  /** Render `count` samples into freshly allocated buffers. */
  render(count: number): { left: Int16Array; right: Int16Array } {
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    this.renderInto(left, right, 0, count);
    return { left, right };
  }

  private applyFade(left: Int16Array, right: Int16Array, offset: number, count: number): void {
    const fade = this.fadeSeconds;
    if (fade <= 0) return;
    const fadeStart = this.playSeconds * this.sampleRate;
    const fadeLength = fade * this.sampleRate;
    if (this.outputSample + count <= fadeStart) return;

    for (let i = 0; i < count; i++) {
      const pos = this.outputSample + i - fadeStart;
      if (pos < 0) continue;
      const gain = pos >= fadeLength ? 0 : 1 - pos / fadeLength;
      left[offset + i] = (left[offset + i] * gain) | 0;
      right[offset + i] = (right[offset + i] * gain) | 0;
    }
  }

  // ------------------------------------------------------------------- timing

  /** Length set by the host, overriding both the metadata and the defaults. */
  private playOverride: { play: number; fade: number } | null = null;

  /**
   * Override the track length.
   *
   * A plain NSF states no length at all, so a host that works out where the
   * music actually stops - by watching for silence, say - needs to be able to
   * move the fade to match.
   */
  setPlayLength(playSeconds: number, fadeSeconds?: number): void {
    this.playOverride = {
      play: Math.max(0, playSeconds),
      fade: Math.max(0, fadeSeconds ?? this.fadeSeconds),
    };
  }

  /** Seconds of music before the fade begins. */
  get playSeconds(): number {
    if (this.playOverride != null) return this.playOverride.play;
    const ms = this.file?.trackTimes[this.trackIndex];
    if (ms != null && ms > 0) return ms / 1000;
    return this.options.defaultPlaySeconds;
  }

  get fadeSeconds(): number {
    if (this.playOverride != null) return this.playOverride.fade;
    const ms = this.file?.trackFades[this.trackIndex];
    if (ms != null && ms >= 0) return ms / 1000;
    return this.options.defaultFadeSeconds;
  }

  get totalSeconds(): number {
    return this.playSeconds + this.fadeSeconds;
  }

  /** Output samples rendered so far, as a time in seconds. */
  get currentTime(): number {
    return this.outputSample / this.sampleRate;
  }

  get finished(): boolean {
    return this.currentTime >= this.totalSeconds;
  }

  /** Output samples that hit the rails since the track started. */
  clippedSamples = 0;

  /** True once the CPU has hit an opcode that stops it - a broken track, or a
   *  gap in this emulator. Either way the sound unit keeps running. */
  get jammed(): boolean {
    return this.cpu?.jammed ?? false;
  }

  /** CPU cycles run since the track started. */
  get cycleCount(): number {
    return this.cpuCycle;
  }

  // ------------------------------------------------------------ channel state

  /** Bit per channel: 1 = muted in the output mix. */
  setChannelMask(mask: number): void {
    const all = (1 << CHANNEL_COUNT) - 1;
    if ((mask & all) === this.channelMask) return;
    this.channelMask = mask & all;
    // The held mix was computed under the old mask.
    this.refreshMix(true);
  }

  getChannelMask(): number {
    return this.channelMask;
  }

  private noteFromFrequency(f: number): number | null {
    if (!(f > 20) || f > 20000) return null;
    return 69 + 12 * Math.log2(f / 440);
  }

  getChannelStatus(index: number): ChannelStatus {
    const bus = this.bus;
    const apu = bus?.apu;
    const base: ChannelStatus = {
      index,
      kind: "pulse",
      active: false,
      level: 0,
      note: null,
      period: 0,
      detail: 0,
      keyOnCount: 0,
    };
    if (apu == null) return base;

    switch (index) {
      case CH_PULSE1:
      case CH_PULSE2: {
        const ch = index === CH_PULSE1 ? apu.pulse1 : apu.pulse2;
        const level = ch.length > 0 ? ch.env.volume : 0;
        return {
          ...base,
          kind: "pulse",
          active: level > 0 && ch.period >= 8,
          level: level / 15,
          // A pulse's sequencer divides the timer by sixteen.
          note: this.noteFromFrequency(this.cpuClock / (16 * (ch.period + 1))),
          period: ch.period,
          detail: ch.duty,
          keyOnCount: ch.keyOnCount,
        };
      }
      case CH_TRIANGLE: {
        const ch = apu.triangle;
        const on = ch.length > 0 && ch.linearCounter > 0;
        return {
          ...base,
          kind: "triangle",
          active: on && ch.period >= 2,
          level: on ? 1 : 0,
          // Thirty-two steps rather than sixteen: an octave below a pulse at
          // the same period.
          note: this.noteFromFrequency(this.cpuClock / (32 * (ch.period + 1))),
          period: ch.period,
          detail: 0,
          keyOnCount: ch.keyOnCount,
        };
      }
      case CH_NOISE: {
        const ch = apu.noise;
        const level = ch.length > 0 ? ch.env.volume : 0;
        return {
          ...base,
          kind: "noise",
          active: level > 0,
          level: level / 15,
          note: null,
          period: ch.periodIndex,
          detail: ch.shortMode ? 1 : 0,
          keyOnCount: ch.keyOnCount,
        };
      }
      case CH_DMC: {
        const ch = apu.dmc;
        return {
          ...base,
          kind: "dmc",
          active: ch.bytesRemaining > 0 || !ch.silence,
          level: ch.output / 127,
          note: null,
          period: ch.rateIndex,
          detail: ch.sampleAddress,
          keyOnCount: ch.keyOnCount,
        };
      }
      case CH_VRC6_PULSE1:
      case CH_VRC6_PULSE2: {
        const vrc6 = bus?.vrc6;
        if (vrc6 == null) return { ...base, kind: "vrc6-pulse" };
        const ch = index === CH_VRC6_PULSE1 ? vrc6.pulse1 : vrc6.pulse2;
        const period = vrc6.effectivePeriod(ch.period);
        return {
          ...base,
          kind: "vrc6-pulse",
          active: ch.enabled && ch.volume > 0 && !vrc6.isHalted,
          level: ch.volume / 15,
          // Sixteen duty steps to a cycle, like the 2A03's pulses.
          note: this.noteFromFrequency(this.cpuClock / (16 * (period + 1))),
          period,
          // A channel in mode 1 is a bare DAC rather than a duty generator, which
          // is worth telling apart on a display.
          detail: ch.mode ? 8 : ch.duty,
          keyOnCount: ch.keyOnCount,
        };
      }
      case CH_VRC6_SAW: {
        const vrc6 = bus?.vrc6;
        if (vrc6 == null) return { ...base, kind: "vrc6-saw" };
        const saw = vrc6.saw;
        const period = vrc6.effectivePeriod(saw.period);
        return {
          ...base,
          kind: "vrc6-saw",
          active: saw.enabled && saw.rate > 0 && !vrc6.isHalted,
          // The accumulator saturates at a rate of 42, so that is full scale.
          level: Math.min(1, saw.rate / 42),
          // Fourteen clocks to a ramp.
          note: this.noteFromFrequency(this.cpuClock / (14 * (period + 1))),
          period,
          detail: saw.rate,
          keyOnCount: saw.keyOnCount,
        };
      }
      case CH_FDS: {
        const fds = bus?.fds;
        if (fds == null) return { ...base, kind: "fds" };
        const status = fds.status;
        return {
          ...base,
          kind: "fds",
          active: status.gain > 0 && status.pitch > 0,
          level: status.gain / 32,
          // Sixty-four wavetable steps, each taking 4096 of the channel's own
          // ticks at a sixteenth of the CPU clock.
          note: this.noteFromFrequency((this.cpuClock * status.pitch) / (16 * 262144)),
          period: status.pitch,
          detail: status.modPitch,
          keyOnCount: fds.keyOnCount,
        };
      }
      default: {
        if (index >= CH_N163 && index < CH_N163 + N163_CHANNELS) {
          const ch = index - CH_N163;
          const n163 = bus?.n163;
          if (n163 == null) return { ...base, kind: "n163" };
          const { freq, length, offset, volume } = n163.channel(ch);
          // Each visit adds the frequency to a phase whose top byte walks the
          // wavetable, and a channel is visited once every 15 cycles per
          // enabled channel.
          const hz = (this.cpuClock * freq) / (15 * 65536 * length * n163.channelCount);
          return {
            ...base,
            kind: "n163",
            active: n163.isEnabled(ch) && volume > 0 && freq > 0,
            level: volume / 15,
            note: this.noteFromFrequency(hz),
            period: freq,
            detail: offset,
            keyOnCount: n163.keyOnCount[ch],
          };
        }
        const ch = index - CH_VRC7;
        const vrc7 = bus?.vrc7;
        if (ch < 0 || ch >= VRC7_CHANNELS) return base;
        if (vrc7 == null) return { ...base, kind: "vrc7" };
        const { fnum, block, key, volume, patch } = vrc7.channel(ch);
        return {
          ...base,
          kind: "vrc7",
          active: key && fnum > 0,
          // The volume register is an attenuation in 3 dB steps.
          level: (15 - volume) / 15,
          // One sample per 72 clocks of a crystal at twice the NTSC CPU clock,
          // and a 19-bit phase accumulator advanced by F-number << block.
          note: this.noteFromFrequency(
            (((2 * NTSC_CPU_CLOCK) / 72) * fnum * Math.pow(2, block)) / (1 << 19)
          ),
          period: (block << 9) | fnum,
          detail: patch,
          keyOnCount: vrc7.keyOnCount[ch],
        };
      }
    }
  }

  getChannelStatusArray(): ChannelStatus[] {
    const out: ChannelStatus[] = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) out.push(this.getChannelStatus(i));
    return out;
  }

  // -------------------------------------------------------------------- state

  /**
   * Snapshot for instant seeking. Small compared with the SPC equivalent - two
   * kilobytes of RAM plus whatever pages the driver can write - so keyframes can
   * be placed generously.
   */
  saveState(): NSFPlayerState {
    const bus = this.bus!;
    return {
      cpu: this.cpu!.saveState(),
      apu: snapshot(bus.apu),
      fds: bus.fds != null ? snapshot(bus.fds) : null,
      vrc6: bus.vrc6 != null ? snapshot(bus.vrc6) : null,
      vrc7: bus.vrc7 != null ? snapshot(bus.vrc7) : null,
      n163: bus.n163 != null ? snapshot(bus.n163) : null,
      ram: bus.ram.slice(),
      banks: bus.writableBanks().map((bank) => ({ bank, data: bus.bankData(bank).slice() })),
      bankMap: bus.bankMap.slice(),
      cpuIdle: this.cpuIdle,
      cyclesToPlay: this.cyclesToPlay,
      outputSample: this.outputSample,
      cpuCycle: this.cpuCycle,
      resampler: snapshot(this.resampler),
      cic: snapshot(this.cic),
      halfBand: snapshot(this.halfBand),
      filter: snapshot(this.filter),
      channelHp: this.channelHp.slice(),
    };
  }

  restoreState(state: NSFPlayerState): void {
    const bus = this.bus!;
    this.cpu!.loadState(state.cpu);
    restore(bus.apu, state.apu);
    if (bus.fds != null && state.fds != null) restore(bus.fds, state.fds);
    if (bus.vrc6 != null && state.vrc6 != null) restore(bus.vrc6, state.vrc6);
    if (bus.vrc7 != null && state.vrc7 != null) restore(bus.vrc7, state.vrc7);
    if (bus.n163 != null && state.n163 != null) restore(bus.n163, state.n163);
    bus.ram.set(state.ram);
    for (const { bank, data } of state.banks) bus.bankData(bank).set(data);
    bus.bankMap.set(state.bankMap);
    this.cpuIdle = state.cpuIdle;
    this.cyclesToPlay = state.cyclesToPlay;
    this.outputSample = state.outputSample;
    this.cpuCycle = state.cpuCycle;
    restore(this.resampler, state.resampler);
    restore(this.cic, state.cic);
    restore(this.halfBand, state.halfBand);
    restore(this.filter, state.filter);
    this.channelHp.set(state.channelHp);
    this.pendingCount = 0;
    this.pendingRead = 0;
    this.chAccReset();
    this.refreshMix(true);
  }
}
