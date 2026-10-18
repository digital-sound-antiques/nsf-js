/**
 * Nintendo MMC5 expansion audio: two pulses and an 8-bit PCM channel, plus the
 * two other things an NSF may use the chip for - its 1 KB of extra RAM and its
 * 8x8 multiplier.
 *
 * The pulses are the APU's own, less the sweep unit, and they do not fall silent
 * at the shortest periods. The chip has no frame sequencer, so their envelopes
 * and length counters run off a fixed divider instead - which means the length
 * counters run at the envelope rate, twice as fast as the APU's. Every channel
 * comes out inverted relative to the APU.
 *
 * Written from the NESdev wiki's description ("MMC5 audio", "MMC5").
 */

import { Pulse } from "./apu.js";

/**
 * CPU cycles between envelope and length counter clocks: the wiki's estimate of
 * the chip's divider, about 241 Hz on NTSC. Not bench-tested there, so not
 * exact either, but no music depends on the difference.
 */
const FRAME_PERIOD = 7424;

/** How long after its last write the PCM channel still counts as playing. */
const PCM_ACTIVE_CYCLES = 29780;

export class MMC5 {
  readonly pulse1 = new Pulse(false, true);
  readonly pulse2 = new Pulse(false, true);

  /** The PCM DAC's value. */
  pcm = 0;
  /** $5010 bit 0: 1 = the DAC takes whatever is read from $8000-$BFFF. */
  pcmReadMode = false;
  private pcmIrqEnable = false;
  private pcmIrqTrip = false;
  /** Writes to the DAC since load, and the cycle the last one landed on. */
  pcmWriteCount = 0;
  private lastPcmWrite = -Infinity;

  /** $5C00-$5FF5: work RAM as far as an NSF is concerned. */
  readonly exram = new Uint8Array(0x400);
  private multiplicand = 0xff;
  private multiplier = 0xff;

  private frameTimer = FRAME_PERIOD;
  /** Which half of an APU cycle the next CPU cycle is; the pulses see every second. */
  private evenCycle = true;
  /** CPU cycles since reset, for the PCM channel's activity. */
  private cycle = 0;

  reset(): void {
    this.pulse1.setEnabled(false);
    this.pulse2.setEnabled(false);
    for (let r = 0; r < 4; r++) {
      this.pulse1.write(r, 0);
      this.pulse2.write(r, 0);
    }
    this.pcm = 0;
    this.pcmReadMode = false;
    this.pcmIrqEnable = false;
    this.pcmIrqTrip = false;
    this.lastPcmWrite = -Infinity;
    this.exram.fill(0);
    this.multiplicand = 0xff;
    this.multiplier = 0xff;
    this.frameTimer = FRAME_PERIOD;
    this.evenCycle = true;
    this.cycle = 0;
  }

  /** Whether the chip claims a CPU address, for reads or writes. */
  static handles(addr: number): boolean {
    return (
      (addr >= 0x5000 && addr <= 0x5015) ||
      addr === 0x5205 ||
      addr === 0x5206 ||
      (addr >= 0x5c00 && addr <= 0x5ff5)
    );
  }

  write(addr: number, v: number): void {
    if (addr >= 0x5c00) {
      this.exram[addr - 0x5c00] = v;
      return;
    }
    switch (addr) {
      case 0x5000: case 0x5001: case 0x5002: case 0x5003:
        this.pulse1.write(addr & 3, v);
        break;
      case 0x5004: case 0x5005: case 0x5006: case 0x5007:
        this.pulse2.write(addr & 3, v);
        break;
      case 0x5010:
        this.pcmReadMode = (v & 1) !== 0;
        this.pcmIrqEnable = (v & 0x80) !== 0;
        break;
      case 0x5011:
        if (!this.pcmReadMode) this.writeDac(v);
        break;
      case 0x5015:
        this.pulse1.setEnabled((v & 1) !== 0);
        this.pulse2.setEnabled((v & 2) !== 0);
        break;
      case 0x5205:
        this.multiplicand = v;
        break;
      case 0x5206:
        this.multiplier = v;
        break;
    }
  }

  read(addr: number): number {
    if (addr >= 0x5c00) return this.exram[addr - 0x5c00];
    switch (addr) {
      case 0x5010: {
        // Bit 0 reads 0: the letterless MMC5, not the MMC5A.
        const v = this.pcmIrqTrip && this.pcmIrqEnable ? 0x80 : 0;
        this.pcmIrqTrip = false;
        return v;
      }
      case 0x5015:
        return (this.pulse1.length > 0 ? 1 : 0) | (this.pulse2.length > 0 ? 2 : 0);
      case 0x5205:
        return (this.multiplicand * this.multiplier) & 0xff;
      case 0x5206:
        return (this.multiplicand * this.multiplier) >> 8;
      default:
        return 0;
    }
  }

  /** A read from $8000-$BFFF: in read mode, it is what the DAC takes. */
  observeRead(v: number): void {
    if (this.pcmReadMode) this.writeDac(v);
  }

  private writeDac(v: number): void {
    // Zero leaves the DAC alone and trips the IRQ instead.
    if (v === 0) {
      this.pcmIrqTrip = true;
      return;
    }
    this.pcm = v;
    this.pcmWriteCount++;
    this.lastPcmWrite = this.cycle;
  }

  /** Whether the PCM channel has been written lately enough to be playing. */
  get pcmActive(): boolean {
    return this.cycle - this.lastPcmWrite < PCM_ACTIVE_CYCLES;
  }

  /** CPU cycles until the output could change. */
  cyclesToEvent(): number {
    const apu = Math.min(this.pulse1.eventIn(), this.pulse2.eventIn());
    const firstApu = this.evenCycle ? 2 : 1;
    const pulses = apu === Infinity ? Infinity : firstApu + (apu - 1) * 2;
    return Math.min(pulses, this.frameTimer);
  }

  advance(cycles: number): void {
    const apuClocks = (cycles + (this.evenCycle ? 0 : 1)) >> 1;
    if (apuClocks > 0) {
      this.pulse1.advance(apuClocks);
      this.pulse2.advance(apuClocks);
    }
    if (cycles & 1) this.evenCycle = !this.evenCycle;
    this.cycle += cycles;

    this.frameTimer -= cycles;
    while (this.frameTimer <= 0) {
      this.frameTimer += FRAME_PERIOD;
      // Envelope and length together, at the one rate the chip has.
      this.pulse1.clockQuarter();
      this.pulse2.clockQuarter();
      this.pulse1.clockHalf();
      this.pulse2.clockHalf();
    }
  }
}
