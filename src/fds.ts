/**
 * The FDS wavetable channel ($4040-$4092).
 *
 * A 64-step, 6-bit wavetable read by a phase accumulator, with a second
 * accumulator walking a 32-entry table that bends the first one's pitch. Both
 * accumulators advance once every 16 CPU cycles, which is why the channel tops
 * out around 1.7 kHz and why FDS music leans on the wavetable for its brightness
 * rather than on high fundamentals.
 *
 * Implemented from the register and algorithm descriptions on the NESdev wiki,
 * including its modulator pseudo-code - the rounding step in the middle of that
 * calculation is what gives FDS vibrato its particular character, so it is
 * reproduced exactly rather than approximated.
 */

/** Master volume divisors selected by $4089 bits 1-0: full, 2/3, 2/4, 2/5. */
const MASTER_VOLUME = [1, 2 / 3, 2 / 4, 2 / 5];

/** Mod counter adjustment for each 3-bit mod table entry. 4 means "reset". */
const MOD_ADJUST = [0, 1, 2, 4, 0, -4, -2, -1];

/** Peak of `output`, before the mixer scales the channel into the APU's world. */
const OUTPUT_SCALE = 1 / (63 * 32);

/** One of the channel's two envelope generators. */
class FDSEnvelope {
  /** True when the envelope runs; false when the gain is written directly. */
  enabled = false;
  /** 1 counts up, 0 counts down. */
  up = false;
  speed = 0;
  gain = 0;
  timer = 0;

  write(v: number): void {
    this.enabled = (v & 0x80) === 0;
    this.up = (v & 0x40) !== 0;
    this.speed = v & 0x3f;
    if (!this.enabled) this.gain = this.speed;
    this.timer = 0;
  }

  reset(): void {
    this.timer = 0;
  }

  /**
   * Advance by `cycles` CPU cycles. A tick every 8 * (speed + 1) * (mul + 1)
   * cycles moves the gain one step, and the gain stops at the 32 the DAC can
   * actually use rather than running to the register's full 63.
   */
  clock(cycles: number, mul: number, fast: boolean): void {
    if (!this.enabled || mul === 0) return;
    let period = 8 * (this.speed + 1) * mul;
    if (fast) period >>= 2;
    if (period < 1) period = 1;
    this.timer += cycles;
    while (this.timer >= period) {
      this.timer -= period;
      if (this.up) {
        if (this.gain < 32) this.gain++;
      } else if (this.gain > 0) {
        this.gain--;
      }
    }
  }
}

export class FDS {
  /** 64 six-bit wave samples. */
  readonly wave = new Uint8Array(64);
  /** 32 three-bit modulation entries. */
  readonly modTable = new Uint8Array(32);

  private volEnv = new FDSEnvelope();
  private modEnv = new FDSEnvelope();

  /** $408A - scales both envelope periods; zero stops them. */
  private envMultiplier = 0xe8;

  private pitch = 0;
  private modPitch = 0;

  /** 24-bit wave accumulator; its top six bits index the wavetable. */
  private waveAcc = 0;
  /** 18-bit mod accumulator: fraction, ghost bit, then the table address. */
  private modAcc = 0;
  /** Seven-bit signed modulation counter. */
  private modCounter = 0;

  private waveHalt = false;
  private envHalt = false;
  private envFast = false;
  private modHalt = false;
  private waveWriteEnable = false;
  private masterVolume = 0;

  /** Gain the DAC is using; the volume envelope only reaches it at phase 0. */
  private latchedGain = 0;

  /** Sub-16-cycle remainder, so `clock` can be called with any step. */
  private tickRemainder = 0;

  /** Current output, roughly 0..1. */
  output = 0;

  /**
   * Retriggers since load. The FDS has no key-on of its own, so this counts the
   * two things a driver does to start a note: lifting the waveform halt, and
   * rewriting the volume envelope.
   */
  keyOnCount = 0;

  /** Wavetable phase, 0-63. Useful to a visualiser. */
  get phase(): number {
    return (this.waveAcc >> 18) & 0x3f;
  }

  /** Gain now reaching the DAC, 0-32. */
  get gain(): number {
    return this.latchedGain;
  }

