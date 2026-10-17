/**
 * Konami VRC7 expansion audio: six channels of two-operator FM.
 *
 * The VRC7's sound half is a cut-down YM2413 (OPLL): the same operators, the
 * same envelope generator and the same register map, but six channels instead
 * of nine, no rhythm section, and a ROM of fifteen instruments of its own.
 *
 * This is a TypeScript port of emu2413 (MIT, same author), reduced to what the
 * VRC7 has. The arithmetic follows the C source line for line - the integer
 * widths included - so it produces the same output sample for sample; the
 * tables it was built with are regenerated here from the formulas the C source
 * documents them by.
 *
 * The chip runs from its own 3.58 MHz crystal and produces one sample every 72
 * of its clocks, which on an NTSC console is exactly every 36 CPU cycles. Each
 * sample is held until the next, so the player sees an output that changes on
 * that grid and nowhere else.
 */

import { NTSC_CPU_CLOCK, PAL_CPU_CLOCK } from "./apu.js";

/* ------------------------------------------------------------------ tables */

/** The VRC7's instrument ROM, as Nuke.YKT read it out of the die; 0 is the user patch. */
const VRC7_PATCHES = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x03, 0x21, 0x05, 0x06, 0xe8, 0x81, 0x42, 0x27],
  [0x13, 0x41, 0x14, 0x0d, 0xd8, 0xf6, 0x23, 0x12],
  [0x11, 0x11, 0x08, 0x08, 0xfa, 0xb2, 0x20, 0x12],
  [0x31, 0x61, 0x0c, 0x07, 0xa8, 0x64, 0x61, 0x27],
  [0x32, 0x21, 0x1e, 0x06, 0xe1, 0x76, 0x01, 0x28],
  [0x02, 0x01, 0x06, 0x00, 0xa3, 0xe2, 0xf4, 0xf4],
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x11, 0x07],
  [0x23, 0x21, 0x22, 0x17, 0xa2, 0x72, 0x01, 0x17],
  [0x35, 0x11, 0x25, 0x00, 0x40, 0x73, 0x72, 0x01],
  [0xb5, 0x01, 0x0f, 0x0f, 0xa8, 0xa5, 0x51, 0x02],
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12],
  [0x71, 0x23, 0x11, 0x06, 0x65, 0x74, 0x18, 0x16],
  [0x01, 0x02, 0xd3, 0x05, 0xc9, 0x95, 0x03, 0x02],
  [0x61, 0x63, 0x0c, 0x00, 0x94, 0xc0, 0x33, 0xf6],
  [0x21, 0x72, 0x0d, 0x00, 0xc1, 0xd5, 0x56, 0x06],
];

/** Phase accumulator width, and the sine table's index width within it. */
const PG_BITS = 10;
const PG_WIDTH = 1 << PG_BITS;
const DP_BITS = 19;
const DP_WIDTH = 1 << DP_BITS;
const DP_BASE_BITS = DP_BITS - PG_BITS;

/** Envelope output: 7 bits of 0.375 dB. */
const EG_STEP = 0.375;
const EG_MUTE = (1 << 7) - 1;
const EG_MAX = EG_MUTE - 4;

/** Rate of the damping that precedes every key-on. */
const DAMPER_RATE = 12;

const ATTACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const RELEASE = 3;
const DAMP = 4;

const UPDATE_WS = 1;
const UPDATE_TLL = 2;
const UPDATE_RKS = 4;
const UPDATE_EG = 8;
const UPDATE_ALL = 255;

/** exp_table[x] = round((2^(x/256) - 1) * 1024) */
const EXP_TABLE = new Uint16Array(256);
for (let x = 0; x < 256; x++) EXP_TABLE[x] = Math.round((Math.pow(2, x / 256) - 1) * 1024);

/**
 * Log-sine, as attenuation: round(-log2(sin((x + 0.5) * PI / 512)) * 256) for
 * the first quarter, mirrored for the second, with the sign bit set on the
 * second half. The half-sine table holds the positive half and, in place of
 * the negative one, an attenuation large enough to be silence.
 */
