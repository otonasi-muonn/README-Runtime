// Browser regression for #7: numeric React lengths at zero, compressed class choices,
// conditional child slices, SVG definitions inside a variable-length fragment, and a gradient
// referenced from a sibling <svg> next to a conditional child (both stay inside the variants).
// Form controls are checked by test/ui-fidelity.test.js (markup) only: Chromium sizes a
// <textarea> revealed by a container query in an <img> differently between runs.
export default function Fidelity({ dx, on, sel }) {
  return <main style={{ width: 320, height: 220, background: '#fafafa' }}>
    <header style={{ height: 20, background: '#234' }} />
    <section style={{ position: 'relative', height: 60 }}>
      <i className={sel % 2 ? 'odd' : 'even'} style={{ position: 'absolute', left: dx, top: 0, width: 22, height: 20 }} />
      {on ? <b style={{ position: 'absolute', left: dx, top: 30, width: 22, height: 20, background: '#080' }} /> : null}
    </section>
    <section>
      {on ? <span style={{ display: 'inline-block', width: 15, height: 20, background: '#840' }} /> : null}
      <svg width="80" height="40"><defs><linearGradient id="paint"><stop stopColor={sel % 2 ? '#080' : '#04c'} /></linearGradient></defs><rect width="80" height="40" fill="url(#paint)" /></svg>
    </section>
    <section style={{ height: 40 }}>
      <svg width="0" height="0"><defs><linearGradient id="sib"><stop stopColor={on ? '#c00' : '#00c'} /></linearGradient></defs></svg>
      {on ? <u style={{ display: 'inline-block', width: 10, height: 20, background: '#888' }} /> : null}
      <svg width="60" height="30"><rect width="60" height="30" fill="url(#sib)" /></svg>
    </section>
    <footer style={{ height: 20, background: '#abc' }} />
  </main>;
}
