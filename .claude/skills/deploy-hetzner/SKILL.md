---
name: deploy-hetzner
description: >
  Dispatch and certify the Club Arena poker engine using the repository-owned,
  exact-SHA sealed Hetzner workflow. Use for engine deploy, restart, ship, or
  production-release requests. Never deploy through World Hub, raw docker, or
  direct SSH.
version: 3.0.0
---

# Club Arena Sealed Hetzner Engine Release

## You almost certainly do not have to do anything

A merge to `main` that touches `server/**` deploys itself:

```
push to main -> stage-engine-release.yml (detect + dispatch the exact SHA)
             -> auto-deploy-hetzner.yml  (test, build, wait for the :55 break,
                                          cut over, prove, seal)
```

If the change is merged, the release is already in flight or already done.
**Read the state before you act.** Dispatching a second run for a SHA that is
already moving does not make it faster.

## The hosts, verified 2026-09-12 by SSH

| What            | Address           | Hostname            |
| --------------- | ----------------- | ------------------- |
| **The engine**  | `5.161.252.33`    | `club-arena-engine` |
| The TURN server | `178.156.160.206` | `club-arena-turn`   |

`178.156.160.206` is **not** the engine. It runs no engine container and has no
`/opt/club-arena`. Version 2.0 of this file and every version before it named it
as the deploy target, and an agent following those instructions would have
`ssh`ed into the voice relay and built nothing.

The working key on Dan's Mac is at `~/.ssh/hetzner_ed25519`. Use it with
`-o IdentitiesOnly=yes`; the other `hetzner_*` keys on that machine are all
rejected. **Read-only inspection only.** Never put key material in this or any
other file.

## Credential boundary

The workflow reads only these Club Arena repository secrets:

- `HETZNER_SSH_PRIVATE_KEY`
- `HETZNER_HOST`
- `HETZNER_HOST_KEY`
- `DATABASE_URL` (append-only deployment receipt only)

Never read, copy, print, or store their values in a workstation `.env`,
Markdown, another repository, or a command. There is no legacy key alias, World
Hub fallback, password path, or local SSH-key fallback. CLAUDE.md 10.84: an
agent may say which credential is wrong and where it lives. An agent never
sets one.

## There is exactly one way the container is started

`server/scripts/engine-up.sh` is, in its own words, "THE single source of truth
for how the Club Arena engine container is run". Everything that starts the
engine goes through it: the release transaction, the supervisor, and recovery.

A hand-rolled `docker run` is not a shortcut, it is a different engine. It
silently drops:

- `--label autoheal=true` - `sp-autoheal` restarts the engine when Docker marks
  it unhealthy, and it finds the container by that label. Without it, an
  unhealthy engine stays unhealthy.
- `--label sp.role=engine` - the release transaction refuses to cut over when it
  finds an engine container it does not manage ("an unmanaged engine container
  is running on this host").
- `--label sp.release.sha=<sha>` - this is what every proof reads to decide what
  production is running. An unlabelled container cannot be verified at all.
- `--log-opt max-size=50m --log-opt max-file=5` - unbounded `json-file` logs
  fill the disk.
- the health check timings (`20s`/`15s`/`300s`/3), tuned so a saturated event
  loop is not mistaken for a dead engine.
- the `flock` on `/var/lock/club-arena-engine-up.lock`, which is what stops two
  concurrent starts racing on the container name.

So: **never `docker build`, `docker run`, `docker stop`, `git pull` in
`/opt/club-arena`, or `docker image prune` on that box.** Those five commands
were the body of version 2.0 of this file.

## Image tags

| Tag                              | Meaning                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `club-arena-engine:<40-hex sha>` | **Immutable.** The tag IS the commit. Built once               |
| `club-arena-engine:current`      | What the seal says production should be running                |
| `club-arena-engine:previous`     | The rollback source the transaction proves before it cuts over |
| `...:<sha>-candidate-<n>`        | Build scratch; `retain-engine-images.sh` removes these         |

`retain-engine-images.sh` keeps the sealed, running and leased images plus five
recent rollback tags. Do not prune by hand: you would be deleting the image the
next rollback needs.

## Verify before you act

```bash
# What does production actually serve? (cache-busted; the CDN lies)
curl -s "https://engine.smarter.poker/health?nocache=$(date +%s%N)" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("releaseSha"), d.get("instanceId"), d.get("liveness"))'

# What does main require?
git -C ~/Documents/club-arena fetch --no-tags origin main
git -C ~/Documents/club-arena log origin/main -1 --format=%H -- \
  'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**'

# What did the pipeline itself say about every recent attempt?
#   SELECT at, target_sha, shipped, reason FROM ca_engine_deploy_attempts
#   ORDER BY at DESC LIMIT 20;   -- Supabase MCP, read-only
```

The ledger is the answer to "why is production behind", and it is almost always
already written down. On 2026-09-12 fourteen consecutive rows said so while an
investigation went looking at the engine.

Read-only inspection on the box, when the ledger is not enough:

```bash
SSH="ssh -i ~/.ssh/hetzner_ed25519 -o IdentitiesOnly=yes root@5.161.252.33"
$SSH 'systemctl list-units "club-arena-engine-release*" --all --no-legend'
$SSH 'journalctl -u "club-arena-engine-release-v1@<run-id>-1.service" --no-pager -o cat | tail -40'
$SSH 'tail -c 4000 /var/lib/club-arena/engine-release-audit.jsonl'
$SSH '/usr/local/lib/club-arena/engine-control/engine-release-seal.py get desired-sha'
```

## Dispatch, only when the automatic path did not run

The signal is one repository dispatch carrying one full lowercase SHA. `gh` is
**not installed on Dan's Mac** (AGENT-PLAYBOOK section 8b), so use `curl`:

```bash
TARGET_SHA=<exact-merged-sha>
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches \
  -d "{\"event_type\":\"deploy-club-arena-engine\",\"client_payload\":{\"ref_sha\":\"$TARGET_SHA\"}}"
```

The workflow exposes no force input and no maintenance bypass, deliberately.
The target must be the newest engine-affecting commit on protected main, or
preflight refuses it.

## What "deployed" means

The run is complete only when all of the following are true:

1. `ca_engine_deploy_attempts` has a row for this SHA with `shipped = true`.
2. A cache-busted `https://engine.smarter.poker/health` reports that exact
   `releaseSha`, `running: true`, and `liveness: "ok"`.
3. The sealed instance is stable, tables are dealable, and hands advance.

A green workflow is not evidence and neither is a merged pull request.
AGENT-PLAYBOOK section 7: a green tick answers "did it merge"; only production
answers "did it ship".

## When it does not ship

The run annotates **NOT DEPLOYED** with the reason, and the ledger records which
half of the pipeline stopped:

| Reason in the ledger                                                           | What happened                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `stood down before cutover; protected main had moved to <sha>`                 | Superseded. The named successor owns the next break. Nothing is wrong with your code |
| `the durable Hetzner release transaction did not complete; ...`                | The release tried and stopped. Read the unit journal                                 |
| `the release sealed but production identity could not be independently proved` | It cut over and the proof failed. Look at the engine                                 |
| `production already proved this exact release`                                 | Already live                                                                         |

**Fix forward.** The host transaction restores the previously sealed image by
itself when a cutover cannot be proved; there is no operator rollback input and
you must never improvise one by re-pointing `:current` by hand. Push the fix and
let the same lane carry it.

If several consecutive attempts ship nothing, the hourly
`production-integrity-audit.yml` raises **ENGINE DEPLOY STARVATION** and says
whether the release lane or the code is at fault. Read that before re-pushing
the same commit.
