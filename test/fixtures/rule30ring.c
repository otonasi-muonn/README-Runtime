// Rule 30 cellular automaton on a 16-cell ring (wrap-around via shifts), state = 16 bits.
__attribute__((export_name("step")))
int step(int x) {
  unsigned c = (unsigned)x & 0xFFFFu;
  unsigned l = ((c << 1) | (c >> 15)) & 0xFFFFu;
  unsigned r = ((c >> 1) | (c << 15)) & 0xFFFFu;
  return (int)((l ^ (c | r)) & 0xFFFFu);
}
