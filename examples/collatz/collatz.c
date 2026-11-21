// Collatz step: the state-update function that README Runtime animates.
// The runtime calls step(x) repeatedly: x0, step(x0), step(step(x0)), ...
__attribute__((export_name("step")))
int step(int n) {
  return (n % 2 == 0) ? n / 2 : 3 * n + 1;
}
