// Fibonacci LFSR, 16 bits, taps 16 14 13 11 (the example on Wikipedia's "Linear-feedback shift register" page)
#include <stdint.h>
__attribute__((export_name("step")))
int step(int x) {
  uint16_t lfsr = (uint16_t)x;
  uint16_t bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1u;
  lfsr = (lfsr >> 1) | (bit << 15);
  return lfsr;
}
