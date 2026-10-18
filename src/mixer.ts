/**
 * From 1.79 MHz to something a sound card can take, and the analogue end of the
 * NES's audio path.
 *
 * The channels are evaluated once per CPU cycle, so the raw stream carries
 * energy far above any output rate. Dropping straight to 44.1 kHz would fold
 * all of it back into the audible band, so the rate comes down in two stages: a
 * cheap cascaded-integrator decimator that runs at the full cycle rate, then a
 * proper windowed-sinc resampler on the much slower stream that leaves.
 */

/** Decimation factor of the first stage. */
export const CIC_RATIO = 8;

/**
 * Two cascaded box filters, decimating by a power of two.
 *
 * A single box would leave its first sidelobe only 13 dB down, which is audible
 * as grit on high square waves; two puts it near 26 dB while costing a handful
 * of adds per CPU cycle. Running sums are used rather than integrators so that
 * nothing accumulates without bound over a long track.
 */
export class CicDecimator {
  private readonly mask: number;
  private readonly r: number;
  private buf1: Float64Array;
  private buf2: Float64Array;
  private i1 = 0;
  private i2 = 0;
  private sum1 = 0;
  private sum2 = 0;
  private count = 0;
  /** The last value pushed, and how many times in a row it has been pushed. */
  private lastX = NaN;
  private sameRun = 0;

  value = 0;

  /** Inputs taken since the last decimated output, 0..R-1. */
  get phase(): number {
    return this.count;
  }

  /** Decimation factor. */
  get ratio(): number {
    return this.r;
  }

  constructor(ratio = CIC_RATIO) {
    if ((ratio & (ratio - 1)) !== 0) throw new Error("cic: ratio must be a power of two");
    this.r = ratio;
    this.mask = ratio - 1;
    this.buf1 = new Float64Array(ratio);
    this.buf2 = new Float64Array(ratio);
  }

  /**
   * Feed `count` copies of one sample and collect the decimated outputs in
   * `out`. Returns how many were written.
   *
   * Held at one value, both box filters settle after 2R pushes and every output
   * from then on is that value exactly - so a long run costs a division instead
   * of thousands of adds. This is what makes an event-driven caller pay for
   * changes rather than for cycles.
   */
  pushRun(x: number, count: number, out: Float64Array): number {
    if (count <= 0) return 0;
    if (x !== this.lastX) {
      this.lastX = x;
      this.sameRun = 0;
    }
    const settled = this.r * 2;
    let n = 0;
    while (count > 0 && this.sameRun < settled) {
      if (this.push(x)) out[n++] = this.value;
      this.sameRun++;
      count--;
    }
    if (count > 0) {
      const total = this.count + count;
      const outs = (total / this.r) | 0;
      this.count = total - outs * this.r;
      this.sameRun += count;
      for (let i = 0; i < outs; i++) out[n++] = x;
      if (outs > 0) this.value = x;
    }
    return n;
  }

  /** Feed one sample; returns true when `value` holds a decimated output. */
  push(x: number): boolean {
    this.sum1 += x - this.buf1[this.i1];
    this.buf1[this.i1] = x;
    this.i1 = (this.i1 + 1) & this.mask;

    const s1 = this.sum1;
    this.sum2 += s1 - this.buf2[this.i2];
    this.buf2[this.i2] = s1;
    this.i2 = (this.i2 + 1) & this.mask;

    if (++this.count < this.r) return false;
    this.count = 0;
    this.value = this.sum2 / (this.r * this.r);
    return true;
  }

  clear(): void {
    this.buf1.fill(0);
    this.buf2.fill(0);
    this.sum1 = 0;
    this.sum2 = 0;
    this.i1 = 0;
    this.i2 = 0;
    this.count = 0;
    this.value = 0;
    this.lastX = NaN;
    this.sameRun = 0;
  }
}

/**
 * Half-band decimator: halves the rate with a filter whose every other
 * coefficient is zero, so it costs half of what its length suggests.
 *
 * It sits between the two existing stages to buy the last one room. On its own
 * the windowed-sinc resampler has to go from 223 kHz to 44.1 kHz in one step,
 * and at a length that can run in real time its transition band is 6 kHz wide -
 * wider than the gap between the audible top and Nyquist, so it never reaches
 * its stopband before the fold point and passes what belongs above it. Halving
 * the rate first halves the transition width in Hz, which puts the stopband
 * where it needs to be.
 */
export class HalfBand {
  /** Only the coefficients that are not zero, and where each one reads from. */
  readonly #taps: Float64Array;
  readonly #offsets: Int32Array;
  readonly #length: number;
  private hist: Float64Array;
  private pos = 0;
  private odd = false;

  value = 0;

  constructor(length = 31) {
    // Odd length, symmetric, cutoff at a quarter of the input rate: the
    // definition of a half-band, and what makes the odd taps vanish.
    const n = length | 1;
    const half = (n - 1) >> 1;
    const h = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = i - half;
      const x = (Math.PI * t) / 2;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      const w = i / (n - 1);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
      h[i] = sinc * win;
      sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;

    // Every coefficient at an even distance from the centre is zero, which is
    // half of them; keeping only the rest halves the work per output.
    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (h[i] !== 0) keep.push(i);
    this.#taps = new Float64Array(keep.map((i) => h[i]));
    this.#offsets = new Int32Array(keep);
    this.#length = n;
    this.hist = new Float64Array(n);
  }

