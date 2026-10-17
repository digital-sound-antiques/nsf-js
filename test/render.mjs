// Render an NSF to a WAV file. The point of this script is ears: statistics
// hide the bugs that are obvious the moment you listen.
//
//   node test/render.mjs <file.nsf> [track] [seconds] [out.wav]

import { readFileSync, writeFileSync } from "node:fs";
import { NSFPlayer, parseNSF, trackTitle } from "../dist/index.js";

const [, , path, trackArg, secondsArg, outArg] = process.argv;
if (!path) {
  console.error("usage: node test/render.mjs <file.nsf> [track] [seconds] [out.wav]");
  process.exit(1);
}

const data = new Uint8Array(readFileSync(path));
const file = parseNSF(data);
const track = trackArg != null ? Number(trackArg) : file.startTrack;
const seconds = secondsArg != null ? Number(secondsArg) : 15;
const out = outArg ?? "out.wav";

const chips = Object.entries(file.chips)
  .filter(([, on]) => on)
  .map(([name]) => name);

console.log(`${file.title} / ${file.artist} / ${file.copyright}`);
console.log(
  `format=${file.format} v${file.version} tracks=${file.trackCount} start=${file.startTrack + 1} ` +
    `region=${file.region} chips=[${chips.join(",")}]`
);
console.log(
  `load=$${file.loadAddress.toString(16)} init=$${file.initAddress.toString(16)} ` +
    `play=$${file.playAddress.toString(16)} speed=${file.ntscSpeedUs}us ` +
    `banks=${file.banks ? [...file.banks].map((b) => b.toString(16)).join(",") : "none"} ` +
    `data=${file.data.length}`
);
console.log(`track ${track + 1}: ${trackTitle(file, track)}`);

const sampleRate = 44100;
const player = new NSFPlayer({ sampleRate, defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
const t0 = process.hrtime.bigint();
player.load(file, track);

const total = Math.floor(seconds * sampleRate);
const left = new Int16Array(total);
const right = new Int16Array(total);
const block = 4096;
for (let at = 0; at < total; at += block) {
  player.renderInto(left, right, at, Math.min(block, total - at));
}
const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;

let peak = 0;
let sum = 0;
let silentHead = 0;
for (let i = 0; i < total; i++) {
  const v = Math.abs(left[i]);
  if (v > peak) peak = v;
  sum += v * v;
  if (peak === 0) silentHead = i;
}
const rms = Math.sqrt(sum / total);
console.log(
  `rendered ${seconds}s in ${elapsed.toFixed(2)}s (${(seconds / elapsed).toFixed(1)}x realtime) ` +
    `peak=${peak} rms=${rms.toFixed(1)} silentHead=${(silentHead / sampleRate).toFixed(3)}s`
);
console.log("channels:", JSON.stringify(player.getChannelStatusArray(), null, 0));

// 16-bit mono WAV, since the machine mixes to one output.
const header = Buffer.alloc(44);
const bytes = total * 2;
header.write("RIFF", 0);
header.writeUInt32LE(36 + bytes, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(bytes, 40);
writeFileSync(out, Buffer.concat([header, Buffer.from(left.buffer, 0, bytes)]));
console.log(`wrote ${out}`);
