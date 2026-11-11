#!/usr/bin/env node
// One view of every run: runs/summary.json, small, for the site and Kibana. The commit job writes it next to runs/index.json.
//   node tools/summary.mjs [--print]
// Totals across all runs, per GitHub workflow run (a batch: one push, N jobs) and per requester:
//   requests committed, jobs run, units by altitude (A0..A3), calls, valid, tokens in/out, OpenRouter USD, potential Claude USD,
//   wall time (sum of jobs, and the span from the first start to the last end) and peak jobs at once (from each job's start and end).
// Only metrics: no prompt or answer text (none is stored). A run is runs/<id>/result.json; a request is requests/<id>/packet.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQ = path.join(ROOT, 'requests'), RUNS = path.join(ROOT, 'runs');
const ALT = ['A0', 'A1', 'A2', 'A3'];
const round = (x, d = 6) => +(+x || 0).toFixed(d);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'));
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

const requests = dirs(REQ).filter((id) => fs.existsSync(path.join(REQ, id, 'packet.json')));
const jobs = [];
for (const id of dirs(RUNS)) {
  const f = path.join(RUNS, id, 'result.json');
  if (!fs.existsSync(f)) continue;
  let b; try { b = JSON.parse(fs.readFileSync(f, 'utf8')).body; } catch { console.error(`summary: ${id}: result.json is not JSON, skipped`); continue; }
  const m = b.metrics || {}, start = Date.parse(b.started_at);
  jobs.push({
    request: b.request || id, kind: b.request_kind || null, requester: b.requester || b.by || null, run_url: b.run_url || null, commit: b.commit || null,
    start: Number.isFinite(start) ? start : null, end: Number.isFinite(start) ? start + (b.wall_ms || 0) : null, wall_ms: b.wall_ms || 0,
    units: Object.fromEntries(ALT.map((a) => [a, (m.units && m.units[a]) || 0])), peak_units: m.peak_concurrency || 0,
    calls: m.llm_calls || 0, valid: m.valid_calls || 0, tokens_in: m.tokens_in || 0, tokens_out: m.tokens_out || 0,
    usd: m.openrouter_usd || 0, claude: m.potential_claude_usd || {}, models: m.models || [],
  });
}

// peak jobs at once: sweep the start and end times (an end at the same instant as a start is counted first)
function peak(js) {
  const ev = js.filter((j) => j.start != null).flatMap((j) => [[j.start, 1], [j.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, max = 0, at = null;
  for (const [t, d] of ev) { live += d; if (live > max) { max = live; at = t; } }
  return { peak_jobs_at_once: max, peak_at: iso(at) };
}

function total(js) {
  const sum = (k) => js.reduce((s, j) => s + j[k], 0);
  const claude = {};
  for (const j of js) for (const [k, v] of Object.entries(j.claude)) claude[k] = round((claude[k] || 0) + v);
  const starts = js.map((j) => j.start).filter((x) => x != null), ends = js.map((j) => j.end).filter((x) => x != null);
  const first = starts.length ? Math.min(...starts) : null, last = ends.length ? Math.max(...ends) : null;
  return {
    jobs: js.length,
    units: Object.fromEntries(ALT.map((a) => [a, js.reduce((s, j) => s + j.units[a], 0)])),
    peak_units_in_one_job: js.reduce((s, j) => Math.max(s, j.peak_units), 0),
    calls: sum('calls'), valid: sum('valid'), valid_pct: js.length && sum('calls') ? round((100 * sum('valid')) / sum('calls'), 1) : null,
    tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'),
    openrouter_usd: round(sum('usd')), potential_claude_usd: claude,
    wall_ms_sum: sum('wall_ms'), span_ms: first != null ? last - first : 0, first_start: iso(first), last_end: iso(last),
    ...peak(js),
    models: [...new Set(js.flatMap((j) => j.models))].sort(),
  };
}

const group = (key) => {
  const g = {};
  for (const j of jobs) (g[j[key] || 'unknown'] ||= []).push(j);
  return g;
};
const byRun = Object.entries(group('run_url')).map(([url, js]) => {
  const t = total(js);
  return { run_url: url, run_id: (/\/runs\/(\d+)/.exec(url) || [])[1] || null, commit: js[0].commit, requests: js.map((j) => j.request), jobs: t.jobs, calls: t.calls, valid: t.valid, openrouter_usd: t.openrouter_usd, span_ms: t.span_ms, first_start: t.first_start, peak_jobs_at_once: t.peak_jobs_at_once };
}).sort((a, b) => String(a.first_start).localeCompare(String(b.first_start)));
const byRequester = Object.fromEntries(Object.entries(group('requester')).map(([who, js]) => {
  const t = total(js);
  return [who, { requests: requests.filter((id) => { try { return JSON.parse(fs.readFileSync(path.join(REQ, id, 'packet.json'), 'utf8')).from === who; } catch { return false; } }).length, jobs: t.jobs, units: t.units, calls: t.calls, valid: t.valid, tokens_in: t.tokens_in, tokens_out: t.tokens_out, openrouter_usd: t.openrouter_usd, potential_claude_usd: t.potential_claude_usd, wall_ms_sum: t.wall_ms_sum }];
}));

const ran = new Set(jobs.map((j) => j.request));
const out = {
  about: 'Every run of a committed request, added up: one view of the swarm runs. Written by tools/summary.mjs (in the commit job, next to index.json). Metrics only; no prompt or answer text.',
  updated: iso(Date.now()),
  totals: { requests: requests.length, requests_not_run: requests.filter((id) => !ran.has(id)).length, workflow_runs: byRun.length, ...total(jobs) },
  by_workflow_run: byRun,
  by_requester: byRequester,
  not_measured: 'GitHub queue time before a job starts; the requester agent\'s own Claude tokens.',
};
fs.writeFileSync(path.join(RUNS, 'summary.json'), JSON.stringify(out, null, 1) + '\n');
const T = out.totals;
console.log(`summary: ${T.requests} requests (${T.requests_not_run} not run), ${T.jobs} jobs in ${T.workflow_runs} workflow runs, ${T.calls} calls (${T.valid} valid), ${T.openrouter_usd} USD (Sonnet: ${T.potential_claude_usd['claude-sonnet-5.5'] ?? '?'}), peak ${T.peak_jobs_at_once} jobs at once, units A0 ${T.units.A0} A1 ${T.units.A1} A2 ${T.units.A2} A3 ${T.units.A3}`);
if (process.argv.includes('--print')) console.log(JSON.stringify(out, null, 1));
