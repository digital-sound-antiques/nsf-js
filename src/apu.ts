/**
 * The 2A03 sound unit: two pulses, a triangle, a noise generator and the DMC.
 *
 * Timing is in CPU cycles, and every cycle position is exact - the triangle
 * running into ultrasound, a sweep muting its channel mid-note, the noise LFSR
 * shifting every four cycles in short mode, the DMA the DMC steals from the CPU.
 * What this does *not* do is visit every cycle: better than 99% of them change
 * nothing that can be heard, so each part reports how far away its next change
 * is ({@link APU.cyclesToEvent}) and the whole unit is then advanced to exactly
 * that point ({@link APU.advance}). Landing on the same cycles as a per-cycle
 * loop, in the same order, the result is identical sample for sample.
 *
 * Register writes are taken verbatim from $4000-$4017 so a driver's own timing
 * is preserved; the player never interprets them.
 */

/** CPU clock, NTSC. Also the rate at which this unit is clocked. */
export const NTSC_CPU_CLOCK = 236250000 / 11 / 12;
/** CPU clock, PAL. */
export const PAL_CPU_CLOCK = 26601712.5 / 16;

/** Length counter values indexed by the five bits of a $4003-style write. */
const LENGTH_TABLE = new Uint8Array([
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192,
  24, 72, 26, 16, 28, 32, 30,
]);

/** The four duty cycles, as the eight-step sequence each one walks. */
const DUTY_TABLE = [
  new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]), // 12.5%
  new Uint8Array([0, 1, 1, 0, 0, 0, 0, 0]), // 25%
  new Uint8Array([0, 1, 1, 1, 1, 0, 0, 0]), // 50%
  new Uint8Array([1, 0, 0, 1, 1, 1, 1, 1]), // 25% inverted
];

/** Triangle's 32-step ramp: down from 15 to 0, then back up. */
const TRIANGLE_TABLE = new Uint8Array([
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15,
]);

/** Noise timer periods in CPU cycles, NTSC. */
const NOISE_PERIODS_NTSC = new Uint16Array([
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
]);
/** Noise timer periods in CPU cycles, PAL. */
const NOISE_PERIODS_PAL = new Uint16Array([
  4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778,
]);

/** DMC timer periods in CPU cycles, NTSC. */
const DMC_PERIODS_NTSC = new Uint16Array([
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
]);
/** DMC timer periods in CPU cycles, PAL. */
const DMC_PERIODS_PAL = new Uint16Array([
  398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50,
]);

/**
 * Frame counter cycles at which something happens, in each of its two modes.
 * The four-step sequence raises its interrupt across three consecutive cycles,
 * which is why the last three sit together.
 */
const FOUR_STEP_BOUNDS = [7457, 14913, 22371, 29828, 29829, 29830];
const FIVE_STEP_BOUNDS = [7457, 14913, 22371, 37281, 37282];

/** An envelope generator, as the pulses and the noise channel each have one. */
class Envelope {
  loop = false;
  constant = false;
  period = 0;
  private start = false;
  private divider = 0;
  private decay = 0;

  write(v: number): void {
    this.loop = (v & 0x20) !== 0;
    this.constant = (v & 0x10) !== 0;
    this.period = v & 0x0f;
  }

  restart(): void {
    this.start = true;
  }

  /** Clocked on every quarter frame. */
  clock(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.period;
      return;
    }
    if (this.divider > 0) {
      this.divider--;
      return;
    }
    this.divider = this.period;
    if (this.decay > 0) this.decay--;
    else if (this.loop) this.decay = 15;
  }

  get volume(): number {
    return this.constant ? this.period : this.decay;
  }
}

class Pulse {
  /** True for the first pulse, whose sweep subtracts one extra. */
  private readonly isFirst: boolean;

  enabled = false;
  duty = 0;
  step = 0;
  timer = 0;
  period = 0;
  length = 0;
  halt = false;
  env = new Envelope();

  sweepEnabled = false;
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepDivider = 0;
  sweepReload = false;