  /** What a visualiser needs: the pitch being played and the gain reaching it. */
  get status(): { pitch: number; modPitch: number; gain: number; halted: boolean } {
    return {
      pitch: this.pitch,
      modPitch: this.modPitch,
      gain: this.latchedGain,
      halted: this.waveHalt,
    };
  }

  read(addr: number): number {
    const a = addr & 0xff;
    if (a >= 0x40 && a <= 0x7f) return this.wave[a - 0x40] | 0x40;
    switch (a) {
      case 0x90:
        return this.volEnv.gain | 0x40;
      case 0x92:
        return this.modEnv.gain | 0x40;
      default:
        return 0xff;
    }
  }

  write(addr: number, v: number): void {
    const a = addr & 0xff;
    if (a >= 0x40 && a <= 0x7f) {
      // The wavetable is only open for writing while the channel is told to
      // hold still, which is why drivers bracket their wave uploads with
      // $4089 writes.
      if (this.waveWriteEnable) this.wave[a - 0x40] = v & 0x3f;
      return;
    }
    switch (a) {
      case 0x80:
        this.volEnv.write(v);
        // With the envelope switched off the register drives the DAC directly,
        // so the level is heard at once. It is the envelope's own stepping that
        // waits for the wavetable pointer to come round to zero - which matters
        // because a driver starts a note by writing the level here and then
        // enabling the envelope to decay from it. Waiting in this case would
        // silence the whole first cycle and then step in at full level.
        if (!this.volEnv.enabled) this.latchedGain = Math.min(32, this.volEnv.gain);
        this.keyOnCount++;
        this.updateOutput();
        break;
      case 0x82:
        this.pitch = (this.pitch & 0xf00) | v;
        break;
      case 0x83:
        this.pitch = (this.pitch & 0xff) | ((v & 0x0f) << 8);
        if (this.waveHalt && (v & 0x80) === 0) this.keyOnCount++;
        this.waveHalt = (v & 0x80) !== 0;
        this.envHalt = (v & 0x40) !== 0;
        // Halting the waveform parks the phase at the start of the table, and
        // also runs the envelopes four times as fast.
        this.envFast = this.waveHalt;
        if (this.waveHalt) this.waveAcc = 0;
        if (this.envHalt) {
          this.volEnv.reset();
          this.modEnv.reset();
        }
        break;
      case 0x84:
        this.modEnv.write(v);
        break;
      case 0x85:
        // Seven-bit signed, and worth writing only while the mod unit is held.
        this.modCounter = (v & 0x40) !== 0 ? (v & 0x7f) - 0x80 : v & 0x3f;
        break;
      case 0x86:
        this.modPitch = (this.modPitch & 0xf00) | v;
        break;
      case 0x87:
        this.modPitch = (this.modPitch & 0xff) | ((v & 0x0f) << 8);
        this.modHalt = (v & 0x80) !== 0;
        // The high bit clears the accumulator below the table address, leaving
        // the position within the mod table where it stood.
        if (this.modHalt) this.modAcc &= 0x3e000;
        break;
      case 0x88:
        if (this.modHalt) {
          const index = (this.modAcc >> 13) & 0x1f;
          this.modTable[index] = v & 7;
          // One write covers a whole entry, which the accumulator spans twice.
          this.modAcc = (this.modAcc + 0x2000) & 0x3ffff;
        }
        break;
      case 0x89:
        this.masterVolume = v & 3;
        this.waveWriteEnable = (v & 0x80) !== 0;
        // Releasing the hold puts the wave back on the DAC at once, rather than
        // waiting for the channel's next tick.
        this.updateOutput();
        break;
      case 0x8a:
        this.envMultiplier = v;
        break;
    }
  }

  /** Fold the mod counter into the pitch, exactly as the hardware does. */
  private modulatedPitch(): number {
    if (this.modCounter === 0) return this.pitch << 6;
    let temp = this.modCounter * this.modEnv.gain;
    // Round up to six bits, but only when the product is positive - the test
    // is on the sign bit of the hardware's twelve-bit intermediate.
    if ((temp & 0x0f) !== 0 && (temp & 0x800) === 0) temp += 0x20;
    temp += 0x400;
    temp = (temp >> 4) & 0xff;
    return (this.pitch * temp) & 0xfffff;
  }

