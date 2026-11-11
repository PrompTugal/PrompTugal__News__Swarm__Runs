#!/usr/bin/env node
// The engine of the swarm's runs (copied from PrompTugal__News__Swarm tools/swarm.mjs; the Runs repo uses execute() only). The swarm's one tool (swarm.1.fringe@PrompTugal.dinis, WS-215). Everything a runner on any account needs is in this repository.
// The GitHub flow (Dinis, 11 Nov ~22:4x UTC: "let's first do the full GitHub flow"):
//   1. ISSUE    swarm.1 writes packets/<id>/packet.json (signed) and pushes it to dev.
//   2. PICK UP  a runner (any agent, any account) pulls dev and sees the open packet.
//   3. RUN      it runs the packet's units with its own key: A2 loops of A0 reads (the storm site's public API) and A1 model calls.
//   4. RESULT   it writes packets/<id>/result-<runner>.json (signed; the same shape as a run) and pushes it to dev.
//   5. PUBLISH  anyone runs `publish`: every verified result becomes runs/<file>.json and runs/index.json; CI deploys; the site replays it.
// Model text is never stored: lengths, sha256 and validity only. Every packet carries its budget; the runner checks the router's credit.
//   node tools/swarm.mjs ladder  --rung r0..r5                                  (a run by this agent alone, straight to runs/)
//   node tools/swarm.mjs issue   --id ID --tasks a,b --models m1,m2 [--for WHO] [--budget-usd N] [--tries 3]
//   node tools/swarm.mjs run     --id ID --as AGENT --env "R1 Claude Code cloud" --account LABEL
//   node tools/swarm.mjs verify  | list | publish
// In a proxied cloud container: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
process.env.LLM_DAILY_CAP_USD ||= arg('--cap-usd', '25');      // Dinis, 21:4x UTC: "yes, you can raise the 5-daily cap absolutely"
const STORM = 'https://storm-charles.promptugal.news/api/v1/2026-11-10-storm-charles/';
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const short = (m) => m.split('/').pop();

