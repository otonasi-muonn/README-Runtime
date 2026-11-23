#!/usr/bin/env node
// Copy reused UI files byte-for-byte from a local checkout of the upstream project and record
// their hashes, so a test can prove the demo uses them unchanged.
//
//   node tools/sync-upstream.mjs <example-dir> <upstream-checkout> [file ...]
// Without file arguments the files already listed in <example-dir>/upstream.json are re-synced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [exampleDir, checkout, ...extra] = process.argv.slice(2);
if (!exampleDir || !checkout) {
  console.error('usage: node tools/sync-upstream.mjs <example-dir> <upstream-checkout> [file ...]');
  process.exit(2);
}
const manifestPath = path.join(exampleDir, 'upstream.json');
const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
const files = [...new Set([...Object.keys(old.files), ...extra])].sort();
const git = (...a) => execFileSync('git', ['-C', checkout, ...a], { encoding: 'utf8' }).trim();
const manifest = {
  repository: git('remote', 'get-url', 'origin'),
  commit: git('rev-parse', 'HEAD'),
  note: 'Byte-identical copies of upstream files: do not edit, re-sync with tools/sync-upstream.mjs. Checked by test/ui.test.js.',
  files: {},
};
for (const f of files) {
  // The committed blob, not the working copy: a Windows checkout may have converted line
  // endings, and the blob is what the upstream repository actually contains.
  const blob = execFileSync('git', ['-C', checkout, 'show', `${manifest.commit}:${f}`]);
  const dst = path.join(exampleDir, 'upstream', f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, blob);
  manifest.files[f] = crypto.createHash('sha256').update(blob).digest('hex');
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`synced ${files.length} files from ${manifest.repository}@${manifest.commit.slice(0, 7)}`);
