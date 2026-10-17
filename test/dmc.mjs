// The DMC has no coverage in the sample files, so this builds an NSF by hand
// that does nothing but play a looping delta sample. It exercises the memory
// reader, the DMA stall, the output unit and the bank-free load path at once.
//
//   node test/dmc.mjs [out.wav]

import { writeFileSync } from "node:fs";
import { NSFPlayer, parseNSF, CH_DMC } from "../dist/index.js";

const LOAD = 0x8000;
const image = new Uint8Array(0x10000 - LOAD);
const at = (addr) => addr - LOAD;

// INIT: point the DMC at $C000, give it a length, and switch it on.
const init = [
  0xa9, 0x4f, 0x8d, 0x10, 0x40, // LDA #$4F  STA $4010   loop, slowest rate
  0xa9, 0x00, 0x8d, 0x12, 0x40, // LDA #$00  STA $4012   sample at $C000
  0xa9, 0xff, 0x8d, 0x13, 0x40, // LDA #$FF  STA $4013   4081 bytes
  0xa9, 0x10, 0x8d, 0x15, 0x40, // LDA #$10  STA $4015   enable DMC
  0x60, // RTS
];
image.set(init, at(0x8000));
image.set([0x60], at(0x8100)); // PLAY: nothing to do

// A sample whose deltas walk up for four bits and down for four: the DAC traces
// a triangle at an eighth of the timer rate.
for (let i = 0; i < 4096; i++) image[at(0xc000) + i] = 0x0f;

const header = new Uint8Array(0x80);
header.set([0x4e, 0x45, 0x53, 0x4d, 0x1a, 0x01, 1, 1], 0);
const put16 = (off, v) => {
  header[off] = v & 0xff;
  header[off + 1] = v >> 8;
};
put16(0x08, LOAD);
put16(0x0a, 0x8000);
put16(0x0c, 0x8100);
new TextEncoder().encodeInto("DMC exercise", header.subarray(0x0e, 0x2e));
put16(0x6e, 16639);

const nsf = new Uint8Array(header.length + image.length);
nsf.set(header);
nsf.set(image, header.length);

const file = parseNSF(nsf);
const seconds = 4;
const player = new NSFPlayer({ defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
player.load(file, 0);

const total = seconds * 44100;
const left = new Int16Array(total);
const right = new Int16Array(total);
let minLevel = 128;
let maxLevel = 0;
const block = 735;
for (let a = 0; a < total; a += block) {
  player.renderInto(left, right, a, Math.min(block, total - a));
  const level = player.getChannelStatus(CH_DMC).level * 127;
  minLevel = Math.min(minLevel, level);
  maxLevel = Math.max(maxLevel, level);
}

let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]));
const dmc = player.getChannelStatus(CH_DMC);
console.log(
  `dmc: active=${dmc.active} bytesLeft>0=${dmc.active} level=${minLevel.toFixed(0)}..${maxLevel.toFixed(0)} ` +
    `peak=${peak} cycles=${player.cycleCount}`
);
if (peak === 0) {
  console.error("FAIL: the DMC produced silence");
  process.exit(1);
}
if (maxLevel - minLevel < 4) {
  console.error("FAIL: the DAC level never moved");
  process.exit(1);
}
console.log("PASS");

const out = process.argv[2] ?? "dmc.wav";
const wav = Buffer.alloc(44);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + total * 2, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24);
wav.writeUInt32LE(88200, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(total * 2, 40);
writeFileSync(out, Buffer.concat([wav, Buffer.from(left.buffer, 0, total * 2)]));
console.log(`wrote ${out}`);
