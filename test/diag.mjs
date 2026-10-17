// Per-channel activity over a track: which channels a file actually uses, what
// range of notes each plays, and how often they retrigger. Enough to tell a
// silent channel from an unimplemented one.
//
//   node test/diag.mjs <file.nsf> [track] [seconds]

import { readFileSync } from "node:fs";
import { NSFPlayer, parseNSF, CHANNEL_COUNT } from "../dist/index.js";

const [, , path, trackArg, secondsArg] = process.argv;
const data = new Uint8Array(readFileSync(path));
const file = parseNSF(data);
const track = trackArg != null ? Number(trackArg) : file.startTrack;
const seconds = secondsArg != null ? Number(secondsArg) : 20;

const sampleRate = 44100;
const player = new NSFPlayer({ sampleRate, defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
player.channelCaptureEnabled = true;
player.load(file, track);

const stats = Array.from({ length: CHANNEL_COUNT }, () => ({
  activeFrames: 0,
  peak: 0,
  noteLow: Infinity,
  noteHigh: -Infinity,
  keyOns: 0,
}));

const block = 735;
const frames = Math.floor((seconds * sampleRate) / block);
const left = new Int16Array(block);
const right = new Int16Array(block);
for (let f = 0; f < frames; f++) {
  player.renderInto(left, right, 0, block);
  const cap = player.channelCapture;
  const n = player.channelCaptureLength;
  for (let c = 0; c < CHANNEL_COUNT; c++) {
    const st = player.getChannelStatus(c);
    const s = stats[c];
    if (st.active) s.activeFrames++;
    if (st.note != null && st.active) {
      s.noteLow = Math.min(s.noteLow, st.note);
      s.noteHigh = Math.max(s.noteHigh, st.note);
    }
    s.keyOns = st.keyOnCount;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(cap[i * CHANNEL_COUNT + c]);
      if (v > s.peak) s.peak = v;
    }
  }
}

const names = ["pulse1", "pulse2", "triangle", "noise", "dmc", "fds", "vrc6 pls1", "vrc6 pls2", "vrc6 saw"];
console.log(`${file.title} - track ${track + 1}, ${seconds}s`);
for (let c = 0; c < CHANNEL_COUNT; c++) {
  const s = stats[c];
  const range =
    s.noteLow === Infinity ? "-" : `${s.noteLow.toFixed(1)}..${s.noteHigh.toFixed(1)}`;
  console.log(
    `  ${names[c].padEnd(9)} active=${((100 * s.activeFrames) / frames).toFixed(0).padStart(3)}% ` +
      `peak=${String(s.peak).padStart(5)} keyOns=${String(s.keyOns).padStart(4)} notes=${range}`
  );
}
console.log(`  clipped=${player.clippedSamples}`);