  /** Feed one sample; returns true on every second one, with `value` set. */
  push(x: number): boolean {
    const n = this.#length;
    this.hist[this.pos] = x;
    this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
    this.odd = !this.odd;
    if (this.odd) return false;

    const taps = this.#taps;
    const offsets = this.#offsets;
    const hist = this.hist;
    const base = this.pos;
    let acc = 0;
    for (let i = 0; i < taps.length; i++) {
      let k = base + offsets[i];
      if (k >= n) k -= n;
      acc += taps[i] * hist[k];
    }
    this.value = acc;
    return true;
  }

  clear(): void {
    this.hist.fill(0);
    this.pos = 0;
    this.odd = false;
    this.value = 0;
  }
}

/**
 * The console's analogue response, as the Famicom has it: a single first-order
 * high pass at 37 Hz, which removes the standing offset a DMC sample or an FDS
 * wavetable leaves behind and little else.
 *
 * The NES front-loader adds two more high passes, at 90 and 440 Hz, and a low
 * pass at 14 kHz (NESdev, "APU Mixer"). Those are what an NES sounds like from
 * its AV jack, but they take most of the weight out of a bass line - and every
 * expansion chip here was a Famicom cartridge's, so the Famicom is the machine
 * this music was written for.
 */
export class NesFilter {
  private hp = 0;
  private readonly a: number;

  constructor(sampleRate: number) {
    this.a = Math.exp((-2 * Math.PI * 37) / sampleRate);
  }

  process(x: number): number {
    // A one-pole low pass subtracted from the signal.
    this.hp = this.a * this.hp + (1 - this.a) * x;
    return x - this.hp;
  }

  clear(): void {
    this.hp = 0;
  }
}

/**
 * Level the FDS channel is mixed in at, relative to the APU's own output.
 *
 * The two chips meet on an analogue summing point outside both of them, so
 * there is no register-level truth to appeal to here; this is set so that an FDS
 * track sits at the same loudness as a 2A03 one.
 */
export const FDS_MIX_LEVEL = 0.28;

/**
 * Scale from the mixer's 0..1 output to int16.
 *
 * The DAC's theoretical maximum needs every channel at full level with the DMC
 * blasting, which music never does; this is set from what real tracks actually
 * peak at, so a loud one lands near full scale rather than at a third of it.
 * Over the first 40 s of 449 tracks (2A03, FDS, VRC6, VRC7) the highest peak is
 * -0.8 dBFS, on a VRC7 track; nothing clips.
 */
export const MASTER_OUTPUT_LEVEL = 42000;

/**
 * Level the VRC6 is mixed in at, relative to the APU's own output.
 *
 * Like the FDS, the two chips meet on an analogue summing point outside both of
 * them, so there is no register-level truth here. This is set so that a VRC6
 * pulse at full volume sits about where a 2A03 pulse at full volume does, which
 * is what the cartridge sounds like.
 */
export const VRC6_MIX_LEVEL = 0.62;

/**
 * Level the VRC7 is mixed in at, relative to the APU's own output, for its sum
 * of channels scaled to +-0.5 at full level each.
 *
 * Unlike the FDS and VRC6 levels this one is measured: on a Famicom with a
 * VRC7 cartridge, a full-volume VRC7 pseudo-square (2:1 modulator, full
 * feedback) is 10.9-11.3 dB above a full-volume APU square in RMS
 * (bbbradsmith's db_vrc7 test, as reported on the NESdev forum, thread 17741).
 * That tone comes out of this emulation at 0.7 of a channel's full scale, and
 * a 50% APU square at 0.075 of the APU's, which puts the level here.
 */
export const VRC7_MIX_LEVEL = 0.77;

/**
 * Level the N163 is mixed in at, relative to the APU's own output, for its DAC
 * scaled to -1..+0.875 (a sample of 0 or 15 at full volume).
 *
 * Measured on hardware, but the measurements disagree: the N163 boards differ,
 * and a full-volume single-channel square is anywhere from 11 to 19.5 dB above
 * a full-volume APU square depending on the game (NESdev, "Namco 163 audio").
 * An NSF does not say which board it came from, so this takes 16.5 dB, the
 * middle of the class NES 2.0 gives most of them. That square comes out at
 * 0.9375 of this scale, and a 50% APU square at 0.075 of the APU's.
 */
export const N163_MIX_LEVEL = 0.53;

/**
 * Level the Sunsoft 5B is mixed in at, relative to the APU's own output, for
 * its channels scaled to 0..1 each.
 *
 * Measured on hardware: one channel's square at volume 12 is 1.3 dB below a
 * full-volume APU square in RMS (rainwarrior's db_5b test, NESdev forum thread
 * 17741). Volume 12 because the cartridge's amplifier stops being linear above
 * it; that compression is not modelled, so the loudest passages come out a
 * little hotter than on hardware. A volume-12 square swings 0.353 of a
 * channel's scale here, and a 50% APU square 0.149 of the APU's.
 */
export const S5B_MIX_LEVEL = 0.364;
