/**
 * Namco 163 expansion audio: up to eight wavetable channels sharing 128 bytes
 * of RAM with their own registers.
 *
 * The chip has no mixer. It visits one channel every 15 CPU cycles, works out
 * that channel's next sample, and puts it on its one DAC, where it stays until
 * the next channel's turn. With more channels enabled each one is visited less
 * often, which lowers the pitch a frequency value gives and - from seven
 * channels up - leaves the switching itself audible as a whine. That is what
 * the hardware sounds like, so it is what this does: the output is the channel
 * of the moment, not an average.
 *
 * Written from the NESdev wiki's description ("Namco 163 audio"). Its update
 * algorithm is marked speculative there; it is followed as written.
 */

/** CPU cycles the chip spends on each channel. */
const CYCLES_PER_CHANNEL = 15;

/** First channel's registers; channel 8 sits at $78. */
const REG_BASE = 0x40;

export class N163 {
  /** Sound RAM: wavetables below, and anywhere unused, channel registers above. */
  readonly ram = new Uint8Array(0x80);
  /** Each channel's output as of its last visit, (sample - 8) * volume. */
  readonly channelOut = new Int32Array(8);
  /** Volume rises from zero, per channel, for telling a new note from a held one. */
  readonly keyOnCount = new Int32Array(8);

  /** Address set through $F800, and whether the data port advances it. */
  private address = 0;
  private autoIncrement = false;
  /** Channel the chip visits next, 7 (channel 8) downwards. */
  private current = 7;
  /** Cycles until that visit. */
  private timer = CYCLES_PER_CHANNEL;
  /** What the DAC is putting out: the last channel visited, and which it was. */
  output = 0;
  outputChannel = 7;
  /** Volume each channel had at its last visit. */
  private readonly lastVolume = new Uint8Array(8);

  reset(): void {
    this.ram.fill(0);
    this.channelOut.fill(0);
    this.lastVolume.fill(0);
    this.address = 0;
    this.autoIncrement = false;
    this.current = 7;
    this.timer = CYCLES_PER_CHANNEL;
    this.output = 0;
    this.outputChannel = 7;
  }

  /** $F800-$FFFF: the address port. */
  writeAddress(v: number): void {
    this.address = v & 0x7f;
    this.autoIncrement = (v & 0x80) !== 0;
  }

  /** $4800-$4FFF: the data port. */
  writeData(v: number): void {
    this.ram[this.address] = v;
    this.advance();
  }

  readData(): number {
    const v = this.ram[this.address];
    this.advance();
    return v;
  }

  private advance(): void {
    // The address stops at $7F rather than wrapping.
    if (this.autoIncrement && this.address < 0x7f) this.address++;
  }

  /** Channels enabled: 1 + the count field in $7F, always the top ones. */
  get channelCount(): number {
    return ((this.ram[0x7f] >> 4) & 7) + 1;
  }

  /** CPU cycles until the output next changes. */
  cyclesToEvent(): number {
    return this.timer;
  }

  clock(cycles: number): void {
    while (cycles >= this.timer) {
      cycles -= this.timer;
      this.timer = CYCLES_PER_CHANNEL;
      this.update(this.current);
      // Round the enabled channels, from channel 8 downwards.
      const lowest = 8 - this.channelCount;
      this.current = this.current <= lowest ? 7 : this.current - 1;
    }
    this.timer -= cycles;
  }

  private update(ch: number): void {
    const ram = this.ram;
    const b = REG_BASE + ch * 8;
    const freq = ((ram[b + 4] & 3) << 16) | (ram[b + 2] << 8) | ram[b];
    const length = 256 - (ram[b + 4] & 0xfc);
    let phase = (ram[b + 5] << 16) | (ram[b + 3] << 8) | ram[b + 1];
    phase = (phase + freq) % (length << 16);
    ram[b + 5] = (phase >> 16) & 0xff;
    ram[b + 3] = (phase >> 8) & 0xff;
    ram[b + 1] = phase & 0xff;

    const at = ((phase >> 16) + ram[b + 6]) & 0xff;
    const sample = (ram[at >> 1] >> ((at & 1) * 4)) & 0x0f;
    const volume = ram[b + 7] & 0x0f;
    if (volume > 0 && this.lastVolume[ch] === 0) this.keyOnCount[ch]++;
    this.lastVolume[ch] = volume;

    const out = (sample - 8) * volume;
    this.channelOut[ch] = out;
    this.output = out;
    this.outputChannel = ch;
  }

  /* ----------------------------------------------------------- status */

  /** Whether a channel is among those the chip is visiting. */
  isEnabled(ch: number): boolean {
    return ch >= 8 - this.channelCount;
  }

  /** A channel's registers, decoded. */
  channel(ch: number): { freq: number; length: number; offset: number; volume: number } {
    const ram = this.ram;
    const b = REG_BASE + ch * 8;
    return {
      freq: ((ram[b + 4] & 3) << 16) | (ram[b + 2] << 8) | ram[b],
      length: 256 - (ram[b + 4] & 0xfc),
      offset: ram[b + 6],
      volume: ram[b + 7] & 0x0f,
    };
  }

  /** The waveform a channel is playing, one 4-bit sample per byte. */
  wave(ch: number): Uint8Array {
    const { length, offset } = this.channel(ch);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const at = (offset + i) & 0xff;
      out[i] = (this.ram[at >> 1] >> ((at & 1) * 4)) & 0x0f;
    }
    return out;
  }
}
