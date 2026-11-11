#!/usr/bin/env node
// Swarm runs: every run starts with a push (architect.1's design, docs/handoffs/2026-11-11-swarm-runs-design.md in the fringe;
// Dinis, 11 Nov 23:2x UTC: "for provenance and for traceability, every run should start with the GitHub action ... the push
// triggers the information"; and to swarm.1, 23:3x UTC: "great, can push and use the secrets that are there").
//   A request is requests/<id>/packet.json plus packet.json.sig: the packet signed by the requester's PKI session key
//   (`node pki-agent.mjs sign packet.json`, ECDSA P-256), checked against the public keys in PrompTugal__News__Fringe data/keys.json.
//   node tools/requests.mjs new    --id ID --kind A0|A1|A2 --tasks a,b --models m1,m2 [--tries 3] [--usd 0.5] [--minutes 10] --from AGENT --key-id KEYID
//   node tools/requests.mjs batch  --n N --kind A1|A2 --tasks a,b --models m1,m2 [--slug S] [--spread] ... (N requests, one push; see batch())
//   node tools/requests.mjs verify --id ID --keys PATH/TO/data/keys.json
//   node tools/requests.mjs plan   --keys PATH --before SHA --after SHA   (or --ids a,b)   -> prints the matrix JSON (verified requests only)
//   node tools/requests.mjs run    --id ID --fringe PATH                  (in the Action: writes runs/<id>/result.json, flow-events.json)
//   node tools/requests.mjs index                                         (runs/index.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const REQ = path.join(ROOT, 'requests'), RUNS = path.join(ROOT, 'runs');
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };

// one packet's body (new and batch share it; swarm.1.dev.fringe@PrompTugal.dinis, dbd1fe7)
function packetBody({ id, kind, tasks, models, tries, usd, minutes, from, keyId, title }) {
  if (!['A0', 'A1', 'A2'].includes(kind)) throw new Error('kind is A0, A1 or A2: an A3 agent only starts runs, it never runs here (R12)');
  if (!/^\d{8}-\d{4}-[a-z0-9-]+$/.test(id || '')) throw new Error(`id ${id}: must be <YYYYMMDD-HHMM-slug> (lowercase, digits, dashes)`);
  tries = kind === 'A2' ? tries : 1;
  return {
    v: 1, id, kind, from, key_id: keyId, requested_at: now(), title: title || `${kind}: storm ${tasks.join(', ')} on ${models.length} model(s)`,
    mandate: "Read the named storm datasets from the storm site's public API and answer each task's question, checked, on each named model. Nothing else.",
    grant: kind === 'A0' ? ['read.web:storm-charles.promptugal.news/api/v1'] : ['read.web:storm-charles.promptugal.news/api/v1', 'call.llm:openrouter.ai (through the fringe admin/tools/llm.mjs)'],
    tasks, models, tries,
    budget: { max_calls: tasks.length * Math.max(models.length, 0) * tries, max_tokens_per_call: 1500, max_usd: usd, max_minutes: minutes },
    output: 'runs/<id>/result.json (signed by a key that lives only during the run), flow-events.json, provenance.json (with a GitHub attestation)',
  };
}
const common = () => ({ kind: arg('--kind', 'A2'), tasks: arg('--tasks').split(','), models: arg('--models', '').split(',').filter(Boolean), tries: +arg('--tries', '3'), usd: +arg('--usd', '0.5'), minutes: +arg('--minutes', '10'), from: arg('--from'), keyId: arg('--key-id') });

function create() {
  const body = packetBody({ ...common(), id: arg('--id'), title: arg('--title') });
  write(path.join(REQ, body.id, 'packet.json'), body);
  console.log(`request ${body.id}: ${body.kind}, ${body.tasks.length} tasks × ${body.models.length} models, budget ${body.budget.max_usd} USD / ${body.budget.max_calls} calls / ${body.budget.max_minutes} min; now sign it: node pki-agent.mjs sign requests/${body.id}/packet.json`);
}

