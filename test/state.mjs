// A state saved by one player must reproduce exactly in another: that is how a
// look-ahead scanner's keyframes are handed to the audible engine for a seek.
//
//   node test/state.mjs <file.nsf> [track]

import { readFileSync } from "node:fs";
import { NSFPlayer, parseNSF } from "../dist/index.js";

const [, , path, trackArg] = process.argv;
const file = parseNSF(new Uint8Array(readFileSync(path)));
const track = trackArg != null ? Number(trackArg) : file.startTrack;

const AHEAD = 44100 * 5;
const CHECK = 44100 * 2;
const opts = { defaultPlaySeconds: 600, defaultFadeSeconds: 0 };

const a = new NSFPlayer(opts);
a.load(file, track);
const la = new Int16Array(AHEAD), ra = new Int16Array(AHEAD);
a.renderInto(la, ra, 0, AHEAD);
const state = a.saveState();
const lref = new Int16Array(CHECK), rref = new Int16Array(CHECK);
a.renderInto(lref, rref, 0, CHECK);

// Same instance, restored.
a.restoreState(state);
const l1 = new Int16Array(CHECK), r1 = new Int16Array(CHECK);
a.renderInto(l1, r1, 0, CHECK);

// A different instance, restored from the other's state.
const b = new NSFPlayer(opts);
b.load(file, track);
const l2 = new Int16Array(CHECK), r2 = new Int16Array(CHECK);
b.restoreState(state);
b.renderInto(l2, r2, 0, CHECK);

const compare = (name, x) => {
  let max = 0;
  let mismatches = 0;
  for (let i = 0; i < CHECK; i++) {
    const d = Math.abs(lref[i] - x[i]);
    if (d > 0) mismatches++;
    if (d > max) max = d;
  }
  const ok = max === 0;
  console.log(`  ${name.padEnd(18)} maxDiff=${String(max).padStart(6)} differing=${mismatches} ${ok ? "exact" : ""}`);
  return ok;
};

console.log(`${file.title} track ${track + 1}`);
const ok1 = compare("same instance", l1);
const ok2 = compare("other instance", l2);
process.exit(ok1 && ok2 ? 0 : 1);
