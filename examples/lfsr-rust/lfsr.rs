// 16-bit Galois LFSR step: the state-update function that README Runtime animates.
// Taps 16,14,13,11 (toggle mask 0xB400) give the maximal period 65535, so any state in
// 1..=65535 walks through every non-zero 16-bit value and never reaches 0.
// The runtime calls step(s) repeatedly: s0, step(s0), step(step(s0)), ...
#![no_std]

#[no_mangle]
pub extern "C" fn step(s: i32) -> i32 {
    // Work on u32 so the shift is logical (i32.shr_u) and the Wasm stays pure i32.
    let s = s as u32;
    let toggle = if s & 1 != 0 { 0xB400 } else { 0 };
    ((s >> 1) ^ toggle) as i32
}

// Required by #![no_std]. step() has no panicking path; if one were ever added, it would
// compile to a Wasm trap (unreachable) rather than a loop.
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
