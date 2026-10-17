/**
 * NSF / NSFe container parsing.
 *
 * Both containers describe the same thing - a chunk of 6502 code with an init
 * and a play entry point - so they are parsed into one shape. NSFe carries the
 * richer metadata (per-track titles, lengths, fades, a playlist), and an NSF2
 * file may append the very same chunks after its data, so the chunk reader is
 * shared between the two paths.
 */

/** Expansion sound chips a file declares. */
export interface NSFChips {
  vrc6: boolean;
  vrc7: boolean;
  fds: boolean;
  mmc5: boolean;
  n163: boolean;
  /** Sunsoft 5B. */
  s5b: boolean;
}

export type NSFRegion = "ntsc" | "pal" | "dual";

export interface NSFFile {
  format: "nsf" | "nsfe";
  /** NSF header version; 2 means the NSF2 extensions may be in use. */
  version: number;
  trackCount: number;
  /** Default track, zero-based. */
  startTrack: number;

  loadAddress: number;
  initAddress: number;
  playAddress: number;

  /** Play-routine period in microseconds, as the file states it. */
  ntscSpeedUs: number;
  palSpeedUs: number;
  region: NSFRegion;

  chips: NSFChips;
  /** Initial 4 KB bank values for $8000-$FFFF, or null when not bankswitched. */
  banks: Uint8Array | null;
  /** The 6502 image. */
  data: Uint8Array;

  title: string;
  artist: string;
  copyright: string;
  /** Who ripped the file; NSFe/NSF2 metadata only. */
  ripper: string;

  /** Per-track titles, where the file gives them. */
  trackLabels: (string | null)[];
  /** Per-track lengths in milliseconds, or null when unknown. */
  trackTimes: (number | null)[];
  /** Per-track fade lengths in milliseconds, or null when unknown. */
  trackFades: (number | null)[];
  /** Per-track authors, where the file gives them. */
  trackAuthors: (string | null)[];
  /** Track order to present, as track indices; empty when the file gives none. */
  playlist: number[];
  /** Free-form liner notes. */
  text: string;

  /** NSF2 feature flags byte, verbatim. */
  nsf2Flags: number;
  /** NSF2: the file's IRQ vector is its own to use. */
  irqSupport: boolean;
  /** NSF2: INIT need not return; the player must not wait for it. */
  nonReturningInit: boolean;
  /** NSF2: PLAY is never called - the music is driven by the file's own IRQ. */
  noPlayCalls: boolean;
}

const NSF_MAGIC = [0x4e, 0x45, 0x53, 0x4d, 0x1a]; // "NESM\x1a"
const NSFE_MAGIC = [0x4e, 0x53, 0x46, 0x45]; // "NSFE"

function hasMagic(data: Uint8Array, magic: number[]): boolean {
  if (data.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (data[i] !== magic[i]) return false;
  return true;
}

export function isNSFFile(data: Uint8Array): boolean {
  return hasMagic(data, NSF_MAGIC) || hasMagic(data, NSFE_MAGIC);
}

/**
 * Decode a metadata string. NSFe declares UTF-8, and the NSF header predates
 * any such statement - Japanese releases from the era are usually Shift_JIS -
 * so strict UTF-8 is tried first and the legacy encoding is the fallback.
 */
function decodeString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  const view = bytes.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(view);
    } catch {
      return new TextDecoder("latin1").decode(view);
    }
  }
}

function u16(data: Uint8Array, at: number): number {
  return data[at] | (data[at + 1] << 8);
}