// The storm site's scheduled work, cut into tasks (public data only; watch/websummit.json is left out: no automated reading of websummit.com).
export const TASKS = {
  warnings: { dataset: 'weather/warnings.json', ask: 'the highest IPMA warning level in force for Lisbon now, for what, and until when' },
  forecast: { dataset: 'weather/forecast.json', ask: "tomorrow's forecast for Lisbon: rain and the strongest wind" },
  stations: { dataset: 'weather/stations.json', ask: 'the strongest gust observed in Lisbon in the latest hour, and where' },
  tides: { dataset: 'exposure/tides.json', ask: 'the next high water at Cascais and its height' },
  transport: { dataset: 'transport/services.json', ask: 'which transport operators are not running normally' },
  flights: { dataset: 'transport/flights.json', ask: 'how many flights at Lisbon in the latest count, against normal' },
  trains: { dataset: 'transport/trains.json', ask: 'which train lines around Lisbon are disrupted' },
  ferries: { dataset: 'transport/ferries.json', ask: 'whether the Tagus ferries are running' },
  metro: { dataset: 'transport/metro.json', ask: 'whether the Lisbon metro is running normally' },
  communiques: { dataset: 'weather/communiques.json', ask: "IPMA's latest communiqué: what it says and when" },
  airport: { dataset: 'weather/airport.json', ask: 'the latest observed wind at Lisbon airport (METAR)' },
  rain: { dataset: 'weather/lisbon-rain.json', ask: 'the most rain in one hour at a Lisbon station recently' },
};
export const MODELS = ['deepseek/deepseek-v4-flash', 'mistralai/mistral-small-2603', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen3.7-flash'];
// Anthropic list prices per million tokens (in/out), read from https://openrouter.ai/api/v1/models at 21:5x UTC, 11 Nov 2026:
// the POTENTIAL cost of the same tokens on Claude (not spent: the calls went to open-weight models).
const CLAUDE = { 'claude-haiku-5.5': [0.1, 0.5], 'claude-sonnet-5.5': [2, 10], 'claude-opus-5.5': [4, 20] };

// ---------- keys: every packet, result and LLM call is signed by a key made for it (the altitudes: every unit holds a key pair)
const deep = (o) => (o && typeof o === 'object' ? (Array.isArray(o) ? o.map(deep) : Object.fromEntries(Object.keys(o).sort().map((k) => [k, deep(o[k])]))) : o);
const bytes = (o) => Buffer.from(JSON.stringify(deep(o)));
function identity(altitude, name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const fp = 'sha256:' + sha(pub).slice(0, 16);
  return { fp, sign: (body) => ({ body, by: { altitude, name, fp, pub, signed_at: now() }, sig: crypto.sign(null, bytes({ body, fp }), privateKey).toString('base64') }) };
}
export function verify(env) {
  try { const k = crypto.createPublicKey({ key: Buffer.from(env.by.pub, 'base64'), format: 'der', type: 'spki' }); return crypto.verify(null, bytes({ body: env.body, fp: env.by.fp }), k, Buffer.from(env.sig, 'base64')) && 'sha256:' + sha(env.by.pub).slice(0, 16) === env.by.fp; } catch { return false; }
}

// ---------- the engine: one runner, some tasks, some models; A2 loops of A0 reads and A1 calls; returns a run (nodes, edges, timeline, metrics)
export async function execute({ title, story, tasks, models, loop = true, kind = null, tries = 3, runner, env, account, chain = [], budget, maxParallel = 64, llm = path.join(ROOT, 'tools/llm.mjs'), hook = null }) {
  // kind (the Runs repo): 'A2' loops until valid, 'A1' one call per task and model, 'A0' reads only; hook(unit, phase, node, more) streams each event (flows)
  if (kind === 'A1') { loop = false; tries = 1; } if (kind === 'A0') models = [];
  const { call, credit } = await import(llm);
  const cr = models.length ? await credit() : { ok: false };
  if (models.length && cr.ok && cr.remaining != null && cr.remaining < (budget?.usd || 1) + 5) throw new Error(`credit ${cr.remaining} USD is below the budget plus the 5 USD floor: not run`);
  const T0 = Date.now(), nodes = [], edges = [], timeline = [], calls = []; let live = 0, peak = 0, spent = 0;
  const node = (n) => (nodes.some((x) => x.id === n.id) || nodes.push({ ...n }), n.id);
  const edge = (from, to, kind) => edges.push({ from, to, kind });
  const ev = (unit, phase, more = {}) => { live += phase === 'start' ? 1 : phase === 'end' ? -1 : 0; peak = Math.max(peak, live); timeline.push({ t: Date.now() - T0, unit, phase, ...more }); if (hook) try { hook(unit, phase, nodes.find((n) => n.id === unit), more, edges); } catch (e) { console.error('hook:', String(e.message).slice(0, 120)); } };
  // the chain above the runner: person -> swarm -> packet ... (given by the caller), then the runner itself
  let up = null; for (const c of chain) { node(c); if (up) edge(up, c.id, c.edge || 'asks'); up = c.id; }
  const ag = node({ id: 'runner', kind: 'agent', altitude: 'A3', label: runner, env, account });
  if (up) edge(up, ag, 'runs'); ev(ag, 'start');
  const or = models.length ? node({ id: 'openrouter', kind: 'provider', altitude: 'M', label: 'OpenRouter' }) : null;
  const slots = []; const gate = async (fn) => { while (slots.length >= maxParallel) await Promise.race(slots); const p = fn().finally(() => slots.splice(slots.indexOf(p), 1)); slots.push(p); return p; };
  async function read(parent, tid) {
    if (parent.startsWith(ag + ':')) { node({ id: parent, kind: 'compute', altitude: 'A0', label: `task ${tid}` }); if (!edges.some((e) => e.to === parent)) edge(ag, parent, 'runs'); }
    const t = TASKS[tid], u = node({ id: `${parent}/read`, kind: 'compute', altitude: 'A0', label: `read ${t.dataset}` });
    const d = node({ id: `data:${tid}`, kind: 'dataset', altitude: 'D', label: t.dataset, url: STORM + t.dataset });
    edge(parent, u, 'runs'); edge(u, d, 'reads'); ev(u, 'start');
    const r = await fetch(STORM + t.dataset); const body = await r.text();
    Object.assign(nodes.find((n) => n.id === d), { bytes: body.length, sha256: sha(body).slice(0, 16), read_at: now() });
    ev(u, 'end', { ok: r.ok, bytes: body.length }); return body;
  }
  async function ask(parent, tid, model, input, attempt) {
    const t = TASKS[tid], key = identity('A1', `LLM call ${tid} ${short(model)} #${attempt} by ${runner}`);
    const u = node({ id: `${parent}/call:${short(model)}#${attempt}`, kind: 'llm-call', altitude: 'A1', label: `${short(model)} #${attempt}`, model, key_fp: key.fp });
    edge(parent, u, 'calls'); edge(u, or, 'via'); ev(u, 'start');
    if (budget && spent >= budget.usd) { ev(u, 'end', { valid: false, refused: 'budget' }); return { unit: u, task: tid, model, valid: false, status: 'refused_budget', tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0 }; }
    const prompt = `From this public storm data (source: ${STORM}${t.dataset}), answer: ${t.ask}.\nReply with JSON only: {"headline": "<one sentence, at most 160 characters, facts from the data only>", "status": "normal" | "disrupted" | "warning" | "unknown"}.\nDATA (first 6000 characters):\n${input.slice(0, 6000)}`;
    // reasoning models (DeepSeek, Qwen) spend tokens thinking before they answer: give them room (qwen3.7-flash gave 0 of 18 at 300)
    const { text, line } = await call({ task: `WS-215/swarm/${tid}`, agent: runner, model, messages: [{ role: 'user', content: prompt }], max_tokens: /deepseek|qwen|anthropic/.test(model) ? 1500 : 300 });
    spent += line.cost_usd || 0;
    let parsed = null; try { parsed = JSON.parse((/\{[\s\S]*\}/.exec(text || '') || ['null'])[0]); } catch {}
    const valid = !!parsed && typeof parsed.headline === 'string' && ['normal', 'disrupted', 'warning', 'unknown'].includes(parsed.status);
    const c = { unit: u, task: tid, model, served: line.model_served, status: line.status, valid, verdict: valid ? parsed.status : null, tokens_in: line.tokens_in, tokens_out: line.tokens_out, cost_usd: line.cost_usd, latency_ms: line.latency_ms, ledger_id: line.id, answer_sha256: text ? sha(text).slice(0, 16) : null, answer_chars: text ? text.length : 0 };
    c.signed = key.sign({ task: tid, model: c.served, valid, tokens_in: c.tokens_in, tokens_out: c.tokens_out, cost_usd: c.cost_usd, answer_sha256: c.answer_sha256, prompt_sha256: sha(prompt).slice(0, 16) });
    calls.push(c); Object.assign(nodes.find((n) => n.id === u), { valid, tokens: c.tokens_in + c.tokens_out, cost_usd: c.cost_usd, latency_ms: c.latency_ms });
    ev(u, 'end', { valid, cost_usd: c.cost_usd }); return c;
  }
  async function aLoop(tid, model) {   // A2: read, ask, check, retry (at most `tries`), then stop. It cannot start others or schedule.
    const l = node({ id: `loop:${tid}:${short(model)}`, kind: 'loop', altitude: 'A2', label: `${tid} · ${short(model)}` });
    edge(ag, l, 'starts'); ev(l, 'start');
    const body = await read(l, tid); let c = null;
    for (let a = 1; a <= tries && !(c && c.valid); a++) c = await ask(l, tid, model, body, a);
    ev(l, 'end', { valid: c.valid }); return c;
  }
  if (loop) await Promise.all(tasks.flatMap((t) => models.map((m) => gate(() => aLoop(t, m)))));
  else if (kind === 'A1' || kind === 'A0') await Promise.all(tasks.map((t) => gate(async () => { const body = await read(`${ag}:${t}`, t); await Promise.all(models.map((m) => ask(`${ag}:${t}`, t, m, body, 1))); })));
  else if (tasks.length) { const body = await read(ag, tasks[0]); await Promise.all(models.map((m, i) => ask(ag, tasks[0], m, body, 1))); }
  const consensus = {};
  if (models.length > 1) for (const t of tasks) {
    const u = node({ id: `consensus:${t}`, kind: 'compute', altitude: 'A0', label: `consensus ${t}` }); edge(ag, u, 'runs'); ev(u, 'start');
    const v = calls.filter((c) => c.task === t && c.valid).map((c) => c.verdict), tally = v.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]; consensus[t] = { tally, verdict: top ? top[0] : 'unknown', agree: top ? top[1] : 0, of: models.length };
    ev(u, 'end');
  }
  ev(ag, 'end');
  const sum = (k) => calls.reduce((s, c) => s + (c[k] || 0), 0), tin = sum('tokens_in'), tout = sum('tokens_out');
  const byAlt = nodes.reduce((m, n) => ((m[n.altitude] = (m[n.altitude] || 0) + 1), m), {});
  return {
    v: 1, title, story, by: runner, issue: 'WS-215', environment: { label: env, account }, started_at: new Date(T0).toISOString().replace(/\.\d+Z$/, 'Z'), wall_ms: Date.now() - T0,
    budget, credit_before_usd: cr.ok && cr.remaining != null ? +cr.remaining.toFixed(2) : null, source: { workload: "the storm site's scheduled datasets, read over its public API", url: STORM },
    metrics: {
      units: byAlt, agents: byAlt.A3 || 0, loops: byAlt.A2 || 0, llm_calls: calls.length, compute: byAlt.A0 || 0, peak_concurrency: Math.max(0, peak - 1),
      valid_calls: calls.filter((c) => c.valid).length, tokens_in: tin, tokens_out: tout, openrouter_usd: +sum('cost_usd').toFixed(6),
      potential_claude_usd: Object.fromEntries(Object.entries(CLAUDE).map(([k, p]) => [k, +((tin * p[0] + tout * p[1]) / 1e6).toFixed(6)])),
      models: [...new Set(calls.map((c) => c.served).filter(Boolean))], latency_ms_p50: calls.length ? calls.map((c) => c.latency_ms).sort((a, b) => a - b)[calls.length >> 1] : null,
      not_measured: "the A3 runner's own Claude tokens (its Claude Code session): not exposed to the run",
    },
    consensus, calls, nodes, edges, timeline,
  };
}