// N requests in one go, for the scale demo: one push, N verified requests, N parallel jobs (the workflow's matrix runs at most 20 at once).
//   node tools/requests.mjs batch --n N --kind A1|A2 --tasks a,b --models m1,m2 [--slug storm-scale] [--at YYYYMMDD-HHMM] [--spread] [--tries 3] [--usd 0.1] [--minutes 5] --from AGENT --key-id KEYID
//   ids: <at>-<slug>-01 .. -NN. --spread deals the tasks round-robin over the N requests (each request gets a share) instead of every request carrying all of them.
//   --usd and --minutes are per request; the total is printed. It writes packet.json files only: the requester signs each one and pushes them in one commit.
function batch() {
  const n = +arg('--n'), c = common(), slug = arg('--slug', `storm-${c.kind.toLowerCase()}-x`), spread = process.argv.includes('--spread');
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('--n is a whole number from 1 to 99');
  if (spread && c.tasks.length < n) throw new Error(`--spread needs at least as many tasks (${c.tasks.length}) as requests (${n})`);
  const at = arg('--at', now().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')), w = String(n).length < 2 ? 2 : String(n).length;
  const ids = [], tot = { calls: 0, usd: 0 };
  for (let i = 1; i <= n; i++) {
    const id = `${at}-${slug}-${String(i).padStart(w, '0')}`;
    if (fs.existsSync(path.join(REQ, id))) throw new Error(`requests/${id} exists: pick another --slug or --at (a request is never overwritten)`);
    const tasks = spread ? c.tasks.filter((_, j) => j % n === i - 1) : c.tasks;
    ids.push(packetBody({ ...c, tasks, id, title: arg('--title') ? `${arg('--title')} (${i} of ${n})` : `${c.kind}: storm ${tasks.join(', ')} on ${c.models.length} model(s) (${i} of ${n})` }));
  }
  for (const b of ids) { write(path.join(REQ, b.id, 'packet.json'), b); tot.calls += b.budget.max_calls; tot.usd += b.budget.max_usd; }
  console.log(`batch: ${n} requests ${ids[0].id} .. ${ids.at(-1).id}: ${c.kind}, budget in all ${+tot.usd.toFixed(4)} USD / ${tot.calls} calls (each at most ${c.minutes} min); ${Math.min(n, 20)} jobs at once (max-parallel 20)`);
  console.log(`now sign each: for d in ${ids.map((b) => 'requests/' + b.id).join(' ')}; do node pki-agent.mjs sign $d/packet.json; done`);
}

// the requester's signature: WebCrypto ECDSA P-256 / SHA-256 (IEEE P1363 r||s) over the file's bytes, as pki-agent.mjs `sign` makes it
export function verifyRequest(id, keysPath) {
  const dir = path.join(REQ, id), raw = fs.readFileSync(path.join(dir, 'packet.json')), P = JSON.parse(raw);
  const sig = JSON.parse(fs.readFileSync(path.join(dir, 'packet.json.sig'), 'utf8'));
  const K = JSON.parse(fs.readFileSync(keysPath, 'utf8')).keys.find((k) => k.id === P.key_id && k.status === 'active');
  if (!K) return { ok: false, why: `no active key ${P.key_id} in data/keys.json` };
  if (K.agent !== P.from) return { ok: false, why: `key ${P.key_id} belongs to ${K.agent}, not ${P.from}` };
  if (K.bundle.signing_fingerprint !== sig.fingerprint) return { ok: false, why: 'the signature names another key' };
  const ok = crypto.verify('sha256', raw, { key: crypto.createPublicKey(K.bundle.sign), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.signature, 'base64'));
  return ok ? { ok: true, P, fp: sig.fingerprint } : { ok: false, why: 'the signature does not verify' };
}

function plan() {
  const keys = arg('--keys');
  let ids = arg('--ids') ? arg('--ids').split(',').filter(Boolean) : [];
  if (!ids.length) {
    // a push runs only the requests it added or changed, and never one that already has a result (a re-run is an explicit
    // workflow_dispatch with --ids). If the diff cannot be read, it runs only requests with no result yet: it never falls back to
    // every request (that re-ran storm-a1 and storm-a2 on push 15bf673: found by tools/check-run.mjs, 11 Nov 23:5x UTC).
    const before = arg('--before'), after = arg('--after', 'HEAD');
    const range = before && !/^0+$/.test(before) ? `${before} ${after}` : `${after}~1 ${after}`;
    let names = null; try { names = execSync(`git diff --name-only ${range} -- requests`, { encoding: 'utf8' }); } catch { console.error(`plan: cannot diff ${range}; planning only requests with no result yet`); }
    ids = names !== null ? [...new Set(names.split('\n').filter(Boolean).map((f) => f.split('/')[1]))] : fs.readdirSync(REQ);
    ids = ids.filter((id) => { const done = fs.existsSync(path.join(RUNS, id, 'result.json')); if (done) console.error(`plan: ${id}: has a result already; not re-run on a push (use workflow_dispatch)`); return !done; });
  }
  const out = [];
  for (const id of ids) {
    if (!fs.existsSync(path.join(REQ, id, 'packet.json'))) continue;
    const v = verifyRequest(id, keys);
    console.error(`plan: ${id}: ${v.ok ? 'verified, ' + v.P.kind + ' by ' + v.P.from : 'REFUSED: ' + v.why}`);
    if (v.ok) out.push({ id, kind: v.P.kind, minutes: v.P.budget.max_minutes });
  }
  console.log(JSON.stringify({ include: out }));
}

function identity(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), fp = 'sha256:' + crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16);
  const deep = (o) => (o && typeof o === 'object' ? (Array.isArray(o) ? o.map(deep) : Object.fromEntries(Object.keys(o).sort().map((k) => [k, deep(o[k])]))) : o);
  return { fp, sign: (body) => ({ body, by: { altitude: 'A0', name, fp, pub, signed_at: now() }, sig: crypto.sign(null, Buffer.from(JSON.stringify(deep({ body, fp }))), privateKey).toString('base64') }) };
}

