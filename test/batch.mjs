// Every track of every file in a directory, briefly. Catches the failures that
// only some tracks trigger: a jammed CPU, a track that renders silence, a
// parse or bank-mapping error.
//
//   node test/batch.mjs <dir> [seconds]

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NSFPlayer, parseNSF, isNSFFile, CHANNEL_COUNT } from "../dist/index.js";

const [, , dir, secondsArg] = process.argv;
const seconds = secondsArg != null ? Number(secondsArg) : 3;

function collect(path, out = []) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.nsfe?$/i.test(name)) out.push(full);
  }
  return out;
}

let problems = 0;
let tracks = 0;
for (const path of collect(dir)) {
  const data = new Uint8Array(readFileSync(path));
  if (!isNSFFile(data)) {
    console.log(`${path}: not recognised`);
    problems++;
    continue;
  }
  const file = parseNSF(data);
  const silent = [];
  const jammed = [];
  for (let t = 0; t < file.trackCount; t++) {
    tracks++;
    const player = new NSFPlayer({ defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
    try {
      player.load(file, t);
      const total = seconds * 44100;
      const left = new Int16Array(total);
      const right = new Int16Array(total);
      player.renderInto(left, right, 0, total);
      let peak = 0;
      for (let i = 0; i < total; i++) {
        const v = Math.abs(left[i]);
        if (v > peak) peak = v;
      }
      if (peak < 32) silent.push(t + 1);
      if (player.jammed) jammed.push(t + 1);
    } catch (e) {
      console.log(`${path} track ${t + 1}: ${e.message}`);
      problems++;
    }
  }
  const notes = [];
  if (silent.length) notes.push(`silent=[${silent.join(",")}]`);
  if (jammed.length) notes.push(`jammed=[${jammed.join(",")}]`);
  problems += silent.length + jammed.length;
  console.log(
    `${path.split("/").pop().padEnd(32)} ${String(file.trackCount).padStart(3)} tracks  ${notes.join(" ") || "ok"}`
  );
}
console.log(`\n${tracks} tracks, ${problems} problems`);
