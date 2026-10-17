// Check the VRC7 core against emu2413, the C library it was ported from,
// sample for sample. Logs a track's VRC7 register writes against the chip's own
// sample clock along with the port's per-channel output, then replays the
// writes through emu2413 (test/vrc7-ref.c) and compares.
//
//   node test/vrc7-ref.mjs <file.nsf> [track] [seconds] [path/to/emu2413]
//
// Needs a C compiler. emu2413 defaults to a checkout beside this one.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NSFPlayer, parseNSF } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const [, , path, trackArg = "0", secondsArg = "30", emuArg] = process.argv;
if (!path) {
  console.error("usage: node test/vrc7-ref.mjs <file.nsf> [track] [seconds] [emu2413 dir]");
  process.exit(1);
}
const emu = emuArg ?? join(here, "../../emu2413");

const player = new NSFPlayer({ defaultPlaySeconds: 1e6, defaultFadeSeconds: 0 });
player.load(parseNSF(new Uint8Array(readFileSync(path))), Number(trackArg));
const vrc7 = player.bus.vrc7;
if (vrc7 == null) throw new Error("no VRC7 in this file");

let ticks = 0;
const writes = [];
const outs = [];
const writeReg = vrc7.writeReg.bind(vrc7);
vrc7.writeReg = (r, d) => {
  writes.push(ticks, r, d);
  writeReg(r, d);
};
const tick = vrc7.tick.bind(vrc7);
vrc7.tick = () => {
  tick();
  ticks++;
  for (let i = 0; i < 6; i++) outs.push(vrc7.out[i]);
};
// Restart with the hooks in place, so the log begins at the chip's reset.
player.setTrack(Number(trackArg));
player.render(Math.floor(44100 * Number(secondsArg)));

const dir = mkdtempSync(join(tmpdir(), "vrc7-ref-"));
writeFileSync(join(dir, "writes.txt"), writes.join("\n") + "\n");
writeFileSync(join(dir, "out.bin"), Buffer.from(new Int16Array(outs).buffer));
execFileSync("cc", ["-O2", `-I${emu}`, "-o", join(dir, "ref"), join(here, "vrc7-ref.c"), "-lm"]);
const result = execFileSync(join(dir, "ref"), [join(dir, "writes.txt"), join(dir, "out.bin")]);
process.stdout.write(result);
if (!/mismatches 0$/m.test(result.toString())) process.exit(1);
