/**
 * NMOS 6502 core, cycle-counting, written from the published instruction set.
 *
 * Targets the 2A03/2A07 found in the NES, so BCD is absent: the decimal flag is
 * stored and restored (drivers do push and pull it) but ADC/SBC ignore it, as
 * on the real chip.
 *
 * Timing granularity is one instruction: `step()` performs a whole instruction
 * and returns the cycles it took, including page-crossing and branch penalties.
 * That is enough for a sound player - nothing here observes mid-instruction bus
 * state - and it keeps the interpreter loop tight. DMC DMA is accounted for by
 * `stall()`, which adds cycles the way the DMA unit steals them from the CPU.
 */

export interface Bus6502 {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

/**
 * Cycles each opcode takes with no penalty applied. Page-crossing reads and
 * taken branches add to these; read-modify-write and store forms already
 * include the cycle the real chip always spends on them.
 */
const BASE_CYCLES = /* prettier-ignore */ new Uint8Array([
  7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, // 0x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 1x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, // 2x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 3x
  6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, // 4x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 5x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, // 6x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 7x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // 8x
  2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5, // 9x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // Ax
  2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4, // Bx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // Cx
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // Dx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // Ex
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // Fx
]);

/** Value the unstable magic-constant opcodes AND into the accumulator. */
const MAGIC = 0xee;

export interface CPUState {
  a: number;
  x: number;
  y: number;
  s: number;
  pc: number;
  p: number;
  jammed: boolean;
}

export class CPU6502 {
  private bus: Bus6502;

  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer, low byte of $01xx. */
  s = 0xfd;
  pc = 0;

  // Status bits, each held as 0 or 1.
  fc = 0;
  fz = 0;
  fi = 1;
  fd = 0;
  fv = 0;
  fn = 0;

  /** True once a JAM opcode has halted the processor. */
  jammed = false;

  /** Edge-triggered NMI, latched until taken. */
  nmiPending = false;
  /** Level-triggered IRQ: whatever the devices currently assert. */
  irqLine = false;

  /** Cycles owed to DMA, paid at the start of the next instruction. */
  private stallCycles = 0;
  /** Penalty cycles accumulated by the instruction in flight. */
  private extra = 0;

  constructor(bus: Bus6502) {
    this.bus = bus;
  }

  reset(): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.s = 0xfd;
    this.fc = 0;
    this.fz = 0;
    this.fi = 1;
    this.fd = 0;
    this.fv = 0;
    this.fn = 0;
    this.jammed = false;
    this.nmiPending = false;
    this.irqLine = false;
    this.stallCycles = 0;
    this.pc = this.rd16(0xfffc);
  }

  /** Steal `n` cycles from the CPU, as the DMC's DMA unit does. */
  stall(n: number): void {
    this.stallCycles += n;
  }

  get p(): number {
    return (
      this.fc | (this.fz << 1) | (this.fi << 2) | (this.fd << 3) | 0x20 | (this.fv << 6) | (this.fn << 7)
    );
  }

  set p(v: number) {
    this.fc = v & 1;
    this.fz = (v >> 1) & 1;
    this.fi = (v >> 2) & 1;
    this.fd = (v >> 3) & 1;
    this.fv = (v >> 6) & 1;
    this.fn = (v >> 7) & 1;
  }

  saveState(): CPUState {
    return { a: this.a, x: this.x, y: this.y, s: this.s, pc: this.pc, p: this.p, jammed: this.jammed };
  }

  loadState(st: CPUState): void {
    this.a = st.a;
    this.x = st.x;
    this.y = st.y;
    this.s = st.s;
    this.pc = st.pc;
    this.p = st.p;
    this.jammed = st.jammed;
  }

  // --- bus helpers -------------------------------------------------------

  private rd(addr: number): number {
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, value: number): void {
    this.bus.write(addr & 0xffff, value & 0xff);
  }

  private rd16(addr: number): number {
    return this.rd(addr) | (this.rd(addr + 1) << 8);
  }

