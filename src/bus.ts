/**
 * The memory map an NSF plays in: RAM, the sound registers, the bank switching
 * registers at $5FF6-$5FFF, and the file's own image mapped in 4 KB pages.
 *
 * Everything from $6000 up is a list of 4 KB pages plus a mapping from CPU page
 * to bank, which is what the bank registers manipulate and what makes the FDS
 * case fall out: there $6000-$DFFF is RAM, so those pages are writable, and
 * because two CPU pages may select the same bank a write through one is seen
 * through the other, as on the hardware. The pages start as a copy of the file
 * image and are restored from it on reset, so a driver that has scribbled over
 * its own data area starts the next track clean.
 */

import { APU, type DMCHost } from "./apu.js";
import { FDS } from "./fds.js";
import { VRC6 } from "./vrc6.js";
import { VRC7 } from "./vrc7.js";
import { N163 } from "./n163.js";
import type { Bus6502 } from "./cpu6502.js";
import type { NSFFile } from "./nsf-file.js";

const PAGE_SIZE = 0x1000;

export class NSFBus implements Bus6502, DMCHost {
  readonly ram = new Uint8Array(0x800);
  readonly apu: APU;
  readonly fds: FDS | null;
  readonly vrc6: VRC6 | null;
  readonly vrc7: VRC7 | null;
  readonly n163: N163 | null;

  /** Pages of the file image, as the driver currently sees them. */
  private pages: Uint8Array[] = [];
  /** The same pages as loaded, for restoring on reset. */
  private pristine: Uint8Array[] = [];
  /** Bank selected for each CPU page; index 6 is $6000, index 15 is $F000. */
  private pageBank = new Int32Array(16);
  /** Whether a write to each CPU page reaches memory. */
  private pageWritable: boolean[] = new Array(16).fill(false);
  /** Read as zero; stands in for banks the file never provided. */
  private readonly voidPage = new Uint8Array(PAGE_SIZE);

  private readonly file: NSFFile;
  private readonly bankswitched: boolean;
  private readonly hasFDS: boolean;
  private readonly hasVRC6: boolean;
  /** Bank index of the first of the two work RAM pages, for non-FDS files. */
  private wramBank = -1;

  /** CPU cycles the DMC's DMA has stolen and not yet handed to the CPU. */
  private pendingStall = 0;

  constructor(file: NSFFile, pal: boolean) {
    this.file = file;
    this.hasFDS = file.chips.fds;
    this.hasVRC6 = file.chips.vrc6;
    this.bankswitched = file.banks !== null;
    this.apu = new APU(this, pal);
    this.fds = this.hasFDS ? new FDS() : null;
    this.vrc6 = this.hasVRC6 ? new VRC6() : null;
    this.vrc7 = file.chips.vrc7 ? new VRC7(pal) : null;
    this.n163 = file.chips.n163 ? new N163() : null;
    this.buildPages();
    this.reset();
  }

