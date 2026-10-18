# nsf-js

NES / Famicom sound file (`.nsf`, `.nsfe`) player library for JavaScript, written
from scratch in TypeScript. No WebAssembly, no native dependencies.

Everything here is implemented from published hardware documentation, except the
VRC7's FM core, which is a port of the author's own
[emu2413](https://github.com/digital-sound-antiques/emu2413). No code is derived
from any other emulator.

## What it does

- **6502 core** with cycle counting, the undocumented opcodes and the `JMP (ind)`
  page-wrap bug. No BCD, as on the 2A03.
- **2A03 sound unit**: two pulses with sweep, triangle, noise, and the DMC with
  its memory reader and DMA stalls. Frame counter in both 4- and 5-step modes.
  The hardware's non-linear mixing.
- **FDS** wavetable channel, including the modulator - with its rounding step
  reproduced exactly, since that is what gives FDS vibrato its character.
- **VRC6**: both pulses with their eight duties and DAC mode, and the sawtooth.
- **VRC7**: six channels of OPLL FM with the VRC7's own instrument ROM, ported
  from emu2413 and checked against it sample for sample. Mixed at the level
  measured on hardware.
- **N163**: up to eight wavetable channels, put out one at a time as the chip
  does, so eight-channel music keeps the whine of the switching. Mixed at a
  level measured on hardware, though the boards differ.
- **MMC5**: both pulses, which lack the sweep and keep playing the shortest
  periods, and the PCM channel in both modes; the extra RAM and the
  multiplier that NSFs use the chip for too.
- **NSF / NSFe / NSF2 containers**: bank switching, the FDS memory map, and the
  metadata chunks (per-track titles, lengths, fades, playlist).
- **Band-limited output** at any sample rate: a cascaded-integrator decimator at
  the CPU clock, a windowed-sinc resampler after it, then the Famicom's
  analogue response (a 37 Hz high pass) rather than the NES front-loader's
  thinner one.
- **Exact state snapshots** for instant seeking. A state saved by one player
  instance reproduces bit-identically in another, which is what a look-ahead
  scanner needs to hand keyframes to the audible engine.
- **Per-channel output** for visualisation, with each channel's own offset
  removed.

Not implemented: Sunsoft 5B audio.

## Usage

```js
import { NSFPlayer, parseNSF } from "nsf-js";

const file = parseNSF(new Uint8Array(nsfBytes));
const player = new NSFPlayer({ sampleRate: 44100 });
player.load(file, 0); // track index

const left = new Int16Array(4096);
const right = new Int16Array(4096);
player.renderInto(left, right, 0, 4096);
```

`skip(count)` advances without producing audio, for seeking and for running a
scanner ahead of the play head. `saveState()` / `restoreState()` carry the whole
machine. `getChannelStatus(i)` reports what each channel is doing - note, level,
period, and how many times it has been retriggered.

## Development

```
npm install
npm run build

node test/render.mjs <file.nsf> [track] [seconds] [out.wav]   # listen to it
node test/diag.mjs   <file.nsf> [track] [seconds]             # per-channel activity
node test/scan.mjs   <file.nsf> [seconds]                     # channel use per track
node test/batch.mjs  <dir> [seconds]                          # every track of every file
node test/state.mjs  <file.nsf> [track]                       # snapshot round-trip
node test/dmc.mjs    [out.wav]                                # synthetic DMC exercise
node test/vrc7-ref.mjs <file.nsf> [track] [seconds]           # VRC7 vs emu2413, per sample
```

`test/hash.mjs` is the regression check: it fingerprints the output of a list of
files across rendering, skipping and state restore, and compares against a
baseline. Neither the files nor the baseline are part of this repository. List
your own files in `test/cases.local.json` (the shape is in
`test/cases.example.json`), then:

```
node test/hash.mjs test/fingerprints.local.json   # writes it the first time, compares after
```

## Status

Early development. Plays the 2A03 and FDS material it has been tested against;
the timing details that only some drivers exercise have not all been verified
against hardware.

## License

ISC. See LICENSE.md.
