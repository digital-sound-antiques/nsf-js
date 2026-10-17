// Which channels each track of a file uses. Renders a few seconds of every
// track, so a channel that is implemented but never exercised by the test set
// shows up as a gap rather than as a pass.
//
//   node test/scan.mjs <file.nsf> [seconds]

import { readFileSync } from "node:fs";
import { NSFPlayer, parseNSF, CHANNEL_COUNT } from "../dist/index.js";

const [, , path, secondsArg] = process.argv;
const seconds = secondsArg != null ? Number(secondsArg) : 4;
const file = parseNSF(new Uint8Array(readFileSync(path)));
const names = ["p1", "p2", "tri", "noi", "dmc", "fds", "v6a", "v6b", "saw"];

console.log(`${file.title}: ${file.trackCount} tracks`);
for (let t = 0; t < file.trackCount; t++) {
  const player = new NSFPlayer({ defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
  player.load(file, t);
  const used = new Array(CHANNEL_COUNT).fill(0);
  const block = 735;
  const left = new Int16Array(block);
  const right = new Int16Array(block);
  const frames = Math.floor((seconds * 44100) / block);
  for (let f = 0; f < frames; f++) {
    player.renderInto(left, right, 0, block);
    for (let c = 0; c < CHANNEL_COUNT; c++) if (player.getChannelStatus(c).active) used[c]++;
  }
  const tag = used.map((n, c) => (n > 0 ? names[c] : "  -")).join(" ");
  console.log(`  ${String(t + 1).padStart(2)}: ${tag}`);
}