async function run() {
  const id = arg('--id'), fringe = path.resolve(arg('--fringe'));
  const v = verifyRequest(id, path.join(fringe, 'data/keys.json'));
  if (!v.ok) throw new Error(`request ${id} refused: ${v.why}`);
  const P = v.P, gh = process.env;
  const sha = (gh.GITHUB_SHA || 'local').slice(0, 12), runId = `${id}@${sha}#${gh.GITHUB_RUN_ID || 'local'}.${gh.GITHUB_RUN_ATTEMPT || '1'}`;
  const runUrl = gh.GITHUB_RUN_ID ? `${gh.GITHUB_SERVER_URL}/${gh.GITHUB_REPOSITORY}/actions/runs/${gh.GITHUB_RUN_ID}` : null;
  const ENVL = gh.FLOW_ENV || 'R8 GitHub Actions, PrompTugal__News__Swarm__Runs';
  process.env.FLOW_ID = runId; process.env.FLOW_RUNNER = P.from; process.env.FLOW_ENV = ENVL;
  process.env.LLM_DAILY_CAP_USD ||= '25';   // a ceiling; the request's own budget is enforced by the engine, call by call
  const { flow } = await import(path.join(fringe, 'abp/tools/flow.mjs'));
  const F = flow({ id: runId, runner: P.from, environment: ENVL, objective: `${P.title} (commit ${sha}${runUrl ? ', ' + runUrl : ''})` });
  const units = {};   // engine unit id -> flow unit, started and ended live
  const ALT = (n) => (n && /^A[0-4]$/.test(n.altitude) ? n.altitude : null);
  const action = F.unit({ altitude: 'A0', name: `GitHub Action: run ${id} (${P.kind})`, objective: runUrl || 'local' }).start({ note: `commit ${gh.GITHUB_SHA || 'local'}` });
  const hook = (u, phase, n, more, edges) => {
    if (!ALT(n)) return;
    if (phase === 'start' && !units[u]) { const pe = edges.find((e) => e.to === u); units[u] = F.unit({ altitude: n.altitude, name: n.label, parent: (pe && units[pe.from] && units[pe.from].id) || action.id, key_fp: n.key_fp }).start({ item: more.item }); }
    else if (phase === 'end' && units[u]) units[u].end({ valid: more.valid, cost_usd: more.cost_usd, model: n.model, latency_ms: n.latency_ms });
  };
  const { execute } = await import(path.join(ROOT, 'tools/engine.mjs'));
  const deadline = setTimeout(() => { console.error(`run: ${P.budget.max_minutes} minutes reached: stopping (budget)`); process.exit(3); }, P.budget.max_minutes * 60000);
  const result = await execute({ title: P.title, story: `Request ${id} (${P.kind}), committed by ${P.from}; the push started this GitHub Action, which ran it and committed the result.`,
    kind: P.kind, tasks: P.tasks, models: P.models, tries: P.tries, runner: `GitHub Action for ${P.from}`, env: ENVL, account: `github-actions:${gh.GITHUB_REPOSITORY || 'local'}`,
    budget: { usd: P.budget.max_usd, calls: P.budget.max_calls, sessions: 0 }, llm: path.join(fringe, 'admin/tools/llm.mjs'), hook,
    chain: [{ id: 'dinis', kind: 'person', altitude: 'P', label: 'Dinis' }, { id: 'requester', kind: 'agent', altitude: 'A3', label: P.from }, { id: 'commit', kind: 'capability', altitude: 'C', label: `commit ${sha}`, edge: 'commits' }, { id: 'action', kind: 'environment', altitude: 'E', label: 'GitHub Action', edge: 'starts' }] });
  clearTimeout(deadline);
  action.end({ valid: result.metrics.valid_calls === result.metrics.llm_calls, cost_usd: result.metrics.openrouter_usd, note: `${result.metrics.valid_calls}/${result.metrics.llm_calls} valid` });
  await F.flush();
  const key = identity(`run ${runId}`);
  Object.assign(result, { id: runId, kind: 'action', request: id, request_kind: P.kind, requester: P.from, request_signed_by: v.fp, commit: gh.GITHUB_SHA || null, run_url: runUrl, flow: runId, fringe_sha: (() => { try { return execSync('git rev-parse HEAD', { cwd: fringe, encoding: 'utf8' }).trim(); } catch { return null; } })() });
  write(path.join(RUNS, id, 'result.json'), key.sign(result));
  write(path.join(RUNS, id, 'flow-events.json'), { flow: runId, events: F.events });
  console.log(`ran ${runId}: ${result.metrics.llm_calls} calls (${result.metrics.valid_calls} valid), ${result.metrics.openrouter_usd} USD, ${result.wall_ms} ms, peak ${result.metrics.peak_concurrency}; result signed ${key.fp}`);
}

