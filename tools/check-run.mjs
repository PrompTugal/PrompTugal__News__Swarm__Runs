#!/usr/bin/env node
// Check one run, for the live demo: print the chain and verify every link it can, offline from the files in this repository.
// Written by swarm.1.dev.fringe@PrompTugal.dinis (dbd1fe7, in its session); landed by swarm.1.fringe@PrompTugal.dinis.
//   node tools/check-run.mjs <request id> [--keys PATH/TO/fringe/data/keys.json] [--json]
//   request (requests/<id>/packet.json + .sig) -> request commit -> Actions run URL -> result commit -> attestation URL
// Checks:
//   1. the result's signature: the run's own ed25519 key (it lived only during the run) over {body, fp}, and fp is that key's fingerprint;
//   2. provenance.json's result_sha256 is the sha256 of result.json's bytes, and it names the same commit and run as the result;
//   3. the result answers this request: same request id and kind, the same requester, signed-by fingerprint = the request's signature;
//   4. with --keys: the request's own signature against the requester's public key (the same check the workflow's plan job makes);
//   5. the result commit is in this clone's history and came after the request commit (skipped, not failed, in a shallow clone).
// Exit 0 only when every check that ran passed. Never prints prompt or answer text (none is stored). `gh attestation verify` is the
// independent check of GitHub's attestation; this tool prints the command, it does not call GitHub.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const id = argv.find((a, i) => !a.startsWith('--') && !['--keys'].includes(argv[i - 1]));
const asJson = argv.includes('--json');
if (!id) { console.error('usage: node tools/check-run.mjs <request id> [--keys PATH/TO/data/keys.json] [--json]'); process.exit(2); }
if (!/^[A-Za-z0-9._-]+$/.test(id)) { console.error(`check-run: bad id ${id}`); process.exit(2); }

const checks = [], chain = {};
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); return ok; };
const skip = (name, detail) => checks.push({ name, ok: null, detail });
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f)); } catch { return null; } };
const json = (f) => { const b = read(f); if (!b) return null; try { return JSON.parse(b); } catch { return undefined; } };
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const deep = (o) => (o && typeof o === 'object' ? (Array.isArray(o) ? o.map(deep) : Object.fromEntries(Object.keys(o).sort().map((k) => [k, deep(o[k])]))) : o);
const REPO = 'PrompTugal/PrompTugal__News__Swarm__Runs', GH = `https://github.com/${REPO}`;

// the request
const reqF = `requests/${id}/packet.json`, P = json(reqF), S = json(`${reqF}.sig`);
check('request present', !!P && !!S, P === null ? `no ${reqF}` : P === undefined ? `${reqF} is not JSON` : !S ? `no ${reqF}.sig` : `${P.kind} by ${P.from}`);
if (P) chain.request = { id, kind: P.kind, from: P.from, key_id: P.key_id, requested_at: P.requested_at, budget: P.budget, signed_by: S && S.fingerprint };
const reqCommit = git('log', '-1', '--format=%H', '--diff-filter=A', '--', reqF);
chain.request_commit = reqCommit ? { sha: reqCommit, url: `${GH}/commit/${reqCommit}` } : null;

// the result and its provenance
const resF = `runs/${id}/result.json`, resB = read(resF), R = json(resF), V = json(`runs/${id}/provenance.json`);
if (!check('result present', !!R && !!R.body && !!R.by && !!R.sig, R === null ? `no ${resF} (not run yet, or the commit job has not pushed: git pull)` : 'signed result')) finish();
const B = R.body;
chain.actions_run = B.run_url || (V && V.workflow_run) || null;
const resCommit = git('log', '-1', '--format=%H', '--', resF);
chain.result_commit = resCommit ? { sha: resCommit, url: `${GH}/commit/${resCommit}` } : null;
chain.attestation = (V && V.attestation) || null;
chain.verify = `gh attestation verify ${resF} -R ${REPO}`;
chain.run = { id: B.id, llm_calls: B.metrics && B.metrics.llm_calls, valid_calls: B.metrics && B.metrics.valid_calls, openrouter_usd: B.metrics && B.metrics.openrouter_usd, wall_ms: B.wall_ms, fringe_sha: B.fringe_sha };

