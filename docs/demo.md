# The demo: every run starts with a push (12 November 2026)

> swarm.1.dev.fringe@PrompTugal.dinis, for swarm.1.fringe@PrompTugal.dinis and Dinis Cruz (WS-215); landed by swarm.1. The design is architect.1's (PrompTugal__News__Fringe docs/handoffs/2026-11-11-swarm-runs-design.md). This runbook gives the commands to run at each step. The person at the keyboard holds the PKI session key that signs requests (today swarm.1, key id `swarm.1.fringe-dinis`).

Repository: https://github.com/PrompTugal/PrompTugal__News__Swarm__Runs (branch `dev`). Site: https://swarm.promptugal.news.

## Before the demo (done, or do it the hour before)

Requests already run: `20261111-2344-storm-a1` (A1), `20261111-2344-storm-a2` (A2) and `20261111-2350-storm-a1-fix` (A1).

Check that they still verify, from a fresh clone:

```bash
git clone https://github.com/PrompTugal/PrompTugal__News__Swarm__Runs runs && cd runs && git checkout dev
git clone --depth 1 https://github.com/PrompTugal/PrompTugal__News__Fringe ../fringe     # the requesters' public keys
for id in 20261111-2344-storm-a1 20261111-2344-storm-a2 20261111-2350-storm-a1-fix; do node tools/check-run.mjs $id --keys ../fringe/data/keys.json | tail -1; done
gh attestation verify runs/20261111-2350-storm-a1-fix/result.json -R PrompTugal/PrompTugal__News__Swarm__Runs
```

Also check:
- The router's credit covers the budget plus the engine's 5 USD floor: `node tools/llm.mjs --credit` in PrompTugal__News__Swarm.
- The tabs are open: the repository's commits, its Actions tab, the site, and Kibana's "Flows: swarm runs (every run starts with a push)".
- `pki-agent.mjs` is to hand, outside the repository. Its sha256 is `fcb28a1c…02ab`.

## Live: the third request

Run every command from the repository root on `dev`, after `git pull`.

### 1. Make the request

```bash
ID=$(date -u +%Y%m%d-%H%M)-storm-live
node tools/requests.mjs new --id $ID --kind A2 --tasks warnings,forecast,tides --models deepseek/deepseek-v4-flash,mistralai/mistral-small-2603 --tries 3 --usd 0.1 --minutes 5 --from swarm.1.fringe@PrompTugal.dinis --key-id swarm.1.fringe-dinis
node /path/outside/repo/pki-agent.mjs sign requests/$ID/packet.json      # writes packet.json.sig
cat requests/$ID/packet.json                                             # show: kind, budget, grant, mandate
```

Say: the request carries its own budget and grant, and the requester's key signs it. An A3 agent only starts runs, so it never runs here.

### 2. The commit (the push starts the run)

```bash
git add requests/$ID && git commit -m "swarm.1.fringe@PrompTugal.dinis: request $ID (A2), signed" -m "Agent: swarm.1.fringe@PrompTugal.dinis" -m "Issue: WS-215" -m "For: Dinis Cruz"
git push origin HEAD:dev
git log -1 --format='%H'                                                 # the request commit
```

Show it on GitHub: `https://github.com/PrompTugal/PrompTugal__News__Swarm__Runs/commit/<sha>`.

### 3. The Actions run

```bash
gh run list -R PrompTugal/PrompTugal__News__Swarm__Runs --workflow run.yml --branch dev --limit 1
gh run watch -R PrompTugal/PrompTugal__News__Swarm__Runs <run id>
```

Show it in the Actions tab:
- **plan** checks the signature against the Fringe's `data/keys.json`. An unsigned request or an unknown key is refused here. A push runs only the requests it adds, never one that already has a result.
- **run** has one job per request; flow events stream to Elastic while it runs.
- **commit** attests the result and commits it.

### 4. The result commit

```bash
git pull origin dev
git log -1 --format='%H %s' -- runs/$ID/result.json                     # "swarm-runs: results for <sha> (run <id>)"
node tools/check-run.mjs $ID --keys ../fringe/data/keys.json            # the whole chain; exit 0 = all verified
```

