/**
 * Sunsoft 5B expansion audio: three square channels with a shared noise
 * generator and envelope - a YM2149F with its SEL pin held low, run from the
 * CPU clock.
 *
 * A TypeScript port of emu2149 (MIT, same author). With the clock divider on,
 * emu2149's internal step is 16 CPU cycles, which is exactly the 5B's: tone and
 * noise at clock / (32 * period), the envelope stepping at clock / (16 * period),
 * the 17-bit noise LFSR tapped at bits 16 and 13, and the YM2149's 32-level
 * envelope with 1.5 dB steps. The step arithmetic follows the C source, so the
 * outputs match it step for step. Left out is emu2149's muting of tones above
 * the host's Nyquist rate: the real chip has no such thing, and the player's
 * band-limiting takes care of what it was there for.
 *
 * Not modelled: the amplifier on the cartridge, which goes non-linear at high
 * levels. Its behaviour is not documented well enough to reproduce.
 */

/** CPU cycles per internal step. */
const STEP_CYCLES = 16;

/** YM2149 output level for each of the 32 envelope levels. */
const VOLTBL = new Uint16Array([
  0x00, 0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x04, 0x05, 0x06, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x12,
  0x16, 0x1a, 0x1f, 0x25, 0x2d, 0x35, 0x3f, 0x4c, 0x5a, 0x6a, 0x7f, 0x97, 0xb4, 0xd6, 0xff, 0xff,
]);

/** Bits each register keeps. */
const REGMSK = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0x3f, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff];

export class S5B {
  readonly reg = new Uint8Array(16);
  /** Each channel's output, 0..4080. */
  readonly out = new Int32Array(3);
  /** Note starts per channel: its volume rising from zero, or the envelope
   *  restarting under it. */
  readonly keyOnCount = new Int32Array(3);

  private readonly count = new Uint16Array(3);
  private readonly volume = new Uint8Array(3);
  private readonly freq = new Uint16Array(3);
  private readonly edge = new Uint8Array(3);
  /** Non-zero: tone (or noise) disabled for the channel, as $07 holds it. */
  private readonly tmask = new Uint8Array(3);
  private readonly nmask = new Uint8Array(3);

  private envPtr = 0;
  private envFace = 0;
  private envContinue = 0;
  private envAttack = 0;
  private envAlternate = 0;
  private envHold = 0;
  private envPause = 1;
  private envFreq = 0;
  private envCount = 0;

  private noiseSeed = 0xffff;
  private noiseScaler = 0;
  private noiseCount = 0;
  private noiseFreq = 0;

  /** Register selected through $C000, high nibble included. */
  private address = 0;
  /** Cycles until the next step. */
  private countdown = STEP_CYCLES;

  reset(): void {
    this.reg.fill(0);
    this.out.fill(0);
    this.count.fill(0);
    this.volume.fill(0);
    this.freq.fill(0);
    this.edge.fill(0);
    this.tmask.fill(0);
    this.nmask.fill(0);
    this.envPtr = 0;
    this.envFace = 0;
    this.envContinue = 0;
    this.envAttack = 0;
    this.envAlternate = 0;
    this.envHold = 0;
    this.envPause = 1;
    this.envFreq = 0;
    this.envCount = 0;
    this.noiseSeed = 0xffff;
    this.noiseScaler = 0;
    this.noiseCount = 0;
    this.noiseFreq = 0;
    this.address = 0;
    this.countdown = STEP_CYCLES;
  }

  /** $C000-$DFFF selects a register, $E000-$FFFF writes it. */
  write(addr: number, v: number): void {
    if ((addr & 0xe000) === 0xc000) {
      this.address = v;
    } else if ((addr & 0xe000) === 0xe000) {
      // As on the YM2149F, a select with any of the top four bits set leaves
      // the chip deselected.
      if ((this.address & 0xf0) === 0) this.writeReg(this.address, v);
    }
  }