  /** Current 0-15 level. */
  output = 0;
  /** Retriggers since load: a write to the length/timer-high register. */
  keyOnCount = 0;

  constructor(isFirst: boolean) {
    this.isFirst = isFirst;
  }

  write(reg: number, v: number): void {
    switch (reg & 3) {
      case 0:
        this.duty = v >> 6;
        this.halt = (v & 0x20) !== 0;
        this.env.write(v);
        break;
      case 1:
        this.sweepEnabled = (v & 0x80) !== 0;
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepNegate = (v & 0x08) !== 0;
        this.sweepShift = v & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        // A write here restarts the waveform and the envelope, which is how a
        // driver retriggers a note.
        this.step = 0;
        this.env.restart();
        this.keyOnCount++;
        break;
    }
    this.updateOutput();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
    this.updateOutput();
  }

  /** Period the sweep unit would move to, whether or not it is enabled. */
  private sweepTarget(): number {
    const delta = this.period >> this.sweepShift;
    if (this.sweepNegate) {
      // The first pulse's adder is one's-complement, so it lands one lower.
      return this.period - delta - (this.isFirst ? 1 : 0);
    }
    return this.period + delta;
  }

  private muted(): boolean {
    if (this.period < 8) return true;
    return this.sweepTarget() > 0x7ff;
  }

  private updateOutput(): void {
    this.output =
      this.length > 0 && !this.muted() && DUTY_TABLE[this.duty][this.step] !== 0
        ? this.env.volume
        : 0;
  }

  /**
   * APU cycles until the sequencer could change the output, or Infinity while
   * the channel is silent - a muted or length-expired pulse outputs zero
   * whatever step it is on, so its steps need not be visited one at a time.
   */
  eventIn(): number {
    if (this.length === 0 || this.muted()) return Infinity;
    return this.timer + 1;
  }

  /** Advance by `apuCycles` APU cycles, i.e. every second CPU cycle. */
  advance(apuCycles: number): void {
    if (apuCycles <= this.timer) {
      this.timer -= apuCycles;
      return;
    }
    // Consume the cycles up to the first expiry, then take whole periods.
    let left = apuCycles - (this.timer + 1);
    const period = this.period + 1;
    const steps = 1 + Math.floor(left / period);
    left %= period;
    this.timer = this.period - left;
    this.step = (this.step + steps) & 7;
    this.updateOutput();
  }

  clockQuarter(): void {
    this.env.clock();
    this.updateOutput();
  }

  clockHalf(): void {
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0 && !this.muted()) {
      const t = this.sweepTarget();
      if (t >= 0 && t <= 0x7ff) this.period = t;
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
    if (!this.halt && this.length > 0) this.length--;
    this.updateOutput();
  }
}

class Triangle {
  enabled = false;
  timer = 0;
  period = 0;
  step = 0;
  length = 0;
  halt = false;
  linearCounter = 0;
  linearReload = 0;
  linearReloadFlag = false;

  output = 0;
  keyOnCount = 0;

  write(reg: number, v: number): void {
    switch (reg & 3) {
      case 0:
        this.halt = (v & 0x80) !== 0;
        this.linearReload = v & 0x7f;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.linearReloadFlag = true;
        this.keyOnCount++;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  /** CPU cycles until the sequencer could change the output, or Infinity while
   *  it is held - see {@link advance}. */
  eventIn(): number {
    if (this.length === 0 || this.linearCounter === 0) return Infinity;
    return this.timer + 1;
  }

  /** Advance by `cycles` CPU cycles - the triangle runs at twice the pulses'
   *  rate. */
  advance(cycles: number): void {
    if (cycles <= this.timer) {
      this.timer -= cycles;
      return;
    }
    let left = cycles - (this.timer + 1);
    const period = this.period + 1;
    const steps = 1 + Math.floor(left / period);
    left %= period;
    this.timer = this.period - left;
    // Silenced, the sequencer simply stops: the DAC holds the step it reached,
    // which is why a muted triangle leaves a DC offset rather than a click.
    if (this.length > 0 && this.linearCounter > 0) {
      this.step = (this.step + steps) & 31;
      this.output = TRIANGLE_TABLE[this.step];
    }
  }

  clockQuarter(): void {
    if (this.linearReloadFlag) this.linearCounter = this.linearReload;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.halt) this.linearReloadFlag = false;
  }

  clockHalf(): void {
    if (!this.halt && this.length > 0) this.length--;
  }
}

class Noise {
  enabled = false;
  timer = 0;
  periodIndex = 0;
  shortMode = false;
  /** 15-bit shift register; the hardware powers up holding one. */
  lfsr = 1;
  length = 0;
  halt = false;
  env = new Envelope();
  keyOnCount = 0;
  /** Constant table, and the host reference below: both kept out of the state
   *  snapshot by being genuinely private fields. */
  readonly #periods: Uint16Array;

