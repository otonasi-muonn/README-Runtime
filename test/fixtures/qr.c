// Quotient and remainder by 65521 (the Adler-32 modulus), recombined.
__attribute__((export_name("step")))
int step(int x) {
  int q = x / 65521;
  int r = x - q * 65521;
  return r * 7 + q + 1;
}
