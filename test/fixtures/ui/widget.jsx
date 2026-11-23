// A small component exercising every kind of binding the UI inference supports.
export default function Widget({ x, on, n }) {
  return (
    <div style={{ position: 'relative', width: 300, height: 120 }}>
      <div className="bar" style={{ position: 'absolute', left: 10 + x * 2, top: 10, width: 40, height: 20, opacity: 1 }} />
      <span className={on ? 'pill is-on' : 'pill'}>{on ? 'ON' : 'OFF'}</span>
      <p>count {n * 3 + 1} items</p>
      {on ? <b>extra</b> : null}
    </div>
  );
}
