// What GitHub does with each format in a README (read-only requests, no login):
// bytes on the wire for the committed SVG card, content types of a committed .webp / .mp4,
// what the markdown sanitizer keeps, and which hosts the page CSP lets images and media load
// from. Writes bench/results/github.json. Run: node bench/github.mjs
import https from 'node:https';
import { writeJson } from './common.mjs';

function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'User-Agent': 'readme-runtime-bench', ...headers } }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (c) => { bytes += c.length; chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const SVG = 'https://raw.githubusercontent.com/otonasi-muonn/README-Runtime/dev/readme-runtime-mvp/readme-runtime/mockcraft.svg';
const out = { date: new Date().toISOString(), svgTransfer: {}, contentTypes: {}, markdown: {}, csp: {} };
for (const enc of ['identity', 'gzip', 'br', 'gzip, deflate, br, zstd']) {
  const r = await request(SVG, { headers: { 'Accept-Encoding': enc } });
  out.svgTransfer[enc] = { status: r.status, contentEncoding: r.headers['content-encoding'] ?? null, bytesOnWire: r.bytes };
}
for (const [kind, url] of Object.entries({
  svg: SVG,
  webp: 'https://raw.githubusercontent.com/webmproject/libwebp/main/examples/test.webp',
  mp4: 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4',
})) {
  const r = await request(url, { headers: { Range: 'bytes=0-99', 'Accept-Encoding': 'gzip, br' } });
  out.contentTypes[kind] = { url, contentType: r.headers['content-type'], contentEncoding: r.headers['content-encoding'] ?? null, cacheControl: r.headers['cache-control'] };
}
const md = await request('https://api.github.com/markdown', {
  method: 'POST', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'gfm', context: 'otonasi-muonn/README-Runtime', text: '![svg](demo.svg)\n\n![webp](demo.webp)\n\n<video src="demo.mp4" autoplay loop muted playsinline></video>\n\n![mp4](demo.mp4)' }),
});
out.markdown = { status: md.status, html: md.body.toString() };
const page = await request('https://github.com/otonasi-muonn/README-Runtime', { method: 'HEAD' });
const csp = String(page.headers['content-security-policy'] ?? '');
for (const d of ['img-src', 'media-src']) out.csp[d] = (csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(d)) ?? '').split(/\s+/).slice(1);
writeJson('github.json', out);
console.log(JSON.stringify({ svgTransfer: out.svgTransfer, contentTypes: out.contentTypes, mediaSrc: out.csp['media-src'] }, null, 1));
console.log(out.markdown.html);