const FULLSIN_TABLE = new Uint16Array(PG_WIDTH);
const HALFSIN_TABLE = new Uint16Array(PG_WIDTH);
{
  const q = PG_WIDTH / 4;
  for (let x = 0; x < q; x++) {
    FULLSIN_TABLE[x] = Math.round(-Math.log2(Math.sin(((x + 0.5) * Math.PI) / q / 2)) * 256);
  }
  for (let x = 0; x < q; x++) FULLSIN_TABLE[q + x] = FULLSIN_TABLE[q - x - 1];
  for (let x = 0; x < PG_WIDTH / 2; x++) FULLSIN_TABLE[PG_WIDTH / 2 + x] = 0x8000 | FULLSIN_TABLE[x];
  for (let x = 0; x < PG_WIDTH / 2; x++) HALFSIN_TABLE[x] = FULLSIN_TABLE[x];
  for (let x = PG_WIDTH / 2; x < PG_WIDTH; x++) HALFSIN_TABLE[x] = 0xfff;
}
const WAVE_TABLES = [FULLSIN_TABLE, HALFSIN_TABLE];

/** Vibrato: an offset to the F-number by its top three bits, roughly 14 cents. */
const PM_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, -1, 0],
  [0, 1, 2, 1, 0, -1, -2, -1],
  [0, 1, 3, 1, 0, -1, -3, -1],
  [0, 2, 4, 2, 0, -2, -4, -2],
  [0, 2, 5, 2, 0, -2, -5, -2],
  [0, 3, 6, 3, 0, -3, -6, -3],
  [0, 3, 7, 3, 0, -3, -7, -3],
];

/** Tremolo, as measured on a real YM2413; each entry lasts 64 samples. */
const AM_TABLE = new Uint8Array(
  (() => {
    const t: number[] = [];
    for (let v = 0; v <= 12; v++) for (let i = 0; i < 8; i++) t.push(v);
    t.push(13, 13, 13);
    for (let v = 12; v >= 1; v--) for (let i = 0; i < 8; i++) t.push(v);
    for (let i = 0; i < 7; i++) t.push(0);
    return t;
  })()
);

/** Envelope increment patterns by the rate's low two bits. */
const EG_STEP_TABLES = [
  [0, 1, 0, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 1, 1, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 1],
];

/** Frequency multiplier, doubled so that the half step is an integer. */
const ML_TABLE = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];

/** Key scale level by the F-number's top four bits, in units of 0.5 dB. */
const KL_TABLE = [
  0.0, 9.0, 12.0, 13.875, 15.0, 16.125, 16.875, 17.625, 18.0, 18.75, 19.125, 19.5, 19.875,
  20.25, 20.625, 21.0,
].map((db) => db * 2);

/** Attenuation by block, F-number and KSL setting. */
const TLL_TABLE: Uint16Array[] = [];
for (let i = 0; i < 8 * 16; i++) TLL_TABLE.push(new Uint16Array(4));
for (let fnum = 0; fnum < 16; fnum++) {
  for (let block = 0; block < 8; block++) {
    for (let kl = 1; kl < 4; kl++) {
      const tmp = Math.trunc(KL_TABLE[fnum] - 6.0 * (7 - block));
      TLL_TABLE[(block << 4) | fnum][kl] = tmp <= 0 ? 0 : Math.trunc((tmp >> (3 - kl)) / EG_STEP);
    }
  }
}

/** Key scale rate by block and the F-number's top bit, for KSR off and on. */
const RKS_TABLE: number[][] = [];
for (let i = 0; i < 16; i++) RKS_TABLE.push([(i >> 1) >> 1, i]);

/* ------------------------------------------------------------------- state */

interface Patch {
  TL: number;
  FB: number;
  EG: number;
  ML: number;
  AR: number;
  DR: number;
  SL: number;
  RR: number;
  KR: number;
  KL: number;
  AM: number;
  PM: number;
  WS: number;
}

function emptyPatch(): Patch {
  return { TL: 0, FB: 0, EG: 0, ML: 0, AR: 0, DR: 0, SL: 0, RR: 0, KR: 0, KL: 0, AM: 0, PM: 0, WS: 0 };
}

