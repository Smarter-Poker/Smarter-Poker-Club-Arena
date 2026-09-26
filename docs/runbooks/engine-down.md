# EngineDown

Runbook for `EngineDown` in `infra/monitoring/alert-rules.yml` (group
`engine-health`). Written 2026-09-26, when the rule's runbook link was replaced:
it had pointed at `https://monitor.smarter.poker/runbooks/engine-down`, a host
that has never served anything (404 from Vercel's wildcard).

## What it means

```
up{job="engine_game_server"} == 0   for: 1m   severity: critical
```

Prometheus on engine-01 could not scrape the engine's `/metrics` for over a
minute. `up` is written by Prometheus itself, not by the engine: the scrape job
`engine_game_server` in `infra/monitoring/prometheus.yml` targets
`host.docker.internal:8080` every 15s. A zero means the request failed or timed
out, so one of these is true:

- the `club-arena-engine` container is not running, is restarting, or is not
  listening on 8080;
- the process is alive but its event loop is so saturated that `/metrics` does
  not answer inside the scrape timeout;
- the host is down. Then Prometheus is down with it and this alert cannot be
  delivered at all; `MonitoringCanary` going silent is the signal for that case.

Player impact: no table can tick while the process is gone.

**This rule has no maintenance-break guard.** The engine restarts inside the
announced :55 break every hour (CLAUDE.md section 13) and is deliberately down
for roughly two of those five minutes. `for: 1m` is shorter than that gap, so
this rule can fire on a scheduled restart. `EngineScrapeDown` in
`engine-freeze-rules.yml` asks the same question with the break guard
(`unless max_over_time(poker_maintenance_break_active[6m]) == 1`) and is the
rule to trust for a real outage. The rule's own comment says it is kept so the
SLO rules that name this job still resolve. If `EngineDown` fires between :55
and :01 UTC and `EngineScrapeDown` does not, it is the scheduled restart.

## First checks

1. The clock: `date -u`. Inside :53-:01 with an engine release cutting over is
   expected; outside that window it is not.
2. The public health endpoint, from anywhere:
   `curl -s --max-time 10 https://engine.smarter.poker/health | head -c 400`.
   No answer at all means the process, or Caddy in front of it, is down. An
   answer with `"liveness":"ok"` while Prometheus says `up == 0` points at the
   scrape path (Docker networking, `host.docker.internal`), not at the engine.
3. On engine-01 (`5.161.252.33`; `178.156.160.206` is the TURN server, not the
   engine):
   - `docker ps --filter name=club-arena-engine`: running, and for how long;
   - `docker logs --since 10m club-arena-engine | tail -100`: the last thing it
     said;
   - `docker logs --since 30m sp-autoheal`: autoheal restarts the container
     when the Docker HEALTHCHECK (which reads `poker_engine_liveness`) fails;
   - `curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/metrics`: the
     same request Prometheus makes, from the host;
   - `dmesg -T | grep -i -E 'killed process|out of memory' | tail`: an OOM kill
     leaves nothing in the container log.
4. Prometheus itself, on the box:
   `curl -s localhost:9090/api/v1/targets | python3 -m json.tool | grep -A8 engine_game_server`.
   `lastError` for the scrape usually names the cause (connection refused,
   context deadline exceeded).

## Likely causes

| Signal                                                       | Cause                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Container restarting, autoheal log names it                  | Liveness went to 0; compare `poker_dead_stalled_tables` with `poker_dealable_tables`, then `docs/runbooks/tables-frozen.md` |
| Container exited, OOM in `dmesg`                             | Memory; `docs/runbooks/engine-memory.md`                                                                                    |
| Container up, `/metrics` times out, `/health` slow           | Event loop saturated; `docs/runbooks/tournament-scheduler-and-engine-saturation.md`                                         |
| `EngineRestartedOutsideTheBreak` fired too                   | An unannounced restart; that rule's description walks the autoheal, OOM and hand-run restart cases                          |
| Inside the break, an `auto-deploy-hetzner.yml` run is active | The scheduled cutover; confirm the new process answers `/health` with the expected `releaseSha` after :00                   |

## What not to do

- Do not `docker restart` the engine outside the :55 break to clear the alert.
  A restart voids every hand in flight on every table and drops every socket;
  section 13 permits it only inside the announced break. If the process is
  already gone, bringing it back is recovery; if it is alive and slow,
  restarting it is a second outage.
- Do not add a watchdog, cron or repair job as the answer (CLAUDE.md 10.11,
  10.12). Find the cause (an OOM, a hot loop, a crash) and change that line.
- Do not edit alert rules on the box. A rule change is a pull request in
  `infra/monitoring/` (CLAUDE.md 10.84).

## Where the owning code lives

- Scrape job: `infra/monitoring/prometheus.yml` (`engine_game_server`).
- `/metrics` and `/health`: `server/src/GameServer.ts` (`getStatus` and the
  Prometheus text built beside it), served from `server/src/index.ts`.
- Liveness verdict: `server/src/engine/EngineLivenessVerdict.ts`, pinned by
  `server/src/engineLiveness.test.ts`.
- Autoheal: `infra/monitoring/autoheal-compose.yml`.
- The break-guarded twin of this rule: `EngineScrapeDown` in
  `infra/monitoring/engine-freeze-rules.yml`.
