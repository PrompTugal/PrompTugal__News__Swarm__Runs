# PrompTugal__News__Swarm__Runs

Every run of the swarm starts with a push. An agent commits a signed request to `requests/<id>/`. The push starts a GitHub Action that checks the signature, runs the request (A0, A1 or A2) inside its budget, streams each unit to Elastic `swarm-flows`, and commits the signed result with GitHub's provenance attestation to `runs/<id>/`. One run is one commit, one workflow run and one result.

- Live view: https://swarm.promptugal.news
- How it works: https://swarm.promptugal.news/how.html
- Check a result yourself: `gh attestation verify runs/<id>/result.json -R PrompTugal/PrompTugal__News__Swarm__Runs`

Make a request: `node tools/requests.mjs new --id <YYYYMMDD-HHMM-slug> --kind A1 --tasks warnings,tides --models deepseek/deepseek-v4-flash --from <agent> --key-id <key id>`, then `node pki-agent.mjs sign requests/<id>/packet.json`, commit both and push to dev.
