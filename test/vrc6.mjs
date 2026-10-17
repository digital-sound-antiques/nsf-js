// The VRC6 channels, driven straight from their registers: what comes out has a
// shape the spec describes exactly, so it can be checked rather than listened
// to. Complements listening to a VRC6 track.
//
//   node test/vrc6.mjs

import { VRC6 } from "../dist/index.js";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Run `cycles` CPU cycles one at a time, collecting one channel's output. */
function trace(vrc6, pick, cycles) {
  const out = [];
  for (let i = 0; i < cycles; i++) {
    vrc6.advance(1);
    out.push(pick(vrc6));
  }
  return out;
}

// ---- pulse: period, duty ratio, volume --------------------------------
{
  const v = new VRC6();
  const period = 99; // 12-bit period value
  v.write(0x9000, 0x7f); // duty 7 (50%), volume 15
  v.write(0x9001, period & 0xff);
  v.write(0x9002, 0x80 | (period >> 8)); // enable
  const t = trace(v, (x) => x.pulse1.output, 16 * (period + 1) * 3);

  const high = t.filter((x) => x === 15).length;
  const ratio = high / t.length;
  check("pulse duty 7 is 50%", Math.abs(ratio - 0.5) < 0.01, `high ${(100 * ratio).toFixed(1)}%`);

  // one cycle of the duty generator is 16 divider periods
  let edges = 0;
  for (let i = 1; i < t.length; i++) if (t[i] !== 0 && t[i - 1] === 0) edges++;
  const measured = t.length / edges;
  check(
    "pulse period is 16 * (t + 1)",
    Math.abs(measured - 16 * (period + 1)) < 2,
    `${measured.toFixed(0)} cycles vs ${16 * (period + 1)}`
  );
  check("pulse output is the volume", new Set(t).size === 2 && t.includes(15) && t.includes(0));
}

// ---- pulse: narrow duty, mode bit, disable ----------------------------
{
  const v = new VRC6();
  v.write(0x9000, 0x0a); // duty 0 (1/16), volume 10
  v.write(0x9001, 15);
  v.write(0x9002, 0x80);
  const t = trace(v, (x) => x.pulse1.output, 16 * 16 * 8);
  const ratio = t.filter((x) => x === 10).length / t.length;
  check("pulse duty 0 is 1/16", Math.abs(ratio - 1 / 16) < 0.01, `high ${(100 * ratio).toFixed(1)}%`);

  v.write(0x9000, 0x8a); // mode: ignore duty
  const m = trace(v, (x) => x.pulse1.output, 2000);
  check("mode bit outputs the volume constantly", m.every((x) => x === 10));

  v.write(0x9002, 0x00); // disable
  const d = trace(v, (x) => x.pulse1.output, 2000);
  check("disabled forces the output low", d.every((x) => x === 0));
}

// ---- sawtooth: the staircase ------------------------------------------
{
  const v = new VRC6();
  const period = 49;
  v.write(0xb000, 42); // rate: the accumulator just reaches full scale
  v.write(0xb001, period & 0xff);
  v.write(0xb002, 0x80 | (period >> 8));
  const t = trace(v, (x) => x.saw.output, 14 * (period + 1) * 2);

  const steps = [];
  for (const x of t) if (steps.length === 0 || steps[steps.length - 1] !== x) steps.push(x);
  // One ramp, taken from a reset: six additions of rate/8, then back to zero.
  const from = steps.indexOf(0, 1);
  const ramp = steps.slice(from, from + 7);
  check(
    "saw climbs in six steps of rate/8, then resets",
    ramp.join(",") === "0,5,10,15,21,26,31" && steps[from + 7] === 0,
    `levels ${steps.slice(from, from + 8).join(",")}`
  );

  let resets = 0;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) resets++;
  const measured = t.length / resets;
  check(
    "saw period is 14 * (t + 1)",
    Math.abs(measured - 14 * (period + 1)) < 2,
    `${measured.toFixed(0)} cycles vs ${14 * (period + 1)}`
  );
}

// ---- $9003: halt and the frequency multipliers -------------------------
{
  const v = new VRC6();
  v.write(0x9000, 0x7f);
  v.write(0x9001, 255);
  v.write(0x9002, 0x80 | 1); // period 511
  const base = trace(v, (x) => x.pulse1.output, 16 * 512 * 2);
  let baseEdges = 0;
  for (let i = 1; i < base.length; i++) if (base[i] !== 0 && base[i - 1] === 0) baseEdges++;

  const w = new VRC6();
  w.write(0x9003, 0x02); // 16x
  w.write(0x9000, 0x7f);
  w.write(0x9001, 255);
  w.write(0x9002, 0x80 | 1);
  const fast = trace(w, (x) => x.pulse1.output, 16 * 512 * 2);
  let fastEdges = 0;
  for (let i = 1; i < fast.length; i++) if (fast[i] !== 0 && fast[i - 1] === 0) fastEdges++;
  check(
    "16x flag shifts the period by four bits",
    Math.abs(fastEdges / baseEdges - 16) < 1.5,
    `${fastEdges} edges vs ${baseEdges}`
  );

  const h = new VRC6();
  h.write(0x9000, 0x7f);
  h.write(0x9001, 15);
  h.write(0x9002, 0x80);
  trace(h, (x) => x.pulse1.output, 100);
  const before = h.pulse1.output;
  h.write(0x9003, 0x01); // halt
  const held = trace(h, (x) => x.pulse1.output, 5000);
  check("halt freezes the oscillators", held.every((x) => x === before), `held at ${before}`);
}

// ---- the event scheduler must not skip a change ------------------------
{
  const perCycle = new VRC6();
  const batched = new VRC6();
  for (const v of [perCycle, batched]) {
    v.write(0x9000, 0x3c);
    v.write(0x9001, 37);
    v.write(0x9002, 0x81);
    v.write(0xa000, 0x59);
    v.write(0xa001, 91);
    v.write(0xa002, 0x80);
    v.write(0xb000, 30);
    v.write(0xb001, 61);
    v.write(0xb002, 0x80);
  }
  const a = [];
  for (let i = 0; i < 200000; i++) {
    perCycle.advance(1);
    a.push(perCycle.output);
  }
  const b = [];
  let left = 200000;
  while (left > 0) {
    const step = Math.min(left, Math.max(1, Math.min(batched.cyclesToEvent(), 1024)));
    // the value holds for every cycle of the span but its last
    for (let i = 0; i < step - 1; i++) b.push(batched.output);
    batched.advance(step);
    b.push(batched.output);
    left -= step;
  }
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  check("event-driven advance matches cycle-by-cycle", diffs === 0, `${diffs} differing`);
}

console.log(failures === 0 ? "\nall VRC6 checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