  output = 0;

  constructor(pal: boolean) {
    this.#periods = pal ? NOISE_PERIODS_PAL : NOISE_PERIODS_NTSC;
  }

  write(reg: number, v: number): void {
    switch (reg & 3) {
      case 0:
        this.halt = (v & 0x20) !== 0;
        this.env.write(v);
        break;
      case 2:
        this.shortMode = (v & 0x80) !== 0;
        this.periodIndex = v & 0x0f;
        break;
      case 3:
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.env.restart();
        this.keyOnCount++;
        break;
    }
    this.updateOutput();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
    this.updateOutput();
  }

  private updateOutput(): void {
    this.output = this.length > 0 && (this.lfsr & 1) === 0 ? this.env.volume : 0;
  }

  /**
   * APU cycles until the next shift.
   *
   * Never Infinity, even when the channel is silent: the shift register keeps
   * running on the hardware, and where it has got to decides what the next note
   * sounds like. In short mode at the fastest period that is a shift every two
   * APU cycles, and it is walked every one of them - the sequence is only 93
   * steps long, so skipping any of it would be audible as a different timbre.
   */
  eventIn(): number {
    return this.timer + 1;
  }

  /** Advance by `apuCycles` APU cycles. The periods are in CPU cycles, so they
   *  are halved here. */
  advance(apuCycles: number): void {
    if (apuCycles <= this.timer) {
      this.timer -= apuCycles;
      return;
    }
    const period = (this.#periods[this.periodIndex] >> 1) + 1;
    let left = apuCycles - (this.timer + 1);
    let shifts = 1 + Math.floor(left / period);
    left %= period;
    this.timer = period - 1 - left;
    while (shifts-- > 0) {
      // Short mode taps bit 6 instead of bit 1, which shortens the sequence from
      // 32767 steps to 93 and turns the hiss into a pitched buzz.
      const feedback = (this.lfsr ^ (this.shortMode ? this.lfsr >> 6 : this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (feedback << 14);
    }
    this.updateOutput();
  }

  clockQuarter(): void {
    this.env.clock();
    this.updateOutput();
  }

  clockHalf(): void {
    if (!this.halt && this.length > 0) this.length--;
    this.updateOutput();
  }
}

/** What the DMC needs from the outside world: sample bytes, and cycles to
 *  steal from the CPU while it fetches them. */
export interface DMCHost {
  dmcRead(addr: number): number;
  dmcStall(cycles: number): void;
}

class DMC {
  enabled = false;
  irqEnabled = false;
  loop = false;
  rateIndex = 0;
  timer = 0;

  /** Start address and length, as the registers hold them. */
  sampleAddress = 0xc000;
  sampleLength = 1;

  currentAddress = 0xc000;
  bytesRemaining = 0;

  /** One byte of look-ahead between the memory reader and the output unit. */
  buffer = 0;
  bufferFilled = false;

  shift = 0;
  bitsRemaining = 8;
  silence = true;

  /** Seven-bit DAC level. */
  output = 0;

  irqFlag = false;
  keyOnCount = 0;

  readonly #host: DMCHost;
  readonly #periods: Uint16Array;

  constructor(host: DMCHost, pal: boolean) {
    this.#host = host;
    this.#periods = pal ? DMC_PERIODS_PAL : DMC_PERIODS_NTSC;
    this.timer = this.#periods[0];
  }

  write(reg: number, v: number): void {
    switch (reg & 3) {
      case 0:
        this.irqEnabled = (v & 0x80) !== 0;
        this.loop = (v & 0x40) !== 0;
        this.rateIndex = v & 0x0f;
        if (!this.irqEnabled) this.irqFlag = false;
        break;
      case 1:
        // A direct write to the DAC. Drivers use this both for PCM playback by
        // brute force and to park the level where a sample will start.
        this.output = v & 0x7f;
        break;
      case 2:
        this.sampleAddress = 0xc000 + v * 64;
        break;
      case 3:
        this.sampleLength = v * 16 + 1;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.bytesRemaining = 0;
    } else if (this.bytesRemaining === 0) {
      this.restart();
      this.keyOnCount++;
    }
    this.irqFlag = false;
  }

  private restart(): void {
    this.currentAddress = this.sampleAddress;
    this.bytesRemaining = this.sampleLength;
  }

  /** Fetch the next sample byte, stealing CPU cycles as the DMA unit does. */
  private fillBuffer(): void {
    if (this.bufferFilled || this.bytesRemaining === 0) return;
    this.buffer = this.#host.dmcRead(this.currentAddress);
    this.bufferFilled = true;
    this.#host.dmcStall(4);
    this.currentAddress = this.currentAddress === 0xffff ? 0x8000 : this.currentAddress + 1;
    this.bytesRemaining--;
    if (this.bytesRemaining === 0) {
      if (this.loop) this.restart();
      else if (this.irqEnabled) this.irqFlag = true;
    }
  }

  /**
   * CPU cycles until the DAC level could move.
   *
   * A fetch that has come due reports one cycle, which is where the per-cycle
   * reader would have taken it. When the output unit has fallen silent with
   * nothing left to fetch, the level cannot move at all until a register write
   * changes that, so this reports Infinity and long idle stretches cost nothing.
   */
  eventIn(): number {
    if (!this.bufferFilled && this.bytesRemaining > 0) return 1;
    if (this.silence && !this.bufferFilled) return Infinity;
    return this.timer + 1;
  }

  /** Advance by `cycles` CPU cycles. */
  advance(cycles: number): void {
    this.fillBuffer();
    while (cycles > 0) {
      if (cycles <= this.timer) {
        this.timer -= cycles;
        return;
      }
      cycles -= this.timer + 1;
      this.timer = this.#periods[this.rateIndex];
      this.stepOutput();
      // Only reached when the span runs past an output step, which happens only
      // while the channel is silent - the scheduler stops at the step otherwise.
      if (cycles > 0) this.fillBuffer();
    }
  }

  private stepOutput(): void {
    if (!this.silence) {
      // Each bit nudges the level by two, and the level saturates rather than
      // wrapping - the reason a badly aimed sample sticks at an offset.
      if (this.shift & 1) {
        if (this.output <= 125) this.output += 2;
      } else if (this.output >= 2) {
        this.output -= 2;
      }
      this.shift >>= 1;
    }


    this.bitsRemaining--;
    if (this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.bufferFilled) {
        this.shift = this.buffer;
        this.bufferFilled = false;
        this.silence = false;
      } else {
        this.silence = true;
      }
    }
  }
}

export class APU {
  readonly pulse1: Pulse;
  readonly pulse2: Pulse;
  readonly triangle: Triangle;
  readonly noise: Noise;
  readonly dmc: DMC;

  /** Frame counter: cycles since the sequence was last reset. */
  private frameCycle = 0;
  private fiveStep = false;
  private irqInhibit = false;
  frameIrqFlag = false;

  /** A $4017 write takes effect a few cycles later; this counts that down. */
  private frameResetDelay = 0;

  /** True when the CPU cycle now being clocked is an APU cycle. */
  private evenCycle = false;

  constructor(host: DMCHost, pal = false) {
    this.pulse1 = new Pulse(true);
    this.pulse2 = new Pulse(false);
    this.triangle = new Triangle();
    this.noise = new Noise(pal);
    this.dmc = new DMC(host, pal);
  }

  /** True while either the frame counter or the DMC is asking for an IRQ. */
  get irqAsserted(): boolean {
    return this.frameIrqFlag || this.dmc.irqFlag;
  }

  write(addr: number, v: number): void {
    switch (addr & 0x1f) {
      case 0x00: case 0x01: case 0x02: case 0x03:
        this.pulse1.write(addr, v);
        break;
      case 0x04: case 0x05: case 0x06: case 0x07:
        this.pulse2.write(addr, v);
        break;
      case 0x08: case 0x09: case 0x0a: case 0x0b:
        this.triangle.write(addr, v);
        break;
      case 0x0c: case 0x0d: case 0x0e: case 0x0f:
        this.noise.write(addr, v);
        break;
      case 0x10: case 0x11: case 0x12: case 0x13:
        this.dmc.write(addr, v);
        break;
      case 0x15:
        this.pulse1.setEnabled((v & 0x01) !== 0);
        this.pulse2.setEnabled((v & 0x02) !== 0);
        this.triangle.setEnabled((v & 0x04) !== 0);
        this.noise.setEnabled((v & 0x08) !== 0);
        this.dmc.setEnabled((v & 0x10) !== 0);
        break;
      case 0x17:
        this.fiveStep = (v & 0x80) !== 0;
        this.irqInhibit = (v & 0x40) !== 0;
        if (this.irqInhibit) this.frameIrqFlag = false;
        // The reset lands three or four cycles later depending on where in the
        // APU's own divider the write happened.
        this.frameResetDelay = this.evenCycle ? 3 : 4;
        break;
    }
  }

  read(addr: number): number {
    if ((addr & 0x1f) === 0x15) {
      let v = 0;
      if (this.pulse1.length > 0) v |= 0x01;
      if (this.pulse2.length > 0) v |= 0x02;
      if (this.triangle.length > 0) v |= 0x04;
      if (this.noise.length > 0) v |= 0x08;
      if (this.dmc.bytesRemaining > 0) v |= 0x10;
      if (this.frameIrqFlag) v |= 0x40;
      if (this.dmc.irqFlag) v |= 0x80;
      // Reading acknowledges the frame IRQ but not the DMC's.
      this.frameIrqFlag = false;
      return v;
    }
    return 0;
  }

  private clockQuarter(): void {
    this.pulse1.clockQuarter();
    this.pulse2.clockQuarter();
    this.triangle.clockQuarter();
    this.noise.clockQuarter();
  }

  private clockHalf(): void {
    this.pulse1.clockHalf();
    this.pulse2.clockHalf();
    this.triangle.clockHalf();
    this.noise.clockHalf();
  }

  /**
   * One cycle of the frame counter, used only inside the few cycles a $4017
   * write takes to land.
   */
  private clockFrameCounterOnce(): void {
    if (this.frameResetDelay > 0 && --this.frameResetDelay === 0) {
      this.frameCycle = 0;
      // Switching to the five-step sequence clocks everything immediately.
      if (this.fiveStep) {
        this.clockQuarter();
        this.clockHalf();
      }
      return;
    }
    this.frameCycle++;
    this.fireFrameBoundary();
  }

  /** Whatever the sequence does at the cycle it has just reached. */
  private fireFrameBoundary(): void {
    if (this.fiveStep) {
      switch (this.frameCycle) {
        case 7457: case 22371:
          this.clockQuarter();
          break;
        case 14913:
          this.clockQuarter();
          this.clockHalf();
          break;
        case 37281:
          this.clockQuarter();
          this.clockHalf();
          break;
        case 37282:
          this.frameCycle = 0;
          break;
      }
    } else {
      switch (this.frameCycle) {
        case 7457: case 22371:
          this.clockQuarter();
          break;
        case 14913:
          this.clockQuarter();
          this.clockHalf();
          break;
        case 29828:
          if (!this.irqInhibit) this.frameIrqFlag = true;
          break;
        case 29829:
          this.clockQuarter();
          this.clockHalf();
          if (!this.irqInhibit) this.frameIrqFlag = true;
          break;
        case 29830:
          if (!this.irqInhibit) this.frameIrqFlag = true;
          this.frameCycle = 0;
          break;
      }
    }
  }

  /** CPU cycles until the frame counter next does something. */
  private frameCounterEventIn(): number {
    if (this.frameResetDelay > 0) return this.frameResetDelay;
    const bounds = this.fiveStep ? FIVE_STEP_BOUNDS : FOUR_STEP_BOUNDS;
    for (let i = 0; i < bounds.length; i++) {
      if (bounds[i] > this.frameCycle) return bounds[i] - this.frameCycle;
    }
    // Past the end of the sequence, which only a mode change mid-frame can do.
    return 1;
  }

  private advanceFrameCounter(cycles: number): void {
    while (cycles > 0) {
      if (this.frameResetDelay > 0) {
        const step = Math.min(cycles, this.frameResetDelay);
        for (let i = 0; i < step; i++) this.clockFrameCounterOnce();
        cycles -= step;
        continue;
      }
      const next = this.frameCounterEventIn();
      const step = Math.min(cycles, next);
      this.frameCycle += step;
      cycles -= step;
      if (step === next) this.fireFrameBoundary();
    }
  }

  /**
   * CPU cycles until any part of the unit could change its output.
   *
   * Infinity is possible - a track resting with every channel silent - so a
   * caller must bound the answer by whatever else it has to do.
   */
  cyclesToEvent(): number {
    // The pulses and the noise see every second CPU cycle; the first of those is
    // one or two cycles away depending on where the divider stands.
    const apu = Math.min(this.pulse1.eventIn(), this.pulse2.eventIn(), this.noise.eventIn());
    const firstApu = this.evenCycle ? 2 : 1;
    let n = apu === Infinity ? Infinity : firstApu + (apu - 1) * 2;
    const tri = this.triangle.eventIn();
    if (tri < n) n = tri;
    const dmc = this.dmc.eventIn();
    if (dmc < n) n = dmc;
    const frame = this.frameCounterEventIn();
    if (frame < n) n = frame;
    return n;
  }

  /**
   * Advance `cycles` CPU cycles.
   *
   * The parts are advanced in the same order a per-cycle loop would visit them,
   * so anything landing on the final cycle of the span - and by construction
   * nothing lands inside it - happens in the same order too.
   */
  advance(cycles: number): void {
    const apuClocks = (cycles + (this.evenCycle ? 0 : 1)) >> 1;
    if (apuClocks > 0) {
      this.pulse1.advance(apuClocks);
      this.pulse2.advance(apuClocks);
      this.noise.advance(apuClocks);
    }
    this.triangle.advance(cycles);
    this.dmc.advance(cycles);
    this.advanceFrameCounter(cycles);
    if (cycles & 1) this.evenCycle = !this.evenCycle;
  }
}

/**
 * The pulses' summing node, tabulated over the 31 sums the pair can produce.
 * Exact, not an approximation - the table simply enumerates the formula.
 */
const PULSE_MIX = (() => {
  const t = new Float64Array(31);
  for (let p = 1; p < 31; p++) t[p] = 95.88 / (8128 / p + 100);
  return t;
})();

/**
 * The DAC's two mixing nodes, as measured on hardware: the pulses share one and
 * the triangle, noise and DMC share the other, each node compressing as its
 * inputs rise. Result is roughly 0..1.
 *
 * The second node's formula is rearranged to avoid the reciprocal - this runs
 * once per CPU cycle, so a division saved is 1.8 million divisions a second.
 */
export function mixAPU(p1: number, p2: number, tri: number, noise: number, dmc: number): number {
  const tnd = tri / 8227 + noise / 12241 + dmc / 22638;
  return PULSE_MIX[p1 + p2] + (159.79 * tnd) / (1 + 100 * tnd);
}