  writeReg(r: number, v: number): void {
    if (r > 15) return;
    v &= REGMSK[r];
    this.reg[r] = v;
    switch (r) {
      case 0: case 1: case 2: case 3: case 4: case 5: {
        const c = r >> 1;
        this.freq[c] = ((this.reg[c * 2 + 1] & 15) << 8) + this.reg[c * 2];
        break;
      }
      case 6:
        this.noiseFreq = v & 31;
        break;
      case 7:
        this.tmask[0] = v & 1;
        this.tmask[1] = v & 2;
        this.tmask[2] = v & 4;
        this.nmask[0] = v & 8;
        this.nmask[1] = v & 16;
        this.nmask[2] = v & 32;
        break;
      case 8: case 9: case 10: {
        const c = r - 8;
        if ((this.volume[c] & 0x3e) === 0 && (v & 0x1f) !== 0) this.keyOnCount[c]++;
        this.volume[c] = v << 1;
        break;
      }
      case 11: case 12:
        this.envFreq = (this.reg[12] << 8) + this.reg[11];
        break;
      case 13:
        this.envContinue = (v >> 3) & 1;
        this.envAttack = (v >> 2) & 1;
        this.envAlternate = (v >> 1) & 1;
        this.envHold = v & 1;
        this.envFace = this.envAttack;
        this.envPause = 0;
        this.envPtr = this.envFace ? 0 : 0x1f;
        for (let c = 0; c < 3; c++) if (this.volume[c] & 32) this.keyOnCount[c]++;
        break;
    }
  }

  /** One internal step: emu2149's update_output with an increment of one. */
  private step(): void {
    // Envelope
    this.envCount += 1;
    if (this.envCount >= this.envFreq) {
      if (!this.envPause) {
        this.envPtr = this.envFace ? (this.envPtr + 1) & 0x3f : (this.envPtr + 0x3f) & 0x3f;
      }
      if (this.envPtr & 0x20) {
        // carry or borrow
        if (this.envContinue) {
          if (this.envAlternate ^ this.envHold) this.envFace ^= 1;
          if (this.envHold) this.envPause = 1;
          this.envPtr = this.envFace ? 0 : 0x1f;
        } else {
          this.envPause = 1;
          this.envPtr = 0;
        }
      }
      if (this.envFreq >= 1) this.envCount -= this.envFreq;
      else this.envCount = 0;
    }

    // Noise
    this.noiseCount = (this.noiseCount + 1) & 0xff;
    if (this.noiseCount >= this.noiseFreq) {
      this.noiseScaler ^= 1;
      if (this.noiseScaler) {
        if (this.noiseSeed & 1) this.noiseSeed ^= 0x24000;
        this.noiseSeed >>>= 1;
      }
      if (this.noiseFreq >= 1) this.noiseCount -= this.noiseFreq;
      else this.noiseCount = 0;
    }
    const noise = this.noiseSeed & 1;

    // Tone
    for (let i = 0; i < 3; i++) {
      this.count[i] += 1;
      if (this.count[i] >= this.freq[i]) {
        this.edge[i] = this.edge[i] ? 0 : 1;
        if (this.freq[i] >= 1) this.count[i] -= this.freq[i];
        else this.count[i] = 0;
      }
      if ((this.tmask[i] || this.edge[i]) && (this.nmask[i] || noise)) {
        const vol = this.volume[i];
        this.out[i] = (vol & 32 ? VOLTBL[this.envPtr] : VOLTBL[vol & 31]) << 4;
      } else {
        this.out[i] = 0;
      }
    }
  }

  /** CPU cycles until the output next changes. */
  cyclesToEvent(): number {
    return this.countdown;
  }

  advance(cycles: number): void {
    this.countdown -= cycles;
    while (this.countdown <= 0) {
      this.step();
      this.countdown += STEP_CYCLES;
    }
  }

  /* ----------------------------------------------------------- status */

  channel(ch: number): {
    period: number;
    tone: boolean;
    noise: boolean;
    volume: number;
    envelope: boolean;
  } {
    return {
      period: this.freq[ch],
      tone: this.tmask[ch] === 0,
      noise: this.nmask[ch] === 0,
      volume: this.reg[8 + ch] & 15,
      envelope: (this.reg[8 + ch] & 0x10) !== 0,
    };
  }

  /** Envelope level, 0..31. */
  get envelopeLevel(): number {
    return this.envPtr & 31;
  }
}