  private stepModulator(): void {
    if (this.modHalt || this.modPitch === 0) return;
    const before = this.modAcc;
    this.modAcc = (this.modAcc + this.modPitch) & 0x3ffff;
    // Every carry out of the fractional part applies one half-entry: the ghost
    // bit is what makes each table entry act twice.
    let steps = ((this.modAcc >> 12) - (before >> 12)) & 0x3f;
    while (steps-- > 0) {
      const entry = this.modTable[(this.modAcc >> 13) & 0x1f];
      if (entry === 4) this.modCounter = 0;
      else this.modCounter += MOD_ADJUST[entry];
      // Seven-bit signed, wrapping.
      this.modCounter = ((this.modCounter + 64) & 0x7f) - 64;
    }
  }

  private stepWave(): void {
    if (this.waveHalt) {
      this.latchedGain = Math.min(32, this.volEnv.gain);
      return;
    }
    const before = this.phase;
    this.waveAcc = (this.waveAcc + this.modulatedPitch()) & 0xffffff;
    // A new gain reaches the DAC while the wavetable pointer sits at zero, so a
    // volume change never cuts a waveform mid-cycle. "While it is zero" rather
    // than "as it wraps": halting the wave parks the pointer at zero, which is
    // how a driver starts a note, and the gain it writes there has to be heard
    // straight away. Waiting for a wrap instead loses the whole first cycle of
    // every note and then steps in at full level - a click on every attack.
    if (before === 0 || this.phase === 0) {
      this.latchedGain = Math.min(32, this.volEnv.gain);
    }
  }

  private updateOutput(): void {
    // While the wavetable is open for writing, the DAC holds the level it had
    // even though the wave unit keeps running. This is what stops a driver's
    // waveform upload from being heard: without it, every note that reloads the
    // table sprays the half-written contents at the speaker.
    if (this.waveWriteEnable) return;
    const level = this.wave[this.phase] * this.latchedGain;
    this.output = level * OUTPUT_SCALE * MASTER_VOLUME[this.masterVolume];
  }

  /**
   * CPU cycles until the output could change.
   *
   * The channel moves on its own tick, one every sixteen CPU cycles, but a tick
   * only changes the output when it carries the accumulator into the next
   * wavetable entry - at a typical pitch, one tick in ten or twenty. Since the
   * step per tick is fixed while the modulator holds still, the crossing can be
   * worked out rather than waited for; the modulator's own next step bounds the
   * estimate, because that is where the step size may change.
   *
   * Held or at zero pitch the channel cannot move at all: with no pitch the
   * wavetable position never wraps, and the DAC only picks up a new gain when it
   * does.
   */
  cyclesToEvent(): number {
    // Held while the wavetable is open for writing: nothing can reach the DAC.
    if (this.waveWriteEnable) return Infinity;
    if (this.waveHalt) {
      // Held: the position is frozen, so only the gain can reach the DAC, and
      // that happens on the tick.
      if (this.envHalt || !this.volEnv.enabled) return Infinity;
      return 16 - this.tickRemainder;
    }

    const step = this.modulatedPitch();
    if (step === 0) return Infinity;

    // The wavetable index sits above the low eighteen bits of the accumulator.
    let ticks = Math.ceil((0x40000 - (this.waveAcc & 0x3ffff)) / step);
    if (!this.modHalt && this.modPitch > 0) {
      // The modulator advances one half-entry per 0x1000 of its accumulator,
      // and a half-entry may change the pitch this estimate assumed.
      const modTicks = Math.ceil((0x1000 - (this.modAcc & 0xfff)) / this.modPitch);
      if (modTicks < ticks) ticks = modTicks;
    }
    if (ticks < 1) ticks = 1;
    return ticks * 16 - this.tickRemainder;
  }

  /** Advance by `cycles` CPU cycles. */
  clock(cycles: number): void {
    if (!this.envHalt) {
      const mul = this.envMultiplier;
      this.volEnv.clock(cycles, mul, this.envFast);
      this.modEnv.clock(cycles, mul, this.envFast);
    }

    this.tickRemainder += cycles;
    while (this.tickRemainder >= 16) {
      this.tickRemainder -= 16;
      this.stepModulator();
      this.stepWave();
    }
    this.updateOutput();
  }
}
