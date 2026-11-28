// Shows every view as a number (tests of a state of several values).
export default function Values(views) {
  return (
    <div style={{ width: 240, height: 24 }}>
      {Object.keys(views).sort().map((k) => <span key={k}>{k} {views[k]} </span>)}
    </div>
  );
}
