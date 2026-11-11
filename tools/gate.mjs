#!/usr/bin/env node
// The gate (from the Fringe's rules): every JSON parses, every tracked file is at most 256 KB, no key material, no binaries.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean); let bad = 0;
const fail = (f, why) => { console.error(`gate: ${f}: ${why}`); bad++; };
for (const f of files) {
  const st = fs.statSync(f); if (st.size > 256 * 1024) fail(f, `${st.size} bytes (max 256 KB)`);
  if (/\.(png|jpe?g|gif|zip|pdf|mp4|bin)$/i.test(f)) fail(f, 'binary in git (use a vault)');
  const t = fs.readFileSync(f, 'utf8');
  if (/-----BEGIN (RSA |EC |)PRIVATE KEY-----|sk-or-v1-[A-Za-z0-9]{20}/.test(t)) fail(f, 'looks like key material');
  if (f.endsWith('.json')) try { JSON.parse(t); } catch (e) { fail(f, 'not JSON: ' + e.message); }
}
const ix = fs.existsSync('runs/index.json') ? JSON.parse(fs.readFileSync('runs/index.json', 'utf8')) : { runs: [] };
for (const r of ix.runs) if (!fs.existsSync(path.join('runs', r.file))) fail('runs/index.json', 'lists a missing run ' + r.file);
console.log(bad ? `gate: ${bad} problem(s)` : `gate OK: ${files.length} files, ${ix.runs.length} runs`); process.exit(bad ? 1 : 0);