/** Modulator and carrier from an eight-byte instrument dump. */
function dumpToPatch(d: number[], mod: Patch, car: Patch): void {
  mod.AM = (d[0] >> 7) & 1;
  car.AM = (d[1] >> 7) & 1;
  mod.PM = (d[0] >> 6) & 1;
  car.PM = (d[1] >> 6) & 1;
  mod.EG = (d[0] >> 5) & 1;
  car.EG = (d[1] >> 5) & 1;
  mod.KR = (d[0] >> 4) & 1;
  car.KR = (d[1] >> 4) & 1;
  mod.ML = d[0] & 15;
  car.ML = d[1] & 15;
  mod.KL = (d[2] >> 6) & 3;
  car.KL = (d[3] >> 6) & 3;
  mod.TL = d[2] & 63;
  car.TL = 0;
  mod.FB = d[3] & 7;
  car.FB = 0;
  mod.WS = (d[3] >> 3) & 1;
  car.WS = (d[3] >> 4) & 1;
  mod.AR = (d[4] >> 4) & 15;
  car.AR = (d[5] >> 4) & 15;
  mod.DR = d[4] & 15;
  car.DR = d[5] & 15;
  mod.SL = (d[6] >> 4) & 15;
  car.SL = (d[7] >> 4) & 15;
  mod.RR = d[6] & 15;
  car.RR = d[7] & 15;
}

class Slot {
  /** Bit 0: 0 modulator, 1 carrier. */
  readonly type: number;
  /** Index into {@link VRC7.patches}. */
  patch = 0;
  output0 = 0;
  output1 = 0;
  /** 0: full sine, 1: half sine. */
  wave = 0;
  pgPhase = 0;
  pgOut = 0;
  /** (block << 9) | F-number. */
  blkFnum = 0;
  fnum = 0;
  blk = 0;
  egState = RELEASE;
  volume = 0;
  keyFlag = 0;
  susFlag = 0;
  tll = 0;
  rks = 0;
  egRateH = 0;
  egRateL = 0;
  egShift = 0;
  egOut = EG_MUTE;
  updateRequests = 0;

  constructor(type: number) {
    this.type = type;
  }
}

export class VRC7 {
  /** Two per channel - modulator and carrier - in that order. */
  readonly slots: Slot[] = [];
  /** Instrument 0 is the user patch; 1-15 are the ROM. Two entries each. */
  readonly patches: Patch[] = [];
  readonly reg = new Uint8Array(0x40);
  /** Instrument selected on each channel. */
  readonly patchNumber = new Int32Array(6);
  /** Each channel's output for the current sample, -2047..2047ish. */
  readonly out = new Int32Array(6);
  /** Key-ons per channel since reset, for telling a new note from a held one. */
  readonly keyOnCount = new Int32Array(6);

  /** Address latched by $9010. */
  private address = 0;
  private testFlag = 0;
  private slotKeyStatus = 0;
  private egCounter = 0;
  private pmPhase = 0;
  private amPhase = 0;
  private lfoAm = 0;

  /** Cycles until the next sample, in 1/4096ths of a CPU cycle. */
  private countdown = 0;
  /** Sample period in the same units: 36 CPU cycles on NTSC. */
  private readonly period: number;