  private fetch(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private push(v: number): void {
    this.wr(0x100 | this.s, v);
    this.s = (this.s - 1) & 0xff;
  }

  /** Push a 16-bit value, high byte first, as the interrupt sequence does. */
  push2(value: number): void {
    this.push((value >> 8) & 0xff);
    this.push(value & 0xff);
  }

  private pop(): number {
    this.s = (this.s + 1) & 0xff;
    return this.rd(0x100 | this.s);
  }

  // --- addressing --------------------------------------------------------

  private zp(): number {
    return this.fetch();
  }

  private zpx(): number {
    return (this.fetch() + this.x) & 0xff;
  }

  private zpy(): number {
    return (this.fetch() + this.y) & 0xff;
  }

  private abs(): number {
    return this.fetch() | (this.fetch() << 8);
  }

  /** `pen` is set for read-only forms, which pay a cycle when the index
   *  carries into a new page; stores and RMWs pay it unconditionally and have
   *  it folded into BASE_CYCLES. */
  private absx(pen: boolean): number {
    const base = this.abs();
    const addr = (base + this.x) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  private absy(pen: boolean): number {
    const base = this.abs();
    const addr = (base + this.y) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  /** (zp,X): the pointer is fetched from page zero and wraps within it. */
  private indx(): number {
    const p = (this.fetch() + this.x) & 0xff;
    return this.rd(p) | (this.rd((p + 1) & 0xff) << 8);
  }

  /** (zp),Y */
  private indy(pen: boolean): number {
    const p = this.fetch();
    const base = this.rd(p) | (this.rd((p + 1) & 0xff) << 8);
    const addr = (base + this.y) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  // --- flag helpers ------------------------------------------------------

  private setNZ(v: number): number {
    const b = v & 0xff;
    this.fz = b === 0 ? 1 : 0;
    this.fn = b >> 7;
    return b;
  }

  private branch(take: boolean): void {
    const off = (this.fetch() << 24) >> 24; // sign-extend
    if (!take) return;
    const target = (this.pc + off) & 0xffff;
    this.extra += (this.pc & 0xff00) !== (target & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  private adc(v: number): void {
    const sum = this.a + v + this.fc;
    this.fc = sum > 0xff ? 1 : 0;
    this.fv = (~(this.a ^ v) & (this.a ^ sum) & 0x80) !== 0 ? 1 : 0;
    this.a = this.setNZ(sum);
  }

  private sbc(v: number): void {
    this.adc(v ^ 0xff);
  }

  private cmp(reg: number, v: number): void {
    const d = reg - v;
    this.fc = d >= 0 ? 1 : 0;
    this.setNZ(d);
  }

  private aslMem(addr: number): number {
    const v = this.rd(addr);
    this.fc = v >> 7;
    const r = this.setNZ(v << 1);
    this.wr(addr, r);
    return r;
  }

  private lsrMem(addr: number): number {
    const v = this.rd(addr);
    this.fc = v & 1;
    const r = this.setNZ(v >> 1);
    this.wr(addr, r);
    return r;
  }

  private rolMem(addr: number): number {
    const v = this.rd(addr);
    const c = this.fc;
    this.fc = v >> 7;
    const r = this.setNZ((v << 1) | c);
    this.wr(addr, r);
    return r;
  }

  private rorMem(addr: number): number {
    const v = this.rd(addr);
    const c = this.fc;
    this.fc = v & 1;
    const r = this.setNZ((v >> 1) | (c << 7));
    this.wr(addr, r);
    return r;
  }

  // --- interrupts --------------------------------------------------------

  private interrupt(vector: number, brk: boolean): void {
    if (brk) this.pc = (this.pc + 1) & 0xffff;
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push(brk ? this.p | 0x10 : this.p);
    this.fi = 1;
    this.pc = this.rd16(vector);
  }

  /**
   * Execute one instruction, or take a pending interrupt.
   *
   * Returns the cycles consumed, including any DMA stall paid off here. A
   * jammed CPU reports cycles passing without doing anything, so a caller
   * driving the APU by CPU cycles keeps producing sound.
   */
  step(): number {
    const stall = this.stallCycles;
    this.stallCycles = 0;

    if (this.jammed) return stall + 2;

    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xfffa, false);
      return stall + 7;
    }
    if (this.irqLine && this.fi === 0) {
      this.interrupt(0xfffe, false);
      return stall + 7;
    }

    this.extra = 0;
    const op = this.fetch();
    let addr = 0;
    let v = 0;

    switch (op) {
      // --- load / store ---
      case 0xa9: this.a = this.setNZ(this.fetch()); break;                       // LDA #
      case 0xa5: this.a = this.setNZ(this.rd(this.zp())); break;
      case 0xb5: this.a = this.setNZ(this.rd(this.zpx())); break;
      case 0xad: this.a = this.setNZ(this.rd(this.abs())); break;
      case 0xbd: this.a = this.setNZ(this.rd(this.absx(true))); break;
      case 0xb9: this.a = this.setNZ(this.rd(this.absy(true))); break;
      case 0xa1: this.a = this.setNZ(this.rd(this.indx())); break;
      case 0xb1: this.a = this.setNZ(this.rd(this.indy(true))); break;

      case 0xa2: this.x = this.setNZ(this.fetch()); break;                       // LDX #
      case 0xa6: this.x = this.setNZ(this.rd(this.zp())); break;
      case 0xb6: this.x = this.setNZ(this.rd(this.zpy())); break;
      case 0xae: this.x = this.setNZ(this.rd(this.abs())); break;
      case 0xbe: this.x = this.setNZ(this.rd(this.absy(true))); break;

      case 0xa0: this.y = this.setNZ(this.fetch()); break;                       // LDY #
      case 0xa4: this.y = this.setNZ(this.rd(this.zp())); break;
      case 0xb4: this.y = this.setNZ(this.rd(this.zpx())); break;
      case 0xac: this.y = this.setNZ(this.rd(this.abs())); break;
      case 0xbc: this.y = this.setNZ(this.rd(this.absx(true))); break;

      case 0x85: this.wr(this.zp(), this.a); break;                              // STA
      case 0x95: this.wr(this.zpx(), this.a); break;
      case 0x8d: this.wr(this.abs(), this.a); break;
      case 0x9d: this.wr(this.absx(false), this.a); break;
      case 0x99: this.wr(this.absy(false), this.a); break;
      case 0x81: this.wr(this.indx(), this.a); break;
      case 0x91: this.wr(this.indy(false), this.a); break;

      case 0x86: this.wr(this.zp(), this.x); break;                              // STX
      case 0x96: this.wr(this.zpy(), this.x); break;
      case 0x8e: this.wr(this.abs(), this.x); break;

      case 0x84: this.wr(this.zp(), this.y); break;                              // STY
      case 0x94: this.wr(this.zpx(), this.y); break;
      case 0x8c: this.wr(this.abs(), this.y); break;

      // --- transfers ---
      case 0xaa: this.x = this.setNZ(this.a); break;                             // TAX
      case 0xa8: this.y = this.setNZ(this.a); break;                             // TAY
      case 0x8a: this.a = this.setNZ(this.x); break;                             // TXA
      case 0x98: this.a = this.setNZ(this.y); break;                             // TYA
      case 0xba: this.x = this.setNZ(this.s); break;                             // TSX
      case 0x9a: this.s = this.x; break;                                         // TXS

      // --- stack ---
      case 0x48: this.push(this.a); break;                                       // PHA
      case 0x68: this.a = this.setNZ(this.pop()); break;                         // PLA
      case 0x08: this.push(this.p | 0x10); break;                                // PHP
      case 0x28: this.p = this.pop(); break;                                     // PLP

      // --- logic ---
      case 0x29: this.a = this.setNZ(this.a & this.fetch()); break;              // AND
      case 0x25: this.a = this.setNZ(this.a & this.rd(this.zp())); break;
      case 0x35: this.a = this.setNZ(this.a & this.rd(this.zpx())); break;
      case 0x2d: this.a = this.setNZ(this.a & this.rd(this.abs())); break;
      case 0x3d: this.a = this.setNZ(this.a & this.rd(this.absx(true))); break;
      case 0x39: this.a = this.setNZ(this.a & this.rd(this.absy(true))); break;
      case 0x21: this.a = this.setNZ(this.a & this.rd(this.indx())); break;
      case 0x31: this.a = this.setNZ(this.a & this.rd(this.indy(true))); break;

      case 0x09: this.a = this.setNZ(this.a | this.fetch()); break;              // ORA
      case 0x05: this.a = this.setNZ(this.a | this.rd(this.zp())); break;
      case 0x15: this.a = this.setNZ(this.a | this.rd(this.zpx())); break;
      case 0x0d: this.a = this.setNZ(this.a | this.rd(this.abs())); break;
      case 0x1d: this.a = this.setNZ(this.a | this.rd(this.absx(true))); break;
      case 0x19: this.a = this.setNZ(this.a | this.rd(this.absy(true))); break;
      case 0x01: this.a = this.setNZ(this.a | this.rd(this.indx())); break;
      case 0x11: this.a = this.setNZ(this.a | this.rd(this.indy(true))); break;

      case 0x49: this.a = this.setNZ(this.a ^ this.fetch()); break;              // EOR
      case 0x45: this.a = this.setNZ(this.a ^ this.rd(this.zp())); break;
      case 0x55: this.a = this.setNZ(this.a ^ this.rd(this.zpx())); break;
      case 0x4d: this.a = this.setNZ(this.a ^ this.rd(this.abs())); break;
      case 0x5d: this.a = this.setNZ(this.a ^ this.rd(this.absx(true))); break;
      case 0x59: this.a = this.setNZ(this.a ^ this.rd(this.absy(true))); break;
      case 0x41: this.a = this.setNZ(this.a ^ this.rd(this.indx())); break;
      case 0x51: this.a = this.setNZ(this.a ^ this.rd(this.indy(true))); break;

      case 0x24:                                                                 // BIT
      case 0x2c: {
        v = this.rd(op === 0x24 ? this.zp() : this.abs());
        this.fz = (this.a & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        break;
      }

      // --- arithmetic ---
      case 0x69: this.adc(this.fetch()); break;                                  // ADC
      case 0x65: this.adc(this.rd(this.zp())); break;
      case 0x75: this.adc(this.rd(this.zpx())); break;
      case 0x6d: this.adc(this.rd(this.abs())); break;
      case 0x7d: this.adc(this.rd(this.absx(true))); break;
      case 0x79: this.adc(this.rd(this.absy(true))); break;
      case 0x61: this.adc(this.rd(this.indx())); break;
      case 0x71: this.adc(this.rd(this.indy(true))); break;

      case 0xe9:
      case 0xeb: this.sbc(this.fetch()); break;                                  // SBC # (0xEB unofficial)
      case 0xe5: this.sbc(this.rd(this.zp())); break;
      case 0xf5: this.sbc(this.rd(this.zpx())); break;
      case 0xed: this.sbc(this.rd(this.abs())); break;
      case 0xfd: this.sbc(this.rd(this.absx(true))); break;
      case 0xf9: this.sbc(this.rd(this.absy(true))); break;
      case 0xe1: this.sbc(this.rd(this.indx())); break;
      case 0xf1: this.sbc(this.rd(this.indy(true))); break;

      case 0xc9: this.cmp(this.a, this.fetch()); break;                          // CMP
      case 0xc5: this.cmp(this.a, this.rd(this.zp())); break;
      case 0xd5: this.cmp(this.a, this.rd(this.zpx())); break;
      case 0xcd: this.cmp(this.a, this.rd(this.abs())); break;
      case 0xdd: this.cmp(this.a, this.rd(this.absx(true))); break;
      case 0xd9: this.cmp(this.a, this.rd(this.absy(true))); break;
      case 0xc1: this.cmp(this.a, this.rd(this.indx())); break;
      case 0xd1: this.cmp(this.a, this.rd(this.indy(true))); break;

      case 0xe0: this.cmp(this.x, this.fetch()); break;                          // CPX
      case 0xe4: this.cmp(this.x, this.rd(this.zp())); break;
      case 0xec: this.cmp(this.x, this.rd(this.abs())); break;

      case 0xc0: this.cmp(this.y, this.fetch()); break;                          // CPY
      case 0xc4: this.cmp(this.y, this.rd(this.zp())); break;
      case 0xcc: this.cmp(this.y, this.rd(this.abs())); break;

      // --- increment / decrement ---
      case 0xe6: addr = this.zp(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;      // INC
      case 0xf6: addr = this.zpx(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;
      case 0xee: addr = this.abs(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;
      case 0xfe: addr = this.absx(false); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;

      case 0xc6: addr = this.zp(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;      // DEC
      case 0xd6: addr = this.zpx(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;
      case 0xce: addr = this.abs(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;
      case 0xde: addr = this.absx(false); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;

      case 0xe8: this.x = this.setNZ(this.x + 1); break;                         // INX
      case 0xc8: this.y = this.setNZ(this.y + 1); break;                         // INY
      case 0xca: this.x = this.setNZ(this.x - 1); break;                         // DEX
      case 0x88: this.y = this.setNZ(this.y - 1); break;                         // DEY

      // --- shifts ---
      case 0x0a: this.fc = this.a >> 7; this.a = this.setNZ(this.a << 1); break;             // ASL A
      case 0x06: this.aslMem(this.zp()); break;
      case 0x16: this.aslMem(this.zpx()); break;
      case 0x0e: this.aslMem(this.abs()); break;
      case 0x1e: this.aslMem(this.absx(false)); break;

      case 0x4a: this.fc = this.a & 1; this.a = this.setNZ(this.a >> 1); break;              // LSR A
      case 0x46: this.lsrMem(this.zp()); break;
      case 0x56: this.lsrMem(this.zpx()); break;
      case 0x4e: this.lsrMem(this.abs()); break;
      case 0x5e: this.lsrMem(this.absx(false)); break;

      case 0x2a: {                                                               // ROL A
        const c = this.fc;
        this.fc = this.a >> 7;
        this.a = this.setNZ((this.a << 1) | c);
        break;
      }
      case 0x26: this.rolMem(this.zp()); break;
      case 0x36: this.rolMem(this.zpx()); break;
      case 0x2e: this.rolMem(this.abs()); break;
      case 0x3e: this.rolMem(this.absx(false)); break;

      case 0x6a: {                                                               // ROR A
        const c = this.fc;
        this.fc = this.a & 1;
        this.a = this.setNZ((this.a >> 1) | (c << 7));
        break;
      }
      case 0x66: this.rorMem(this.zp()); break;
      case 0x76: this.rorMem(this.zpx()); break;
      case 0x6e: this.rorMem(this.abs()); break;
      case 0x7e: this.rorMem(this.absx(false)); break;

      // --- jumps / branches ---
      case 0x4c: this.pc = this.abs(); break;                                    // JMP abs
      case 0x6c: {                                                              // JMP (ind), with the page-wrap bug
        const p = this.abs();
        this.pc = this.rd(p) | (this.rd((p & 0xff00) | ((p + 1) & 0xff)) << 8);
        break;
      }
      case 0x20: {                                                              // JSR
        const target = this.abs();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: this.pc = (this.pop() | (this.pop() << 8)) + 1 & 0xffff; break; // RTS
      case 0x40: {                                                              // RTI
        this.p = this.pop();
        this.pc = this.pop() | (this.pop() << 8);
        break;
      }
      case 0x00: this.interrupt(0xfffe, true); break;                            // BRK

      case 0x10: this.branch(this.fn === 0); break;                              // BPL
      case 0x30: this.branch(this.fn === 1); break;                              // BMI
      case 0x50: this.branch(this.fv === 0); break;                              // BVC
      case 0x70: this.branch(this.fv === 1); break;                              // BVS
      case 0x90: this.branch(this.fc === 0); break;                              // BCC
      case 0xb0: this.branch(this.fc === 1); break;                              // BCS
      case 0xd0: this.branch(this.fz === 0); break;                              // BNE
      case 0xf0: this.branch(this.fz === 1); break;                              // BEQ

      // --- flags ---
      case 0x18: this.fc = 0; break;                                             // CLC
      case 0x38: this.fc = 1; break;                                             // SEC
      case 0x58: this.fi = 0; break;                                             // CLI
      case 0x78: this.fi = 1; break;                                             // SEI
      case 0xb8: this.fv = 0; break;                                             // CLV
      case 0xd8: this.fd = 0; break;                                             // CLD
      case 0xf8: this.fd = 1; break;                                             // SED

      // --- official NOP and its undocumented twins ---
      case 0xea:                                                                 // NOP
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
        break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2:                     // NOP #
        this.fetch();
        break;
      case 0x04: case 0x44: case 0x64:                                           // NOP zp
        this.zp();
        break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:          // NOP zp,X
        this.zpx();
        break;
      case 0x0c:                                                                 // NOP abs
        this.rd(this.abs());
        break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:          // NOP abs,X
        this.rd(this.absx(true));
        break;

      // --- undocumented: read-modify-write combinations ---
      case 0x07: this.a = this.setNZ(this.a | this.aslMem(this.zp())); break;             // SLO
      case 0x17: this.a = this.setNZ(this.a | this.aslMem(this.zpx())); break;
      case 0x0f: this.a = this.setNZ(this.a | this.aslMem(this.abs())); break;
      case 0x1f: this.a = this.setNZ(this.a | this.aslMem(this.absx(false))); break;
      case 0x1b: this.a = this.setNZ(this.a | this.aslMem(this.absy(false))); break;
      case 0x03: this.a = this.setNZ(this.a | this.aslMem(this.indx())); break;
      case 0x13: this.a = this.setNZ(this.a | this.aslMem(this.indy(false))); break;

      case 0x27: this.a = this.setNZ(this.a & this.rolMem(this.zp())); break;             // RLA
      case 0x37: this.a = this.setNZ(this.a & this.rolMem(this.zpx())); break;
      case 0x2f: this.a = this.setNZ(this.a & this.rolMem(this.abs())); break;
      case 0x3f: this.a = this.setNZ(this.a & this.rolMem(this.absx(false))); break;
      case 0x3b: this.a = this.setNZ(this.a & this.rolMem(this.absy(false))); break;
      case 0x23: this.a = this.setNZ(this.a & this.rolMem(this.indx())); break;
      case 0x33: this.a = this.setNZ(this.a & this.rolMem(this.indy(false))); break;

      case 0x47: this.a = this.setNZ(this.a ^ this.lsrMem(this.zp())); break;             // SRE
      case 0x57: this.a = this.setNZ(this.a ^ this.lsrMem(this.zpx())); break;
      case 0x4f: this.a = this.setNZ(this.a ^ this.lsrMem(this.abs())); break;
      case 0x5f: this.a = this.setNZ(this.a ^ this.lsrMem(this.absx(false))); break;
      case 0x5b: this.a = this.setNZ(this.a ^ this.lsrMem(this.absy(false))); break;
      case 0x43: this.a = this.setNZ(this.a ^ this.lsrMem(this.indx())); break;
      case 0x53: this.a = this.setNZ(this.a ^ this.lsrMem(this.indy(false))); break;

      case 0x67: this.adc(this.rorMem(this.zp())); break;                                 // RRA
      case 0x77: this.adc(this.rorMem(this.zpx())); break;
      case 0x6f: this.adc(this.rorMem(this.abs())); break;
      case 0x7f: this.adc(this.rorMem(this.absx(false))); break;
      case 0x7b: this.adc(this.rorMem(this.absy(false))); break;
      case 0x63: this.adc(this.rorMem(this.indx())); break;
      case 0x73: this.adc(this.rorMem(this.indy(false))); break;

      case 0xc7: addr = this.zp(); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break; // DCP
      case 0xd7: addr = this.zpx(); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;
      case 0xcf: addr = this.abs(); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;
      case 0xdf: addr = this.absx(false); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;
      case 0xdb: addr = this.absy(false); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;
      case 0xc3: addr = this.indx(); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;
      case 0xd3: addr = this.indy(false); v = this.setNZ(this.rd(addr) - 1); this.wr(addr, v); this.cmp(this.a, v); break;

      case 0xe7: addr = this.zp(); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;         // ISB
      case 0xf7: addr = this.zpx(); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;
      case 0xef: addr = this.abs(); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;
      case 0xff: addr = this.absx(false); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;
      case 0xfb: addr = this.absy(false); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;
      case 0xe3: addr = this.indx(); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;
      case 0xf3: addr = this.indy(false); v = this.setNZ(this.rd(addr) + 1); this.wr(addr, v); this.sbc(v); break;

      // --- undocumented: loads and stores ---
      case 0xa7: this.a = this.x = this.setNZ(this.rd(this.zp())); break;                  // LAX
      case 0xb7: this.a = this.x = this.setNZ(this.rd(this.zpy())); break;
      case 0xaf: this.a = this.x = this.setNZ(this.rd(this.abs())); break;
      case 0xbf: this.a = this.x = this.setNZ(this.rd(this.absy(true))); break;
      case 0xa3: this.a = this.x = this.setNZ(this.rd(this.indx())); break;
      case 0xb3: this.a = this.x = this.setNZ(this.rd(this.indy(true))); break;

      case 0x87: this.wr(this.zp(), this.a & this.x); break;                               // SAX
      case 0x97: this.wr(this.zpy(), this.a & this.x); break;
      case 0x8f: this.wr(this.abs(), this.a & this.x); break;
      case 0x83: this.wr(this.indx(), this.a & this.x); break;

      // --- undocumented: immediate ---
      case 0x0b: case 0x2b:                                                               // ANC #
        this.a = this.setNZ(this.a & this.fetch());
        this.fc = this.fn;
        break;
      case 0x4b:                                                                          // ALR #
        this.a = this.a & this.fetch();
        this.fc = this.a & 1;
        this.a = this.setNZ(this.a >> 1);
        break;
      case 0x6b: {                                                                        // ARR #
        this.a = this.a & this.fetch();
        const c = this.fc;
        const r = this.setNZ((this.a >> 1) | (c << 7));
        this.fc = (r >> 6) & 1;
        this.fv = ((r >> 6) ^ (r >> 5)) & 1;
        this.a = r;
        break;
      }
      case 0xcb: {                                                                        // SBX #
        const t = (this.a & this.x) - this.fetch();
        this.fc = t >= 0 ? 1 : 0;
        this.x = this.setNZ(t);
        break;
      }
      case 0x8b:                                                                          // ANE # (unstable)
        this.a = this.setNZ((this.a | MAGIC) & this.x & this.fetch());
        break;
      case 0xab:                                                                          // LXA # (unstable)
        this.a = this.x = this.setNZ((this.a | MAGIC) & this.fetch());
        break;

      // --- undocumented: the high-byte stores (unstable on hardware) ---
      case 0x9f: addr = this.absy(false); this.wr(addr, this.a & this.x & ((addr >> 8) + 1)); break; // SHA abs,Y
      case 0x93: addr = this.indy(false); this.wr(addr, this.a & this.x & ((addr >> 8) + 1)); break; // SHA (zp),Y
      case 0x9e: addr = this.absy(false); this.wr(addr, this.x & ((addr >> 8) + 1)); break;          // SHX
      case 0x9c: addr = this.absx(false); this.wr(addr, this.y & ((addr >> 8) + 1)); break;          // SHY
      case 0x9b:                                                                                    // SHS
        addr = this.absy(false);
        this.s = this.a & this.x;
        this.wr(addr, this.s & ((addr >> 8) + 1));
        break;
      case 0xbb:                                                                                    // LAS
        this.a = this.x = this.s = this.setNZ(this.rd(this.absy(true)) & this.s);
        break;

      // --- JAM: the processor stops fetching ---
      default:
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        break;
    }

    return stall + BASE_CYCLES[op] + this.extra;
  }
}
