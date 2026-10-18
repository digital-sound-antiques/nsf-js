/* Replays a register log through emu2149 and compares each channel's output
 * with the TypeScript port's. See s5b-ref.mjs. */
#include <stdio.h>
#include "emu2149.c"

int main(int argc, char **argv) {
  FILE *w = fopen(argv[1], "r");
  FILE *o = fopen(argv[2], "rb");
  /* A clock and rate chosen so that, with the divider on, every PSG_calc is
   * exactly one internal step: rate = clock / 2 / 8. */
  PSG *psg = PSG_new(1789776, 111861);
  PSG_setClockDivider(psg, 1);
  PSG_setVolumeMode(psg, 1);
  PSG_reset(psg);
  long t, r, d, step = 0, mismatches = 0;
  int have = fscanf(w, "%ld\n%ld\n%ld\n", &t, &r, &d) == 3;
  int16_t expect[3];
  while (fread(expect, 2, 3, o) == 3) {
    while (have && t <= step) {
      PSG_writeReg(psg, r, d);
      have = fscanf(w, "%ld\n%ld\n%ld\n", &t, &r, &d) == 3;
    }
    PSG_calc(psg);
    for (int i = 0; i < 3; i++) {
      if (psg->ch_out[i] != expect[i]) {
        if (mismatches < 10) printf("step %ld ch %d: emu2149 %d, port %d\n", step, i, psg->ch_out[i], expect[i]);
        mismatches++;
      }
    }
    step++;
  }
  printf("steps %ld mismatches %ld\n", step, mismatches);
  return 0;
}
