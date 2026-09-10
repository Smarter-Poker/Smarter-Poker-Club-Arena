---
name: deploy-hetzner
description: >
  Deploy the Club Arena poker engine server to Hetzner VPS via SSH + Docker.
  Use when the user says "deploy", "push to server", "deploy to hetzner",
  "deploy engine", "update VPS", "restart server", "ship it", "deploy to production",
  "push server changes", or anything about getting code changes onto the live
  engine.smarter.poker server. Also triggers on "hetzner", "VPS deploy", "docker deploy",
  or "server deploy". Use this even if the user just says "deploy" with no qualifier —
  Club Arena's server deployment always means Hetzner.
version: 2.0.0
---

# Deploy to Hetzner VPS — Club Arena Engine

The engine runs at `engine.smarter.poker` and serves all real-time poker game
logic. **You do not deploy it by hand.** A merge to `main` that touches
`server/**` is the deploy; the workflow builds, tests, seals and cuts over
inside the next hourly `:55` maintenance break. This file says how to get a
change onto that train, how to see that it shipped, and what the box looks
like when you need to read it — and why every manual `docker run` you might
remember from v1 of this skill is now actively undone by the host.

Rewritten 2026-09-10 after an incident where v1's IP (`178.156.160.206`)
turned out to be a dead host and its "one-liner" would have been reverted by
the supervisor within sixty seconds.

## Infrastructure (verified 2026-09-10)

| Component        | Detail                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| VPS IP           | `5.161.252.33` (hostname `club-arena-engine`; host clock is America/Chicago) |
| SSH user         | `root` — key auth; the Mac Studio's `~/.ssh` already holds it            |
| Repo on VPS      | `/opt/club-arena` — reset to the EXACT deployed commit by the workflow   |
| Container        | `club-arena-engine`, image `club-arena-engine:<full git sha>`            |
| Port             | `8080` (Caddy fronts it as `https://engine.smarter.poker`)               |
| Env file         | `/opt/club-arena/server/.env`                                            |
| Run-spec         | `server/scripts/engine-up.sh` — the ONLY definition of the run flags     |
| Release seal     | `/var/lib/club-arena/engine-release-seal.json` (root-owned; the authority) |
| Supervisor       | `club-arena-supervisor.timer` every 60 s → `engine-supervisor.sh`        |
| Self-heal        | `sp-autoheal` restarts the container when Docker's healthcheck says unhealthy |
| Health URL       | `https://engine.smarter.poker/health` — **CDN-cached; never use it to verify a deploy** |
| Engine log archive | `/var/log/club-arena-engine/engine-<archived>-started<...>-<sha>.log.gz`, one per container |
| Metrics          | Prometheus on the box at `localhost:9090` (`poker_*`, `process_cpu_seconds_total`, node exporter) |

## How a deploy actually happens

1. Your change is merged to `main` and touches `server/**`. (Docs-only or
   migration-only commits do not deploy anything.)
2. `.github/workflows/auto-deploy-hetzner.yml` runs on a `:35` cron tick (or
   is dispatched by `publish-watchdog` if GitHub drops the tick). It checks
   out that exact sha, runs the server tests, builds
   `club-arena-engine:<sha>`, and waits in the break gate.
3. At `:53` the engine announces the break; at `:55` it parks every table;
   the workflow cuts over using `engine-up.sh`; the sealed desired image ID
   moves only after the database witness confirms the new build is serving.
4. If nothing new is on `main`, the window costs one HTTP request and the
   engine does not restart. Merged engine code therefore waits **at most one
   hour** to ship, by design.

There is no faster path. A `workflow_dispatch` of the same workflow still
waits for the `:55` break — that is the point.

## Pre-merge checklist

1. `npx tsc --noEmit` at the repo root — zero errors.
2. Server tests pass locally for what you touched; the workflow will run them
   again and refuse to deploy on red.
