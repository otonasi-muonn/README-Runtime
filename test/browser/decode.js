// Read values back out of a rendered card, from pixels only.
import { PNG } from 'pngjs';
import { layout } from '../../src/render/card.js';

const px = (png, x, y) => {
  const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// `scale` = device pixels per SVG unit (the <img> is shown at its natural size).
export function decodeCard(pngBuffer, machineInfo, { scale = 1 } = {}) {
  const png = PNG.sync.read(pngBuffer);
  const L = layout({ steps: machineInfo.steps }, { bits: machineInfo.bits });
  const at = (x, y) => px(png, x * scale, y * scale);
  // Card and panel backgrounds are sampled from the image itself (works for both themes).
  const cardBg = at(10, 60);
  const panelBg = at(L.tr.x - 3, L.tr.y + 2);

  // 32-bit register LEDs (two's complement of the shown state)
  let u = 0;
  const ledBits = [];
  for (let j = 0; j < 32; j++) {
    const on = dist(at(L.ledX(j) + 2.5, L.leds.y + 4.5), cardBg) > 100;
    ledBits.push(on ? 1 : 0);
    if (on) u += 2 ** j;
  }
  const led = u >= 2 ** 31 ? u - 2 ** 32 : u;

  // Trace: one column per level, rows = bits (+ sign row on top)
  const cols = [];
  for (let k = 0; k <= machineInfo.steps; k++) {
    const x = Math.ceil(L.tr.x + k * L.cw) + 0.5;
    let v = 0, lit = false;
    for (let b = 0; b < L.bits; b++) {
      const y = Math.ceil(L.tr.y + (L.bits - b) * L.rh) + 2.5;
      if (dist(at(x, y), panelBg) > 80) { v += 2 ** b; lit = true; }
    }
    const sy = Math.ceil(L.tr.y) + 2.5;
    if (dist(at(x, sy), panelBg) > 80) { v -= 2 ** L.bits; lit = true; }
    cols.push(lit ? v : null);
  }

  // Status: colour of the solid status dot (text colour is unreliable because of subpixel
  // antialiasing).
  const dot = at(190, L.step.y + 10);
  const [r, g, b] = dot;
  let status = 'other';
  if (r > g + 50 && r > b + 40) status = 'error';
  else if (b > r + 40 && b > g + 15) status = 'halted';
  else if (g > r + 25 && g > b + 10) status = 'running';
  else if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && dist(dot, cardBg) > 40) status = 'end';
  return { led, ledBits, cols, status, dot };
}