// ---------- the ladder (rungs r0 to r5): runs by swarm.1 alone
const RUNGS = {
  r0: { title: 'Me → Claude → a task', tasks: [], models: [], loop: false, story: 'Dinis asks one Claude Code agent for one task. No model call leaves the agent.' },
  r1: { title: 'Me → Claude → compute', tasks: ['warnings'], models: [], loop: false, story: 'The agent runs code (A0): it reads one storm dataset over the public API.' },
  r2: { title: 'Me → Claude → one OpenRouter call', tasks: ['warnings'], models: MODELS.slice(0, 1), loop: false, story: 'The agent hands the reading to one open-weight model (A1) through the router.' },
  r3: { title: 'Me → Claude → many models', tasks: ['warnings'], models: MODELS, loop: false, story: 'The same question to four open-weight models at once, compared in code.' },
  r4: { title: 'Me → Claude → loops', tasks: Object.keys(TASKS).slice(0, 6), models: MODELS.slice(0, 1), loop: true, story: 'Six loops (A2), one per storm task: read, ask, check, retry until valid.' },
  r5: { title: 'Me → Claude → a swarm of loops', tasks: Object.keys(TASKS).slice(0, 6), models: MODELS, loop: true, story: 'Every storm task on every model: 24 loops at once, then a consensus per task in code.' },
  r4c: { title: 'Me → Claude → Claude models', tasks: Object.keys(TASKS).slice(0, 6), models: ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'], loop: true, story: 'The same six storm loops, now on Claude Haiku and Sonnet through the router: real Anthropic tokens and cost, next to the open-weight runs.' },
  r5b: { title: 'Me → Claude → a bigger swarm', tasks: Object.keys(TASKS), models: MODELS, loop: true, story: 'Twelve storm tasks on four models: 48 loops at once.' },
};
const ME = 'swarm.1.fringe@PrompTugal.dinis', ENV = 'R1 Claude Code cloud', ACCOUNT = 'riskmandate-personal';
const write = (file, o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o, null, 1) + '\n'); };
async function ladder() {
  const rid = arg('--rung', 'r0'), R = RUNGS[rid]; if (!R) throw new Error('rungs: ' + Object.keys(RUNGS).join(', '));
  const budget = { usd: +arg('--budget-usd', '1'), calls: R.tasks.length * R.models.length * (R.loop ? 3 : 1), sessions: 0 };
  const run = await execute({ ...R, runner: ME, env: ENV, account: ACCOUNT, budget, chain: [{ id: 'dinis', kind: 'person', altitude: 'P', label: 'Dinis' }] });
  const id = `${run.started_at.replace(/[-:]/g, '').slice(0, 13)}-${rid}`; Object.assign(run, { id, rung: rid, kind: 'ladder', for: 'Dinis Cruz' });
  write(path.join(ROOT, 'runs', `${id}.json`), run); index(); say(run);
}
const say = (r) => console.log(`${r.id}: ${r.title}: ${r.nodes.length} nodes, ${r.metrics.llm_calls} calls (${r.metrics.valid_calls} valid), ${r.metrics.tokens_in}+${r.metrics.tokens_out} tokens, ${r.metrics.openrouter_usd} USD (Sonnet: ${r.metrics.potential_claude_usd['claude-sonnet-5.5']}), ${r.wall_ms} ms, peak ${r.metrics.peak_concurrency}`);

