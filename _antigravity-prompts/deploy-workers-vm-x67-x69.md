# Antigravity dispatch — Pull workers VM image (Phase F + G fixes)

## Context

Cowork (this audit) just shipped 4 commits to `Smarter-Poker/smarter-poker-workers`
and triggered the `release.yml` workflow which built + pushed
`ghcr.io/smarter-poker/smarter-poker-workers:latest` successfully (run id was
the 17:40 UTC dispatch). The Hetzner workers VM has NOT pulled the new
image yet — its container is still serving the previous build.

Cowork can't SSH (no access to `~/.ssh` on Dan's Mac), so this
single-step dispatch is for Antigravity to run.

## What's in the new image

Four worker fixes from the Phase F + G audit:

- **x67-1** (`1e630d4`) — `anti-cheat-bot-timing.ts` switched to intra-hand
  delta windowing. Pre-fix the std-dev was diluted by between-hand idle
  gaps (capped at 5 min) so even bots looked human. Now buckets per
  `(user, hand_id)` and only takes intra-hand deltas with a 90s cap.
- **x67c** (`f483048`) — `collusion-scan.ts` TIMING_CORRELATION pattern
  now reads from `hand_history.actions[]` JSONB instead of the empty
  `action_log` table. Pre-fix the detector was silently starved on
  every run.
- **x67d** (`4d24fd2`) — Hono middleware writes a `cron_execution_log`
  row per `/cron/*` request (start with status='running', update at end
  with success/error + duration_ms + error message). Closes the
  observability gap where Open Claw runs but nothing tracked which
  jobs fired.
- **x69** (`106a4e9`) — `anti-cheat-chip-dump.ts` two heuristic fixes:
  dedupe by `(player, flag_type, counterparty)` so multi-target dumpers
  get one flag per receiver instead of being skipped after the first;
  giverWinRate excludes the contaminated pair so skilled cheaters
  trigger the critical tier instead of being smeared as "bad players".

## Steps

```bash
cd /Users/smarter.poker/Documents/smarter-poker-workers
bash scripts/deploy-workers.sh
```

The script:

1. Verifies local prereqs (SSH key + Keychain entries)
2. SSHes to the workers VM
3. `docker compose pull` (fetches the just-built `:latest` from GHCR)
4. `docker compose up -d --force-recreate` (restarts the container)
5. `curl localhost:PORT/health` to confirm the new container responds
6. Tails logs for 5s

If the script fails at any step, paste full stderr + the relevant log
tail and stop. Do not "fix forward" — surface the failure.

## Verification (mandatory — do not skip)

After deploy script reports success, run all three:

### 1. Workers `/health` reports recent uptime

```bash
# Replace PORT with whatever's in /opt/workers/docker-compose.yml
ssh -i ~/.ssh/workers_ed25519 root@$(security find-generic-password -a smarter-poker -s workers-server-ip -w) \
  "curl -s localhost:8788/health"
```

Expected: JSON `{"status":"ok",...}` with `uptime` < 60s (proves
container actually restarted vs kept running the old image).

### 2. cron_execution_log starts populating (proves x67d is live)

In Supabase (project `kuklfnapbkmacvwxktbh`) run:

```sql
SELECT job_name, status, started_at, duration_ms
FROM cron_execution_log
ORDER BY started_at DESC
LIMIT 10;
```

Expected: within 5–10 minutes of deploy, fresh rows appear with
`job_name` like `/cron/anti-cheat-multi-account`,
`/cron/anti-cheat-bot-timing`, `/cron/collusion-scan`, etc. Pre-fix
this table had 1 stale row from March 14.

### 3. Bot-timing detector now scans per-hand deltas (x67-1)

Watch for at least one `/cron/anti-cheat-bot-timing` row in
cron_execution_log within 60 minutes (cron cadence is hourly). When
it appears:

- `status='success'` and `duration_ms` between 100–5000ms is healthy
- If `status='error'`, paste the `error` field

`anti_cheat_flags` rows with `flag_type='bot_timing'` are NOT expected
to appear yet — the bot fleet is designed to model variable human
timing and shouldn't trip the thresholds. Real human bots would
trigger.

## Reporting back

Post a one-liner with this shape:

```
DEPLOY: workers VM — Phase F+G batch
Pre-deploy image SHA: <sha>
Post-deploy image SHA: 4d24fd2 (or whatever GHCR :latest resolves to)
Container restart: ✓ (uptime <X>s)
Health endpoint: 200 ok
cron_execution_log first new row: <job_name> at <ts>
```

If anything fails, paste failure + last 50 lines of container logs
and stop.

## Hard rules

- Don't touch any code. The 4 commits are already on `main` and
  built into the GHCR image.
- Don't edit `/opt/workers/.env` on the VM.
- Don't `git push --force` or open PRs.
- Don't deploy any other branch.
