// Strip factors of 49, otherwise count down.
__attribute__((export_name("step")))
int step(int x) {
  return x % 49 == 0 ? x / 49 : x - 1;
}