  private buildPages(): void {
    const { data, loadAddress } = this.file;
    if (this.bankswitched) {
      // The low bits of the load address say how much padding sits in front of
      // bank zero.
      const pad = loadAddress & 0x0fff;
      const total = Math.max(1, Math.ceil((pad + data.length) / PAGE_SIZE));
      for (let i = 0; i < total; i++) {
        const page = new Uint8Array(PAGE_SIZE);
        const start = i * PAGE_SIZE - pad;
        for (let j = 0; j < PAGE_SIZE; j++) {
          const src = start + j;
          if (src >= 0 && src < data.length) page[j] = data[src];
        }
        this.pristine.push(page);
      }
    } else {
      // Not bankswitched: the image sits at its load address in a flat 64 KB
      // and every CPU page selects the bank of the same number.
      const flat = new Uint8Array(0x10000);
      const room = Math.max(0, 0x10000 - loadAddress);
      flat.set(data.subarray(0, Math.min(data.length, room)), loadAddress);
      for (let i = 0; i < 16; i++) {
        this.pristine.push(flat.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
      }
    }

    if (!this.hasFDS) {
      // $6000-$7FFF is work RAM the file does not supply, so give it two pages
      // of its own rather than letting a bank show through.
      this.wramBank = this.pristine.length;
      this.pristine.push(new Uint8Array(PAGE_SIZE), new Uint8Array(PAGE_SIZE));
    }

    this.pages = this.pristine.map((p) => p.slice());
  }

  /** Put memory and the bank map back to the state the header asks for. */
  reset(): void {
    this.ram.fill(0);
    this.pendingStall = 0;
    // Unlike the 2A03, whose registers the player clears before INIT, the FM
    // chip has internal state no register write reaches - envelopes, phases -
    // so it is reset outright.
    this.vrc7?.reset();
    this.n163?.reset();
    for (let i = 0; i < this.pages.length; i++) this.pages[i].set(this.pristine[i]);

    for (let p = 0; p < 16; p++) this.pageBank[p] = -1;
    this.pageWritable.fill(false);

    if (this.bankswitched) {
      const banks = this.file.banks!;
      for (let i = 0; i < 8; i++) this.pageBank[8 + i] = banks[i];
      if (this.hasFDS) {
        // With the FDS the last two header values do double duty: they also
        // select the banks that appear at $6000 and $7000.
        this.pageBank[6] = banks[6];
        this.pageBank[7] = banks[7];
      }
    } else {
      for (let p = 8; p < 16; p++) this.pageBank[p] = p;
      if (this.hasFDS) {
        this.pageBank[6] = 6;
        this.pageBank[7] = 7;
      }
    }

    if (this.hasFDS) {
      // On an FDS, $6000-$DFFF is RAM: the image there is a starting state the
      // driver is free to overwrite. $E000 up is the BIOS area and stays read
      // only.
      for (let p = 6; p <= 13; p++) this.pageWritable[p] = true;
    } else {
      this.pageBank[6] = this.wramBank;
      this.pageBank[7] = this.wramBank + 1;
      this.pageWritable[6] = true;
      this.pageWritable[7] = true;
    }
  }

  private pageOf(cpuPage: number): Uint8Array {
    const bank = this.pageBank[cpuPage];
    if (bank < 0 || bank >= this.pages.length) return this.voidPage;
    return this.pages[bank];
  }

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr < 0x4000) return 0; // no PPU in an NSF
    if (addr < 0x4020) return addr === 0x4015 ? this.apu.read(addr) : 0;
    if (addr < 0x6000) {
      if (this.fds && addr >= 0x4040 && addr <= 0x409f) return this.fds.read(addr);
      if (this.n163 && addr >= 0x4800 && addr < 0x5000) return this.n163.readData();
      return 0;
    }
    return this.pageOf(addr >> 12)[addr & 0x0fff];
  }

  write(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ram[addr & 0x7ff] = value;
      return;
    }
    if (addr < 0x4000) return; // PPU
    if (addr < 0x4020) {
      if (addr <= 0x4017) this.apu.write(addr, value);
      return;
    }
    if (addr < 0x6000) {
      if (this.fds && addr >= 0x4040 && addr <= 0x409f) {
        this.fds.write(addr, value);
        return;
      }
      if (this.n163 && addr >= 0x4800 && addr < 0x5000) {
        this.n163.writeData(value);
        return;
      }
      if (addr >= 0x5ff6 && addr <= 0x5fff) {
        const page = addr - 0x5ff6 + 6;
        // $5FF6 and $5FF7 only exist when the FDS is present.
        if (page >= 8 || this.hasFDS) this.pageBank[page] = value;
      }
      return;
    }
    // The VRC6's registers sit inside the cartridge's own address space, so they
    // are claimed before the write can reach memory.
    if (this.vrc6 != null && addr >= 0x9000 && addr < 0xc000) {
      const block = addr & 0xf000;
      if (block === 0x9000 || block === 0xa000 || block === 0xb000) {
        this.vrc6.write(addr, value);
        return;
      }
    }
    // The VRC7's two ports: $9010 latches a register number, $9030 writes it.
    if (this.vrc7 != null) {
      const port = addr & 0xf030;
      if (port === 0x9010 || port === 0x9030) {
        this.vrc7.write(addr, value);
        return;
      }
    }
    // The N163's address port is the top 2 KB, above any RAM an NSF can have.
    if (this.n163 != null && addr >= 0xf800) {
      this.n163.writeAddress(value);
      return;
    }
    const page = addr >> 12;
    if (this.pageWritable[page]) this.pageOf(page)[addr & 0x0fff] = value;
  }

  /** Load the header's banks, as the player does before calling INIT. */
  applyInitialBanks(): void {
    if (!this.bankswitched) return;
    const banks = this.file.banks!;
    for (let i = 0; i < 8; i++) this.write(0x5ff8 + i, banks[i]);
    if (this.hasFDS) {
      this.write(0x5ff6, banks[6]);
      this.write(0x5ff7, banks[7]);
    }
  }

  // --- DMCHost ---

  dmcRead(addr: number): number {
    return this.read(addr & 0xffff);
  }

  dmcStall(cycles: number): void {
    this.pendingStall += cycles;
  }

  /** Take the cycles the DMC has stolen since this was last called. */
  takeStall(): number {
    const n = this.pendingStall;
    this.pendingStall = 0;
    return n;
  }

  /** Pages a state snapshot has to carry: the ones a driver can write. */
  writableBanks(): number[] {
    const out: number[] = [];
    for (let p = 6; p < 16; p++) {
      const bank = this.pageBank[p];
      if (this.pageWritable[p] && bank >= 0 && bank < this.pages.length && !out.includes(bank)) {
        out.push(bank);
      }
    }
    return out;
  }

  bankData(bank: number): Uint8Array {
    return this.pages[bank];
  }

  get bankMap(): Int32Array {
    return this.pageBank;
  }
}