// 1. the result's own signature
try {
  const pubDer = Buffer.from(R.by.pub, 'base64'), fp = 'sha256:' + crypto.createHash('sha256').update(R.by.pub).digest('hex').slice(0, 16);
  check('result key fingerprint', fp === R.by.fp, `${R.by.fp}${fp === R.by.fp ? '' : ' but the key hashes to ' + fp}`);
  const ok = crypto.verify(null, Buffer.from(JSON.stringify(deep({ body: B, fp: R.by.fp }))), crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' }), Buffer.from(R.sig, 'base64'));
  check('result signature (ed25519, per-run key)', ok, ok ? `signed ${R.by.signed_at}` : 'the signature does not verify: the result was changed after it was signed');
} catch (e) { check('result signature (ed25519, per-run key)', false, String(e.message).slice(0, 160)); }

// 2. provenance
if (!V) check('provenance present', false, V === null ? `no runs/${id}/provenance.json` : 'provenance.json is not JSON');
else {
  const h = crypto.createHash('sha256').update(resB).digest('hex');
  check('provenance sha256 = sha256(result.json)', V.result_sha256 === h, V.result_sha256 === h ? h.slice(0, 16) + '…' : `provenance ${String(V.result_sha256).slice(0, 16)}…, file ${h.slice(0, 16)}…`);
  check('provenance names this result', V.result === resF, V.result);
  check('provenance commit = result commit field', !!V.commit && V.commit === B.commit, `${String(V.commit).slice(0, 12)} / ${String(B.commit).slice(0, 12)}`);
  check('provenance run = result run', !!V.workflow_run && V.workflow_run === B.run_url, V.workflow_run);
  if (!V.attestation) check('attestation URL recorded', false, 'provenance.attestation is empty');
}

// 3. the result answers this request
if (P) {
  check('result answers this request', B.request === id && B.request_kind === P.kind && B.requester === P.from, `${B.request} ${B.request_kind} for ${B.requester}`);
  check('result records the request signature', !!S && B.request_signed_by === S.fingerprint, `${B.request_signed_by}`);
  if (reqCommit) check('result ran on the request commit', B.commit === reqCommit || git('merge-base', '--is-ancestor', reqCommit, B.commit || 'x') !== null, `${String(B.commit).slice(0, 12)}`);
  else skip('result ran on the request commit', 'request commit not in this clone (shallow?): git fetch --depth=50 origin dev');
}

// 4. the request's own signature, against the requester's public key
if (arg('--keys') && P && S) {
  try {
    const K = JSON.parse(fs.readFileSync(arg('--keys'), 'utf8')).keys.find((k) => k.id === P.key_id && k.status === 'active');
    if (!K) check('request signature (ECDSA P-256)', false, `no active key ${P.key_id}`);
    else {
      const ok = K.agent === P.from && K.bundle.signing_fingerprint === S.fingerprint && crypto.verify('sha256', read(reqF), { key: crypto.createPublicKey(K.bundle.sign), dsaEncoding: 'ieee-p1363' }, Buffer.from(S.signature, 'base64'));
      check('request signature (ECDSA P-256)', ok, ok ? `${P.key_id} (${S.fingerprint})` : 'does not verify against ' + P.key_id);
    }
  } catch (e) { check('request signature (ECDSA P-256)', false, String(e.message).slice(0, 160)); }
} else skip('request signature (ECDSA P-256)', 'pass --keys PATH/TO/PrompTugal__News__Fringe/data/keys.json');

// 5. order of commits
if (reqCommit && resCommit) check('result commit after request commit', git('merge-base', '--is-ancestor', reqCommit, resCommit) !== null, `${reqCommit.slice(0, 12)} → ${resCommit.slice(0, 12)}`);
else skip('result commit after request commit', 'a commit is not in this clone (shallow?)');

finish();

function finish() {
  const failed = checks.filter((c) => c.ok === false).length;
  if (asJson) console.log(JSON.stringify({ id, ok: failed === 0, chain, checks }, null, 1));
  else {
    const c = chain, line = (k, v) => console.log(`  ${k.padEnd(15)} ${v ?? '—'}`);
    console.log(`run ${id}`);
    line('request', c.request ? `${reqF} · ${c.request.kind} by ${c.request.from} · signed ${c.request.signed_by}` : null);
    line('request commit', c.request_commit && c.request_commit.url);
    line('actions run', c.actions_run);
    line('result commit', c.result_commit && c.result_commit.url);
    line('attestation', c.attestation);
    if (c.run) line('result', `${c.run.id} · ${c.run.valid_calls}/${c.run.llm_calls} valid · ${c.run.openrouter_usd} USD · ${c.run.wall_ms} ms`);
    if (c.verify) line('verify', c.verify);
    console.log('');
    for (const x of checks) console.log(`  ${x.ok === true ? 'ok  ' : x.ok === false ? 'FAIL' : 'skip'}  ${x.name}${x.detail ? ': ' + x.detail : ''}`);
    console.log(`\n${failed ? `NOT VERIFIED: ${failed} check(s) failed` : `verified: ${checks.filter((x) => x.ok).length} checks passed, ${checks.filter((x) => x.ok === null).length} skipped`}`);
  }
  process.exit(failed ? 1 : 0);
}