// ---------- packets: the GitHub flow
const PK = path.join(ROOT, 'packets');
function issue() {
  const id = arg('--id'), tasks = arg('--tasks', 'warnings').split(','), models = arg('--models', MODELS.slice(0, 3).join(',')).split(',');
  for (const t of tasks) if (!TASKS[t]) throw new Error('unknown task ' + t + ': ' + Object.keys(TASKS).join(', '));
  const tries = +arg('--tries', '3'), body = {
    v: 1, id, altitude: 'A2', from: ME, for: arg('--for', 'any runner, any account'), issued_at: now(), title: arg('--title', `Storm: ${tasks.join(', ')} on ${models.length} models`),
    mandate: 'Read the named storm datasets from the storm site\'s public API and answer each task\'s question, checked, on each named model. Nothing else.',
    grant: ['read.web:storm-charles.promptugal.news/api/v1', 'call.llm:openrouter.ai (through tools/llm.mjs)', 'write.file:packets/<id>/result-<runner>.json', 'push.git:dev'],
    tasks, models, tries, budget: { usd: +arg('--budget-usd', '0.25'), calls: tasks.length * models.length * tries, sessions: 0 },
    output: 'packets/<id>/result-<runner>.json, signed by a key made for the run; model text never stored',
    how: 'node tools/swarm.mjs run --id <id> --as <your agent name> --env "<runtime>" --account <account label>; then commit and push to dev',
  };
  const me = identity('A4', `issuer: ${ME}`); write(path.join(PK, id, 'packet.json'), me.sign(body));
  console.log(`packet ${id}: ${tasks.length} tasks × ${models.length} models, budget ${body.budget.usd} USD / ${body.budget.calls} calls, signed ${me.fp}`);
}
async function runPacket() {
  const id = arg('--id'), as = arg('--as'), env = arg('--env'), account = arg('--account', 'unknown');
  if (!id || !as || !env) throw new Error('run needs --id, --as <agent> and --env <runtime>');
  const p = JSON.parse(fs.readFileSync(path.join(PK, id, 'packet.json'), 'utf8'));
  if (!verify(p)) throw new Error('packet signature does not verify: not run');
  const P = p.body, key = identity('A3', `runner: ${as} for ${id}`);
  const run = await execute({ title: P.title, story: `Packet ${id}, issued by ${P.from} through GitHub, run by ${as} on ${account}.`, tasks: P.tasks, models: P.models, tries: P.tries, loop: true, runner: as, env, account, budget: P.budget,
    chain: [{ id: 'dinis', kind: 'person', altitude: 'P', label: 'Dinis' }, { id: 'swarm.1', kind: 'swarm', altitude: 'A4', label: P.from }, { id: 'github', kind: 'capability', altitude: 'C', label: 'GitHub (dev)', edge: 'pushes' }, { id: `packet:${id}`, kind: 'task', altitude: 'T', label: `packet ${id}`, edge: 'carries' }] });
  Object.assign(run, { id: `${id}--${as.split('@')[0]}`, kind: 'packet', packet: id, packet_fp: p.by.fp, runner_key_fp: key.fp });
  const safe = as.replace(/[^A-Za-z0-9.@-]/g, '_');
  write(path.join(PK, id, `result-${safe}.json`), key.sign(run)); say(run);
  console.log(`next: git add packets/${id} && git commit (subject "${as}: ran packet ${id}") && push to dev`);
}
function results() {
  if (!fs.existsSync(PK)) return [];
  return fs.readdirSync(PK).flatMap((id) => {
    const dir = path.join(PK, id); if (!fs.existsSync(path.join(dir, 'packet.json'))) return [];
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'packet.json'), 'utf8'));
    const rs = fs.readdirSync(dir).filter((f) => /^result-.*\.json$/.test(f)).map((f) => ({ f, r: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
    return [{ id, p, pv: verify(p), rs: rs.map(({ f, r }) => ({ f, r, ok: verify(r) && r.body.packet_fp === p.by.fp && r.body.calls.every((c) => !c.signed || verify(c.signed)) })) }];
  });
}
function check() {
  let bad = 0;
  for (const x of results()) { if (!x.pv) bad++; x.rs.forEach((r) => r.ok || bad++);
    console.log(`${x.id}: packet ${x.pv ? 'verified' : 'NOT VERIFIED'}, for ${x.p.body.for}; results: ${x.rs.map((r) => `${r.r.body.by} on ${r.r.body.environment.account} ${r.ok ? 'verified' : 'NOT VERIFIED'} ${r.r.body.metrics.valid_calls}/${r.r.body.metrics.llm_calls}`).join('; ') || 'none yet (open)'}`); }
  process.exitCode = bad ? 1 : 0;
}
function publish() {   // every verified result becomes a run on the site
  let n = 0; for (const x of results()) for (const r of x.rs.filter((r) => r.ok && x.pv)) { write(path.join(ROOT, 'runs', `${r.r.body.id}.json`), { ...r.r.body, signed_by: r.r.by.fp }); n++; }
  index(); console.log(`published ${n} verified results to runs/`);
}
function index() {
  const dir = path.join(ROOT, 'runs');
  const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort().map((f) => { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { file: f, id: r.id, kind: r.kind || 'ladder', rung: r.rung || null, packet: r.packet || null, runner: r.by, account: r.environment.account, title: r.title, llm_calls: r.metrics.llm_calls, openrouter_usd: r.metrics.openrouter_usd }; });
  write(path.join(dir, 'index.json'), { about: 'Every recorded run: the ladder (by swarm.1 alone) and packets run by runners on any account (the GitHub flow). One file per run.', updated: now(), runs });
}

process.on('unhandledRejection', (e) => {
  const m = String(e && (e.cause && e.cause.message || e.message) || e); console.error('swarm:', m.slice(0, 300));
  if (/fetch failed|ECONNREFUSED|certificate/i.test(m)) console.error("hint: in a proxied cloud container, run node with NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt");
  process.exit(1);
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'ladder') await ladder(); else if (cmd === 'issue') issue(); else if (cmd === 'run') await runPacket();
  else if (cmd === 'verify' || cmd === 'list') check(); else if (cmd === 'publish') publish(); else if (cmd === 'index') index();
  else console.log('usage: node tools/swarm.mjs ladder --rung r0..r5b | issue --id ID --tasks a,b --models m1,m2 | run --id ID --as AGENT --env ENV --account A | verify | publish');
}
