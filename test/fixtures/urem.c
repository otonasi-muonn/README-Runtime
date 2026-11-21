// Signed state, unsigned arithmetic in the update (common in hashing / digit code).
__attribute__((export_name("step")))
int step(int x) {
  unsigned u = (unsigned)x * 31u + 7u;
  return (int)(u % 1000u);
}
