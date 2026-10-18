// Check the Sunsoft 5B core against emu2149, the C library it was ported from,
// step for step. Logs a track's 5B register writes against the chip's own step
// clock along with the port's per-channel output, then replays the writes
// through emu2149 (test/s5b-ref.c) and compares.
//
//   node test/s5b-ref.mjs <file.nsf> [track] [seconds] [path/to/emu2149]
//
// Needs a C compiler. emu2149 defaults to a checkout beside this one.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NSFPlayer, parseNSF } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const [, , path, trackArg = "0", secondsArg = "30", emuArg] = process.argv;
if (!path) {
  console.error("usage: node test/s5b-ref.mjs <file.nsf> [track] [seconds] [emu2149 dir]");
  process.exit(1);
}
const emu = emuArg ?? join(here, "../../emu2149");

const player = new NSFPlayer({ defaultPlaySeconds: 1e6, defaultFadeSeconds: 0 });
player.load(parseNSF(new Uint8Array(readFileSync(path))), Number(trackArg));
const s5b = player.bus.s5b;
if (s5b == null) throw new Error("no Sunsoft 5B in this file");

let steps = 0;
const writes = [];
const outs = [];
const writeReg = s5b.writeReg.bind(s5b);
s5b.writeReg = (r, d) => {
  writes.push(steps, r, d);
  writeReg(r, d);
};
const step = s5b.step.bind(s5b);
s5b.step = () => {
  step();
  steps++;
  for (let i = 0; i < 3; i++) outs.push(s5b.out[i]);
};
// Restart with the hooks in place, so the log begins at the chip's reset.
player.setTrack(Number(trackArg));
player.render(Math.floor(44100 * Number(secondsArg)));

const dir = mkdtempSync(join(tmpdir(), "s5b-ref-"));
writeFileSync(join(dir, "writes.txt"), writes.join("\n") + "\n");
writeFileSync(join(dir, "out.bin"), Buffer.from(new Int16Array(outs).buffer));
execFileSync("cc", ["-O2", `-I${emu}`, "-o", join(dir, "ref"), join(here, "s5b-ref.c")]);
const result = execFileSync(join(dir, "ref"), [join(dir, "writes.txt"), join(dir, "out.bin")]);
process.stdout.write(result);
if (!/mismatches 0$/m.test(result.toString())) process.exit(1);
