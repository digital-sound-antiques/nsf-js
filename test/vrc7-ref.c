/* Replays a register log through emu2413 in VRC7 mode and compares each
 * channel's output with the TypeScript port's. See vrc7-ref.mjs. */
#include "emu2413.c"

int main(int argc, char **argv) {
  FILE *w = fopen(argv[1], "r");
  FILE *o = fopen(argv[2], "rb");
  /* At clock / 72 the internal rate converter is bypassed. */
  OPLL *opll = OPLL_new(3579545, 49716);
  OPLL_setChipType(opll, 1);
  OPLL_resetPatch(opll, OPLL_VRC7_TONE);
  long t, r, d, tick = 0, mismatches = 0;
  int have = fscanf(w, "%ld\n%ld\n%ld\n", &t, &r, &d) == 3;
  int16_t expect[6];
  while (fread(expect, 2, 6, o) == 6) {
    while (have && t <= tick) {
      OPLL_writeReg(opll, r, d);
      have = fscanf(w, "%ld\n%ld\n%ld\n", &t, &r, &d) == 3;
    }
    update_output(opll);
    for (int i = 0; i < 6; i++) {
      if (opll->ch_out[i] != expect[i]) {
        if (mismatches < 10) printf("sample %ld ch %d: emu2413 %d, port %d\n", tick, i, opll->ch_out[i], expect[i]);
        mismatches++;
      }
    }
    tick++;
  }
  printf("samples %ld mismatches %ld\n", tick, mismatches);
  return 0;
}