function index() {
  const runs = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((d) => fs.existsSync(path.join(RUNS, d, 'result.json'))).sort().map((d) => {
    const r = JSON.parse(fs.readFileSync(path.join(RUNS, d, 'result.json'), 'utf8')).body;
    return { file: `${d}/result.json`, id: r.id, request: r.request, kind: r.request_kind, requester: r.requester, commit: r.commit, run_url: r.run_url, llm_calls: r.metrics.llm_calls, valid_calls: r.metrics.valid_calls, openrouter_usd: r.metrics.openrouter_usd, at: r.started_at };
  }) : [];
  write(path.join(RUNS, 'index.json'), { about: 'Every run of a committed request: one push, one GitHub Action, one signed result. The swarm site reads this file.', updated: now(), runs });
  console.log(`index: ${runs.length} runs`);
}

process.on('unhandledRejection', (e) => { console.error('requests:', String(e && e.message || e).slice(0, 300)); process.exit(1); });
const cmd = process.argv[2];
if (cmd === 'new') create(); else if (cmd === 'batch') batch(); else if (cmd === 'verify') { const v = verifyRequest(arg('--id'), arg('--keys')); console.log(v.ok ? `verified: ${arg('--id')} by ${v.P.from} (${v.fp})` : `REFUSED: ${v.why}`); process.exitCode = v.ok ? 0 : 1; }
else if (cmd === 'plan') plan(); else if (cmd === 'run') await run(); else if (cmd === 'index') index();
else console.log('usage: node tools/requests.mjs new | batch | verify | plan | run | index');