  constructor(pal = false) {
    // The cartridge carries its own crystal at twice the NTSC CPU clock, so a
    // PAL console runs it at the same absolute rate - which is fewer of its own
    // cycles per sample.
    const cycles = pal ? (36 * PAL_CPU_CLOCK) / NTSC_CPU_CLOCK : 36;
    this.period = Math.round(cycles * 4096);
    for (let i = 0; i < 12; i++) this.slots.push(new Slot(i & 1));
    for (let i = 0; i < 32; i++) this.patches.push(emptyPatch());
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < 16; i++) dumpToPatch(VRC7_PATCHES[i], this.patches[i * 2], this.patches[i * 2 + 1]);
    this.address = 0;
    this.reg.fill(0);
    this.testFlag = 0;
    this.slotKeyStatus = 0;
    this.egCounter = 0;
    this.pmPhase = 0;
    this.amPhase = 0;
    this.lfoAm = 0;
    this.countdown = this.period;
    for (const s of this.slots) {
      s.wave = 0;
      s.pgPhase = 0;
      s.pgOut = 0;
      s.output0 = 0;
      s.output1 = 0;
      s.egState = RELEASE;
      s.egShift = 0;
      s.rks = 0;
      s.tll = 0;
      s.keyFlag = 0;
      s.susFlag = 0;
      s.blkFnum = 0;
      s.blk = 0;
      s.fnum = 0;
      s.volume = 0;
      s.egRateH = 0;
      s.egRateL = 0;
      s.egOut = EG_MUTE;
      s.updateRequests = 0;
    }
    for (let ch = 0; ch < 6; ch++) this.setPatch(ch, 0);
    for (let r = 0; r < 0x40; r++) this.writeReg(r, 0);
    this.out.fill(0);
  }

  /** $9010 latches a register number, $9030 writes it. */
  write(addr: number, v: number): void {
    switch (addr & 0xf030) {
      case 0x9010:
        this.address = v;
        break;
      case 0x9030:
        this.writeReg(this.address, v);
        break;
    }
  }

  /* ---------------------------------------------------------- registers */

  private patchOf(slot: Slot): Patch {
    return this.patches[slot.patch];
  }

  private setPatch(ch: number, num: number): void {
    this.patchNumber[ch] = num;
    const mod = this.slots[ch * 2];
    const car = this.slots[ch * 2 + 1];
    mod.patch = num * 2;
    car.patch = num * 2 + 1;
    mod.updateRequests |= UPDATE_ALL;
    car.updateRequests |= UPDATE_ALL;
  }

  private forUserPatch(slotType: number, flags: number): void {
    for (let ch = 0; ch < 6; ch++) {
      if (this.patchNumber[ch] === 0) this.slots[ch * 2 + slotType].updateRequests |= flags;
    }
  }

  private setFnumber(ch: number, fnum: number): void {
    for (let i = 0; i < 2; i++) {
      const s = this.slots[ch * 2 + i];
      s.fnum = fnum;
      s.blkFnum = (s.blkFnum & 0xe00) | (fnum & 0x1ff);
      s.updateRequests |= UPDATE_EG | UPDATE_RKS | UPDATE_TLL;
    }
  }

  private setBlock(ch: number, blk: number): void {
    for (let i = 0; i < 2; i++) {
      const s = this.slots[ch * 2 + i];
      s.blk = blk;
      s.blkFnum = ((blk & 7) << 9) | (s.blkFnum & 0x1ff);
      s.updateRequests |= UPDATE_EG | UPDATE_RKS | UPDATE_TLL;
    }
  }

  private updateKeyStatus(): void {
    let status = 0;
    for (let ch = 0; ch < 6; ch++) if (this.reg[0x20 + ch] & 0x10) status |= 3 << (ch * 2);
    const changed = this.slotKeyStatus ^ status;
    if (changed) {
      for (let i = 0; i < 12; i++) {
        if (!((changed >> i) & 1)) continue;
        const s = this.slots[i];
        if ((status >> i) & 1) {
          s.keyFlag = 1;
          s.egState = DAMP;
          if (s.type & 1) this.keyOnCount[i >> 1]++;
          s.updateRequests |= UPDATE_EG;
        } else {
          s.keyFlag = 0;
          if (s.type & 1) {
            s.egState = RELEASE;
            s.updateRequests |= UPDATE_EG;
          }
        }
      }
    }
    this.slotKeyStatus = status;
  }

  writeReg(r: number, data: number): void {
    if (r >= 0x40) return;
    if ((0x19 <= r && r <= 0x1f) || (0x29 <= r && r <= 0x2f) || (0x39 <= r && r <= 0x3f)) r -= 9;
    // Channels 7-9 of the YM2413 are not there.
    if (r >= 0x10 && (r & 0x0f) >= 6) return;
    this.reg[r] = data;

    const user = this.patches;
    switch (r) {
      case 0x00:
        user[0].AM = (data >> 7) & 1;
        user[0].PM = (data >> 6) & 1;
        user[0].EG = (data >> 5) & 1;
        user[0].KR = (data >> 4) & 1;
        user[0].ML = data & 15;
        this.forUserPatch(0, UPDATE_RKS | UPDATE_EG);
        break;
      case 0x01:
        user[1].AM = (data >> 7) & 1;
        user[1].PM = (data >> 6) & 1;
        user[1].EG = (data >> 5) & 1;
        user[1].KR = (data >> 4) & 1;
        user[1].ML = data & 15;
        this.forUserPatch(1, UPDATE_RKS | UPDATE_EG);
        break;
      case 0x02:
        user[0].KL = (data >> 6) & 3;
        user[0].TL = data & 63;
        this.forUserPatch(0, UPDATE_TLL);
        break;
      case 0x03:
        user[1].KL = (data >> 6) & 3;
        user[1].WS = (data >> 4) & 1;
        user[0].WS = (data >> 3) & 1;
        user[0].FB = data & 7;
        this.forUserPatch(0, UPDATE_WS);
        this.forUserPatch(1, UPDATE_WS | UPDATE_TLL);
        break;
      case 0x04:
        user[0].AR = (data >> 4) & 15;
        user[0].DR = data & 15;
        this.forUserPatch(0, UPDATE_EG);
        break;
      case 0x05:
        user[1].AR = (data >> 4) & 15;
        user[1].DR = data & 15;
        this.forUserPatch(1, UPDATE_EG);
        break;
      case 0x06:
        user[0].SL = (data >> 4) & 15;
        user[0].RR = data & 15;
        this.forUserPatch(0, UPDATE_EG);
        break;
      case 0x07:
        user[1].SL = (data >> 4) & 15;
        user[1].RR = data & 15;
        this.forUserPatch(1, UPDATE_EG);
        break;
      case 0x0f:
        this.testFlag = data;
        break;
      default: {
        // $0E, the YM2413's rhythm register, does nothing here.
        const ch = r & 0x0f;
        switch (r & 0xf0) {
          case 0x10:
            this.setFnumber(ch, data + ((this.reg[0x20 + ch] & 1) << 8));
            break;
          case 0x20: {
            this.setFnumber(ch, ((data & 1) << 8) + this.reg[0x10 + ch]);
            this.setBlock(ch, (data >> 1) & 7);
            const sus = (data >> 5) & 1;
            const car = this.slots[ch * 2 + 1];
            car.susFlag = sus;
            car.updateRequests |= UPDATE_EG;
            this.updateKeyStatus();
            break;
          }
          case 0x30: {
            this.setPatch(ch, (data >> 4) & 15);
            const car = this.slots[ch * 2 + 1];
            car.volume = (data & 15) << 2;
            car.updateRequests |= UPDATE_TLL;
            break;
          }
        }
      }
    }
  }

  /* -------------------------------------------------------- synthesis */

  private parameterRate(s: Slot): number {
    if ((s.type & 1) === 0 && s.keyFlag === 0) return 0;
    const p = this.patchOf(s);
    switch (s.egState) {
      case ATTACK:
        return p.AR;
      case DECAY:
        return p.DR;
      case SUSTAIN:
        return p.EG ? 0 : p.RR;
      case RELEASE:
        if (s.susFlag) return 5;
        return p.EG ? p.RR : 7;
      case DAMP:
        return DAMPER_RATE;
      default:
        return 0;
    }
  }

  private commitSlotUpdate(s: Slot): void {
    const p = this.patchOf(s);
    const req = s.updateRequests;
    if (req & UPDATE_WS) s.wave = p.WS;
    if (req & UPDATE_TLL) {
      const tl = (s.type & 1) === 0 ? p.TL : s.volume;
      s.tll = TLL_TABLE[s.blkFnum >> 5][p.KL] + (tl << 1);
    }
    if (req & UPDATE_RKS) s.rks = RKS_TABLE[s.blkFnum >> 8][p.KR];
    if (req & (UPDATE_RKS | UPDATE_EG)) {
      const rate = this.parameterRate(s);
      if (rate === 0) {
        s.egShift = 0;
        s.egRateH = 0;
        s.egRateL = 0;
      } else {
        s.egRateH = Math.min(15, rate + (s.rks >> 2));
        s.egRateL = s.rks & 3;
        if (s.egState === ATTACK) {
          s.egShift = 0 < s.egRateH && s.egRateH < 12 ? 13 - s.egRateH : 0;
        } else {
          s.egShift = s.egRateH < 13 ? 13 - s.egRateH : 0;
        }
      }
    }
    s.updateRequests = 0;
  }

  private static attackStep(s: Slot, counter: number): number {
    switch (s.egRateH) {
      case 12:
        return 4 - EG_STEP_TABLES[s.egRateL][(counter & 0xc) >> 1];
      case 13:
        return 3 - EG_STEP_TABLES[s.egRateL][(counter & 0xc) >> 1];
      case 14:
        return 2 - EG_STEP_TABLES[s.egRateL][(counter & 0xc) >> 1];
      case 0:
      case 15:
        return 0;
      default:
        return EG_STEP_TABLES[s.egRateL][(counter >> s.egShift) & 7] ? 4 : 0;
    }
  }

  private static decayStep(s: Slot, counter: number): number {
    switch (s.egRateH) {
      case 0:
        return 0;
      case 13:
        return EG_STEP_TABLES[s.egRateL][((counter & 0xc) >> 1) | (counter & 1)];
      case 14:
        return EG_STEP_TABLES[s.egRateL][(counter & 0xc) >> 1] + 1;
      case 15:
        return 2;
      default:
        return EG_STEP_TABLES[s.egRateL][(counter >> s.egShift) & 7];
    }
  }

  private startEnvelope(s: Slot): void {
    if (Math.min(15, this.patchOf(s).AR + (s.rks >> 2)) === 15) {
      s.egState = DECAY;
      s.egOut = 0;
    } else {
      s.egState = ATTACK;
    }
    s.updateRequests |= UPDATE_EG;
  }

  private calcEnvelope(s: Slot, buddy: Slot, counter: number, test: number): void {
    if (
      !test &&
      (s.egState === SUSTAIN || s.egState === RELEASE) &&
      (s.egOut >= EG_MUTE || s.egRateH === 0)
    ) {
      return;
    }

    const mask = (1 << s.egShift) - 1;

    if (s.egState === ATTACK) {
      if (0 < s.egOut && 0 < s.egRateH && (counter & mask & ~3) === 0) {
        const step = VRC7.attackStep(s, counter);
        if (step > 0) s.egOut = Math.max(0, s.egOut - (s.egOut >> step) - 1);
      }
    } else if (s.egRateH > 0 && (counter & mask) === 0) {
      s.egOut = Math.min(EG_MUTE, s.egOut + VRC7.decayStep(s, counter));
    }

    switch (s.egState) {
      case DAMP:
        // The damping ends - and the attack begins - once the envelope reaches
        // the bottom, on a step the envelope itself would take.
        if (s.egOut >= EG_MAX && (counter & mask) === 0) {
          this.startEnvelope(s);
          if (s.type & 1) {
            s.pgPhase = 0;
            buddy.pgPhase = 0;
          }
        }
        break;
      case ATTACK:
        if (s.egOut === 0) {
          s.egState = DECAY;
          s.updateRequests |= UPDATE_EG;
        }
        break;
      case DECAY:
        // Checked every sample, not only on the envelope's own steps.
        if (s.egOut >> 3 === this.patchOf(s).SL) {
          s.egState = SUSTAIN;
          s.updateRequests |= UPDATE_EG;
        }
        break;
    }

    if (test) s.egOut = 0;
  }

  private calcPhase(s: Slot, reset: number): void {
    const p = this.patchOf(s);
    const pm = p.PM ? PM_TABLE[(s.fnum >> 6) & 7][(this.pmPhase >> 10) & 7] : 0;
    if (reset) s.pgPhase = 0;
    s.pgPhase += (((s.fnum & 0x1ff) * 2 + pm) * ML_TABLE[p.ML]) << s.blk >> 2;
    s.pgPhase &= DP_WIDTH - 1;
    s.pgOut = s.pgPhase >> DP_BASE_BITS;
  }

  /** Log-domain value to linear, -4096..4094. */
  private static expLookup(i: number): number {
    const t = EXP_TABLE[(i & 0xff) ^ 0xff] + 1024;
    const res = t >> ((i & 0x7f00) >> 8);
    return (i & 0x8000 ? ~res : res) << 1;
  }

  private toLinear(h: number, s: Slot, am: number): number {
    if (s.egOut > EG_MAX) return 0;
    const att = Math.min(EG_MUTE, s.egOut + s.tll + am) << 4;
    return VRC7.expLookup((h + att) & 0xffff);
  }

  /** One sample: the LFOs, every slot's envelope and phase, then the channels. */
  private tick(): void {
    // update_ampm. Both phases are reduced to their period, which changes
    // nothing they are used for and keeps them small.
    if (this.testFlag & 2) {
      this.pmPhase = 0;
      this.amPhase = 0;
    } else {
      this.pmPhase = (this.pmPhase + (this.testFlag & 8 ? 1024 : 1)) & 0x1fff;
      this.amPhase = (this.amPhase + (this.testFlag & 8 ? 64 : 1)) % (AM_TABLE.length * 64);
    }
    this.lfoAm = AM_TABLE[this.amPhase >> 6];

    // update_slots
    this.egCounter = (this.egCounter + 1) & 0xffff;
    const test = this.testFlag & 1;
    const reset = this.testFlag & 4;
    const slots = this.slots;
    for (let i = 0; i < 12; i++) {
      const s = slots[i];
      if (s.updateRequests) this.commitSlotUpdate(s);
      this.calcEnvelope(s, slots[i ^ 1], this.egCounter, test);
      this.calcPhase(s, reset);
    }

    for (let ch = 0; ch < 6; ch++) {
      const mod = slots[ch * 2];
      const car = slots[ch * 2 + 1];
      const mp = this.patches[mod.patch];
      const cp = this.patches[car.patch];

      const fb = mp.FB > 0 ? (mod.output1 + mod.output0) >> (9 - mp.FB) : 0;
      mod.output1 = mod.output0;
      mod.output0 = this.toLinear(
        WAVE_TABLES[mod.wave][(mod.pgOut + fb) & (PG_WIDTH - 1)],
        mod,
        mp.AM ? this.lfoAm : 0
      );

      const fm = mod.output0;
      car.output1 = car.output0;
      car.output0 = this.toLinear(
        WAVE_TABLES[car.wave][(car.pgOut + 2 * (fm >> 1)) & (PG_WIDTH - 1)],
        car,
        cp.AM ? this.lfoAm : 0
      );

      this.out[ch] = -car.output0 >> 1;
    }
  }

  /* -------------------------------------------------------- scheduling */

  /** CPU cycles until the output next changes. */
  cyclesToEvent(): number {
    return Math.ceil(this.countdown / 4096);
  }

  advance(cycles: number): void {
    this.countdown -= cycles * 4096;
    while (this.countdown <= 0) {
      this.tick();
      this.countdown += this.period;
    }
  }

  /* ----------------------------------------------------------- status */

  /** F-number, block, key and sustain of a channel, as its registers hold them. */
  channel(ch: number): { fnum: number; block: number; key: boolean; volume: number; patch: number } {
    const r = this.reg;
    return {
      fnum: ((r[0x20 + ch] & 1) << 8) | r[0x10 + ch],
      block: (r[0x20 + ch] >> 1) & 7,
      key: (r[0x20 + ch] & 0x10) !== 0,
      volume: r[0x30 + ch] & 15,
      patch: (r[0x30 + ch] >> 4) & 15,
    };
  }

  /** Envelope output of a channel's carrier: 0 is full level, 127 silence. */
  carrierEnvelope(ch: number): number {
    return this.slots[ch * 2 + 1].egOut;
  }
}