3. If the change needs a database migration, **apply the migration first**
   (Supabase MCP `apply_migration`, one transaction) and confirm every RPC the
   new code calls exists in production:

   ```sql
   select p.proname, pg_get_function_identity_arguments(p.oid)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('fn_your_new_rpc', ...);
   ```

   On 2026-09-09 an engine change shipped whose migration was never applied;
   the engine called a function that did not exist for eight hours and the
   whole fleet wound down every hour. PostgREST answers a missing or
   mis-signatured function with 404 `PGRST202` — grep edge logs for it after
   any deploy that added an RPC.

## Verifying a deploy shipped (VIA THE DATABASE, never the health endpoint)

```sql
-- the running build: engine_leader.engine_version is the short sha
select instance_id, engine_version, acquired_at, heartbeat_at from engine_leader;

-- the restart dip and the rehydration ramp, minute by minute
select date_trunc('minute', created_at) m, count(*) hands, count(distinct table_id) tables
from hand_history where created_at > now() - interval '20 minutes' group by 1 order by 1;
```

A healthy cutover shows hands dropping to ~0 for the `:55–:00` break and
climbing back past the pre-break rate within three minutes. Then confirm on
the box:

```bash
ssh root@5.161.252.33 "docker ps --format '{{.Image}} {{.Status}}' | grep club-arena-engine"
```

The image tag IS the commit sha. A green workflow run is **not** a deployment
— the run reports SUCCESS with a step named "DID NOT DEPLOY" when the build
missed its window. Check the tag.

## Reading the box during an incident

```bash
# what is running and for how long
ssh root@5.161.252.33 "docker ps --format '{{.Names}} {{.Image}} {{.Status}}'; uptime"

# why the container last restarted (autoheal / supervisor / deploy)
ssh root@5.161.252.33 "docker logs --since 2h sp-autoheal 2>&1 | tail; \
  journalctl -u club-arena-supervisor --since '2 hours ago' --no-pager | grep -v -E 'Starting|Finished|Deactivated|Consumed' | tail -20"

# the current engine log, and the previous container's archived log
ssh root@5.161.252.33 "docker logs --timestamps --since 30m club-arena-engine 2>&1 | grep -v TurnFSM | tail -200"
ssh root@5.161.252.33 "ls -t /var/log/club-arena-engine/*.log.gz | head -3"

# event-loop lag and CPU for the last three hours (Prometheus on the box)
ssh root@5.161.252.33 "curl -s 'http://localhost:9090/api/v1/query?query=poker_event_loop_delay_p99_ms'"
```

`journalctl --since` takes **Chicago** local time on this host, not UTC.

Together with `docs/runbooks/tables-say-reconnecting.md`, which is the
first-four-minutes runbook for a "Reconnecting To The Table" page.

## What NOT to do (and why the host will undo it anyway)

- **Do not `docker build` / `docker run` / `docker restart` the engine by
  hand.** The supervisor compares the running image ID against the sealed
  desired image every 60 s and restores the sealed release when they differ.
  A hand-started container lives for at most one supervisor tick; a hand
  `docker stop` is recorded as a manual stop that `--restart always` ignores,
  and the supervisor brings the sealed release back. Neither leaves you where
  you think you are.
- **Do not `git pull` / `git reset` in `/opt/club-arena` on the box.** The
  workflow resets it to the exact deployed commit ("BUILD WHAT YOU TAG");
  anything you do there is overwritten on the next cutover and, until then,
  makes the tree disagree with the image.
- **Do not `docker image prune`.** The sealed last-known-good image is the
  rollback; v1 of this skill deleted it.
- **Do not restart outside the `:55` break** unless the runbook says the
  engine is dead (Dan, 2026-08-31, binding). Every restart reconnects every
  socket and rehydrates ~400 tables.

## Rollback

Rollback is a forward merge. Revert the offending commit on `main`; the next
`:55` window ships the revert. If the engine is down and cannot wait,
`engine-supervisor.sh` already restores the sealed last-known-good release on
its own — read its journal before doing anything, because it has probably
already done the thing you were about to do.

## Post-deploy record

Note the deploy in the changelog for the change (`docs/changelog/…`) with the
sha and the window it shipped in. `MIGRATION-CHANGELOG.md` is frozen history;
do not append to it.