`check-run` prints the chain: request → request commit → Actions run → result commit → attestation. It then checks:
- the result's signature (a per-run ed25519 key that lived only during the run);
- that provenance.json's sha256 matches result.json;
- that the result answers this request;
- the request's own signature;
- the commit order.

For the screen, `--json` gives the same report in machine form.

### 5. The site

Open https://swarm.promptugal.news and press **Check GitHub now**. The new run appears from `runs/index.json` with its calls, valid answers and cost, and links to the commit and the Actions run.

### 6. Kibana

Open "Flows: swarm runs (every run starts with a push)" and filter on `flow: "$ID@*"`. One bar per unit: the Action (A0), each loop (A2), each call (A1). Every event carries the commit and the run URL.

### 7. Verify without trusting us

```bash
gh attestation verify runs/$ID/result.json -R PrompTugal/PrompTugal__News__Swarm__Runs
```

GitHub's OIDC identity signs the attestation. It binds this file to this workflow, this commit and this run.

## Scale: one push, N parallel jobs

```bash
node tools/requests.mjs batch --n 12 --kind A1 --tasks warnings,forecast,stations,tides,transport,flights --models deepseek/deepseek-v4-flash,mistralai/mistral-small-2603 --slug storm-scale --usd 0.02 --minutes 5 --from swarm.1.fringe@PrompTugal.dinis --key-id swarm.1.fringe-dinis
# it prints the ids and the total budget; then sign each one and push them in one commit:
for d in requests/*-storm-scale-*; do [ -f $d/packet.json.sig ] || node /path/outside/repo/pki-agent.mjs sign $d/packet.json; done
git add requests && git commit -m "swarm.1.fringe@PrompTugal.dinis: 12 requests (A1), signed" -m "Agent: swarm.1.fringe@PrompTugal.dinis" -m "Issue: WS-215" -m "For: Dinis Cruz" && git push origin HEAD:dev
```

- Ids are `<YYYYMMDD-HHMM>-<slug>-01..NN`. `--at` fixes the time and `--slug` the name. A request that already exists is never overwritten.
- `--spread` deals the tasks round-robin across the requests, so each job carries a share. Without it, every request carries every task.
- `--usd` and `--minutes` are per request. `batch` prints the total; write it in the run's budget before pushing.
- The workflow runs at most 20 jobs at once (`max-parallel: 20`). Leave room for the live request.

Afterwards: `for d in requests/*-storm-scale-*; do node tools/check-run.mjs ${d##*/} --keys ../fringe/data/keys.json >/dev/null && echo "ok ${d##*/}" || echo "FAIL ${d##*/}"; done`.

## If something goes wrong

| What you see | Why | Do |
|---|---|---|
| plan says `REFUSED: no active key` | the key id is not in the Fringe's data/keys.json, or it is not `active` | check `--key-id`; the key must be on Fringe `dev` |
| plan says `REFUSED: the signature does not verify` | packet.json changed after signing | sign again, commit, push |
| plan says `has a result already` | the request ran before; a push never re-runs it | re-run on purpose: Actions → swarm run → Run workflow, `ids` = the request id |
| no workflow run starts | the push did not touch `requests/**`, or it went to another branch | `git log -1 --stat`; push to `dev` |
| run job stops with "credit … below the budget plus the 5 USD floor" | the router's credit is low | top up, then re-run it with Run workflow |
| `check-run` says `result present: FAIL` | the commit job has not pushed yet, or you have not pulled | wait for the commit job; `git pull origin dev` |
| `check-run` skips the commit checks | shallow clone | `git fetch --depth=200 origin dev` |

Rerun without a new commit: Actions → **swarm run** → Run workflow → `ids` = `<id>[,<id>…]`. The request must already be committed; the result and its provenance then name the new run.

## Never on screen

Printing a key, a secret or the environment; prompt or answer text (only its sha256 is stored); websummit.com read by machine.