function u32(data: Uint8Array, at: number): number {
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

function chipsFromByte(b: number): NSFChips {
  return {
    vrc6: (b & 0x01) !== 0,
    vrc7: (b & 0x02) !== 0,
    fds: (b & 0x04) !== 0,
    mmc5: (b & 0x08) !== 0,
    n163: (b & 0x10) !== 0,
    s5b: (b & 0x20) !== 0,
  };
}

function regionFromByte(b: number): NSFRegion {
  if (b & 0x02) return "dual";
  return b & 0x01 ? "pal" : "ntsc";
}

function emptyFile(): NSFFile {
  return {
    format: "nsf",
    version: 1,
    trackCount: 1,
    startTrack: 0,
    loadAddress: 0x8000,
    initAddress: 0x8000,
    playAddress: 0x8000,
    ntscSpeedUs: 16639,
    palSpeedUs: 19997,
    region: "ntsc",
    chips: chipsFromByte(0),
    banks: null,
    data: new Uint8Array(0),
    title: "",
    artist: "",
    copyright: "",
    ripper: "",
    trackLabels: [],
    trackTimes: [],
    trackFades: [],
    trackAuthors: [],
    playlist: [],
    text: "",
    nsf2Flags: 0,
    irqSupport: false,
    nonReturningInit: false,
    noPlayCalls: false,
  };
}

/** Split a run of NUL-terminated strings, as the NSFe list chunks store them. */
function stringList(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(decodeString(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start < bytes.length) out.push(decodeString(bytes.subarray(start)));
  return out;
}

/**
 * Read NSFe chunks into `out`. Used both for a real NSFe file and for the
 * metadata an NSF2 file may append after its data; `wantData` says whether a
 * DATA chunk should be taken (an NSF2 file already has its data).
 */
function readChunks(data: Uint8Array, at: number, out: NSFFile, wantData: boolean): void {
  while (at + 8 <= data.length) {
    const size = u32(data, at);
    const id = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    const body = data.subarray(at + 8, Math.min(at + 8 + size, data.length));
    at += 8 + size;

    switch (id) {
      case "INFO":
        out.loadAddress = u16(body, 0);
        out.initAddress = u16(body, 2);
        out.playAddress = u16(body, 4);
        out.region = regionFromByte(body[6]);
        out.chips = chipsFromByte(body[7]);
        if (body.length > 8) out.trackCount = body[8] || 1;
        if (body.length > 9) out.startTrack = body[9];
        break;
      case "DATA":
        if (wantData) out.data = body.slice();
        break;
      case "BANK": {
        const banks = new Uint8Array(8);
        for (let i = 0; i < 8 && i < body.length; i++) banks[i] = body[i];
        out.banks = banks.some((b) => b !== 0) ? banks : null;
        break;
      }
      case "RATE":
        // Region-specific play periods in microseconds: NTSC, then PAL and Dendy
        // where present.
        if (body.length >= 2) out.ntscSpeedUs = u16(body, 0);
        if (body.length >= 4) out.palSpeedUs = u16(body, 2);
        break;
      case "auth": {
        const s = stringList(body);
        out.title = s[0] ?? out.title;
        out.artist = s[1] ?? out.artist;
        out.copyright = s[2] ?? out.copyright;
        out.ripper = s[3] ?? out.ripper;
        break;
      }
      case "tlbl":
        out.trackLabels = stringList(body);
        break;
      case "taut":
        out.trackAuthors = stringList(body);
        break;
      case "time": {
        const n = Math.floor(body.length / 4);
        const times: (number | null)[] = [];
        for (let i = 0; i < n; i++) {
          const ms = u32(body, i * 4) | 0; // signed: negative means "unknown"
          times.push(ms < 0 ? null : ms);
        }
        out.trackTimes = times;
        break;
      }
      case "fade": {
        const n = Math.floor(body.length / 4);
        const fades: (number | null)[] = [];
        for (let i = 0; i < n; i++) {
          const ms = u32(body, i * 4) | 0;
          fades.push(ms < 0 ? null : ms);
        }
        out.trackFades = fades;
        break;
      }
      case "plst":
        out.playlist = Array.from(body);
        break;
      case "text":
        out.text = decodeString(body);
        break;
      case "NEND":
        return;
      default:
        // Unknown chunks are skippable unless the id starts with an uppercase
        // letter, which the format reserves for "you must understand this".
        // Nothing here is fatal for playback, so they are simply ignored.
        break;
    }
  }
}

function parseNSFHeader(data: Uint8Array): NSFFile {
  if (data.length < 0x80) throw new Error("nsf: file is shorter than its header");
  const out = emptyFile();
  out.format = "nsf";
  out.version = data[5];
  out.trackCount = data[6] || 1;
  out.startTrack = Math.max(0, data[7] - 1); // the header counts from one
  out.loadAddress = u16(data, 0x08);
  out.initAddress = u16(data, 0x0a);
  out.playAddress = u16(data, 0x0c);
  out.title = decodeString(data.subarray(0x0e, 0x2e));
  out.artist = decodeString(data.subarray(0x2e, 0x4e));
  out.copyright = decodeString(data.subarray(0x4e, 0x6e));
  out.ntscSpeedUs = u16(data, 0x6e) || 16639;
  const banks = data.subarray(0x70, 0x78);
  out.banks = banks.some((b) => b !== 0) ? banks.slice() : null;
  out.palSpeedUs = u16(data, 0x78) || 19997;
  out.region = regionFromByte(data[0x7a]);
  out.chips = chipsFromByte(data[0x7b]);
  out.nsf2Flags = data[0x7c];

  // NSF2 puts the length of the 6502 image in the three bytes the original
  // format left at zero. When it is set, whatever follows the image is NSFe
  // metadata; when it is zero the image runs to the end of the file.
  const declared = data[0x7d] | (data[0x7e] << 8) | (data[0x7f] << 16);
  const available = data.length - 0x80;
  const dataLength = out.version >= 2 && declared > 0 ? Math.min(declared, available) : available;
  out.data = data.slice(0x80, 0x80 + dataLength);

  if (out.version >= 2) {
    out.irqSupport = (out.nsf2Flags & 0x10) !== 0;
    out.nonReturningInit = (out.nsf2Flags & 0x20) !== 0;
    out.noPlayCalls = (out.nsf2Flags & 0x40) !== 0;
    if (dataLength < available) readChunks(data, 0x80 + dataLength, out, false);
  }
  return out;
}

function parseNSFe(data: Uint8Array): NSFFile {
  const out = emptyFile();
  out.format = "nsfe";
  out.version = 1;
  readChunks(data, 4, out, true);
  if (out.data.length === 0) throw new Error("nsfe: no DATA chunk");
  return out;
}

export function parseNSF(data: Uint8Array): NSFFile {
  if (hasMagic(data, NSFE_MAGIC)) return parseNSFe(data);
  if (hasMagic(data, NSF_MAGIC)) return parseNSFHeader(data);
  throw new Error("not an NSF or NSFe file");
}

/** Title of a track, falling back to a number when the file names none. */
export function trackTitle(file: NSFFile, track: number): string {
  const label = file.trackLabels[track];
  if (label != null && label !== "") return label;
  return `Track ${track + 1}`;
}
