/**
 * Konami VRC6 expansion audio: two pulses and a sawtooth.
 *
 * The pulses are the interesting ones - eight duty settings against the 2A03's
 * four, and a mode bit that turns a channel into a bare DAC, which is how a
 * cartridge gets speech out of it. The sawtooth is a running
 * accumulator rather than a wavetable, so its "volume" and its timbre are the
 * same register: a low rate gives a quiet, coarse ramp.
 *
 * Written from the register descriptions on the NESdev wiki. Timing is exact to
 * the CPU cycle, and each channel reports when it will next change so the
 * player can skip the cycles in between.
 */

/** Sum of the three channels at full scale: two 4-bit pulses and a 5-bit saw. */
const DAC_MAX = 15 + 15 + 31;

/**
 * The cartridge's six-bit DAC: a plain sum, unlike the 2A03's two compressing
 * nodes. Result is 0..1.
 */
export function mixVRC6(pulse1: number, pulse2: number, saw: number): number {
  return (pulse1 + pulse2 + saw) / DAC_MAX;
}

class VRC6Pulse {
  enabled = false;
  /** 1: ignore the duty generator and output the volume constantly. */
  mode = false;
  duty = 0;
  volume = 0;
  /** 12-bit period, before the frequency-control shift. */
  period = 0;
  timer = 0;
  /** Duty generator, counting down from 15. */
  step = 15;
  output = 0;
  keyOnCount = 0;

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.mode = (v & 0x80) !== 0;
        this.duty = (v >> 4) & 7;
        this.volume = v & 0x0f;
        break;
      case 1:
        this.period = (this.period & 0xf00) | v;
        break;
      case 2: {
        this.period = (this.period & 0xff) | ((v & 0x0f) << 8);
        const on = (v & 0x80) !== 0;
        if (on && !this.enabled) this.keyOnCount++;
        this.enabled = on;
        if (!on) {
          // Disabled, the output is forced low and the duty generator is reset
          // and held; it starts again from the top when the channel returns.
          this.step = 15;
          this.timer = 0;
        }
        break;
      }
    }
    this.updateOutput();
  }

  private updateOutput(): void {
    if (!this.enabled) {
      this.output = 0;
      return;
    }
    this.output = this.mode || this.step <= this.duty ? this.volume : 0;
  }

  /** Reload value for the divider under the current frequency shift. */
  private divider(shift: number): number {
    return this.period >> shift;
  }

  /** CPU cycles until the output could change, or Infinity while it cannot. */
  eventIn(halted: boolean): number {
    // Held, silent, or driven as a plain DAC: nothing the generator does shows.
    if (halted || !this.enabled || this.mode || this.volume === 0) return Infinity;
    return this.timer + 1;
  }

  advance(cycles: number, shift: number, halted: boolean): void {
    if (halted || !this.enabled) return;
    if (cycles <= this.timer) {
      this.timer -= cycles;
      return;
    }
    const period = this.divider(shift) + 1;
    let left = cycles - (this.timer + 1);
    const steps = 1 + Math.floor(left / period);
    left %= period;
    this.timer = period - 1 - left;
    // Sixteen steps, counting down; the output is the volume for the first
    // D + 1 of them.
    this.step = (this.step - (steps % 16) + 16) % 16;
    this.updateOutput();
  }
}

class VRC6Saw {
  enabled = false;
  /** Six-bit accumulator rate: both the pitch's partner and the volume. */
  rate = 0;
  period = 0;
  timer = 0;
  /** Fourteen clocks per cycle; the accumulator reacts on every second one. */
  step = 0;
  /** Eight-bit accumulator, of which the top five are the output. */
  acc = 0;
  output = 0;
  keyOnCount = 0;

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.rate = v & 0x3f;
        break;
      case 1:
        this.period = (this.period & 0xf00) | v;
        break;
      case 2: {
        this.period = (this.period & 0xff) | ((v & 0x0f) << 8);
        const on = (v & 0x80) !== 0;
        if (on && !this.enabled) this.keyOnCount++;
        this.enabled = on;
        if (!on) {
          this.acc = 0;
          this.step = 0;
          this.timer = 0;
        }
        break;
      }
    }
    this.updateOutput();
  }

  private updateOutput(): void {
    this.output = this.enabled ? (this.acc >> 3) & 0x1f : 0;
  }

  eventIn(halted: boolean): number {
    if (halted || !this.enabled || this.rate === 0) return Infinity;
    return this.timer + 1;
  }

  advance(cycles: number, shift: number, halted: boolean): void {
    if (halted || !this.enabled) return;
    if (cycles <= this.timer) {
      this.timer -= cycles;
      return;
    }
    const period = (this.period >> shift) + 1;
    let left = cycles - (this.timer + 1);
    let clocks = 1 + Math.floor(left / period);
    left %= period;
    this.timer = period - 1 - left;

    while (clocks-- > 0) {
      // Every second clock the rate is added; the seventh such addition is
      // replaced by a reset, which is what makes the ramp a ramp.
      if ((this.step & 1) === 0) {
        if (this.step === 12) this.acc = 0;
        else this.acc = (this.acc + this.rate) & 0xff;
      }
      this.step = this.step === 13 ? 0 : this.step + 1;
    }
    this.updateOutput();
  }
}

export class VRC6 {
  readonly pulse1 = new VRC6Pulse();
  readonly pulse2 = new VRC6Pulse();
  readonly saw = new VRC6Saw();

  /** $9003: halt, and the two frequency multipliers. */
  private halted = false;
  private shift = 0;

  /**
   * Register writes. Addresses are the $9000/$A000/$B000 blocks; an NSF always
   * uses this ordering, whichever of the two mapper variants the cartridge had
   * (a ripper swapping $xxx1 and $xxx2 is expected to have done so already).
   */
  write(addr: number, v: number): void {
    const reg = addr & 3;
    switch (addr & 0xf000) {
      case 0x9000:
        if (reg === 3) {
          this.halted = (v & 1) !== 0;
          // 16x is a four-bit shift of the period, 256x an eight-bit one.
          this.shift = v & 4 ? 8 : v & 2 ? 4 : 0;
        } else {
          this.pulse1.write(reg, v);
        }
        break;
      case 0xa000:
        if (reg < 3) this.pulse2.write(reg, v);
        break;
      case 0xb000:
        if (reg < 3) this.saw.write(reg, v);
        break;
    }
  }

  /** CPU cycles until any of the three channels could change its output. */
  cyclesToEvent(): number {
    let n = this.pulse1.eventIn(this.halted);
    const p2 = this.pulse2.eventIn(this.halted);
    if (p2 < n) n = p2;
    const saw = this.saw.eventIn(this.halted);
    if (saw < n) n = saw;
    return n;
  }

  advance(cycles: number): void {
    this.pulse1.advance(cycles, this.shift, this.halted);
    this.pulse2.advance(cycles, this.shift, this.halted);
    this.saw.advance(cycles, this.shift, this.halted);
  }

  /** Sum of the three channels, 0..1, as the cartridge's DAC presents it. */
  get output(): number {
    return (this.pulse1.output + this.pulse2.output + this.saw.output) / DAC_MAX;
  }

  /** Period actually in use, for working out what note a channel is playing. */
  effectivePeriod(period: number): number {
    return period >> this.shift;
  }

  get isHalted(): boolean {
    return this.halted;
  }
}
