# The monitoring deploy deploys (2026-09-06)

## What was found

At 06:38 CDT the cluster controller began failing every tick with
`constraint "managed_game_contract_version_game_kind_game_id_contract_ha_key"
... does not exist` - a migration from the table-management programme had
replaced a constraint that a function the tick reaches still named. It ran
for 65 minutes (683 `controller_tick_error` rows, zero `seat_moved`) and
resolved itself when a later migration in that programme replaced the
function. Nobody was paged.

`ClusterPassErrors` (`sum(increase(poker_cluster_pass_errors_total[15m])) >=
10`) is declared in `infra/monitoring/alert-rules.yml`, merged 2026-09-05 in
#3120. The counter DID rise: 178 in the fifteen minutes at 12:30 UTC. The rule
was not loaded on the box. `check-alert-rules-match.mjs` at 09:58 CDT:

    DECLARED HERE, NOT RUNNING ON THE BOX (17):
      ClusterControllerStalled, ClusterFeedersAbandoned, ClusterMovesExpiring,
      ClusterPassErrors, ClusterPassLatchReleased, ClusterPassSlow,
      ClusterTickingNothing, EngineCannotReachAuth, EngineRefusingSessions,
      EngineRefusingSessionsInVolume, EngineRestartedOutsideTheBreak,
      MonitoringCanary, StatsAllInEquityCoverageLow, StatsHandIndexLagging,
      StatsHealthReadStale, StatsLiveTriggerMissingHands,
      StatsWitnessAuditDisagrees
    THE CANARY IS NOT IN ALERTMANAGER.

The live `alert-rules.yml` on engine-01 carried 9 groups; the repo's carries 12. CLAUDE.md 10.84 was written this morning about exactly this, and the
workflow it prescribes, `deploy-monitoring.yml` (#3304), had run once, at
12:23 UTC, and failed. Reading its log:

1. **The Deploy step deployed nothing and was green.** It ran
   `curl -fsSL https://raw.githubusercontent.com/<repo>/main/infra/monitoring/deploy.sh | bash`
   on the box. The repository is private; raw answers 404; `bash` reads an
   empty stdin and exits 0; `| tail -60` reports tail's exit. Success.
2. **The verify step failed for the wrong reason.** `check-alert-rules-match.mjs`
   execs `ssh root@host` with no `-i`; the runner's key is at `~/.ssh/id_deploy`
   and only the `~/hssh` wrapper uses it. `Permission denied (publickey)`,
   exit 2. Red, but a red that hides the green above it.
3. **A deploy that had worked would have unmounted the pager.** The box's
   `docker-compose.yml` mounts `./cron_secret:/etc/alertmanager/cron_secret`
   because `alertmanager.yml` reads its webhook token from that file
   (`credentials_file`); the repo's compose did not carry the mount. #3304's
   title was "the pager survives a deploy". It would not have.
4. **`deploy.sh` would have copied a placeholder over the live Caddyfile.**
   The repo's `Caddyfile` has `REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT`; the
   box's has the real hash; they differ, so the script copies the repo's over
   (backing up first) and then declines to reload because of the placeholder.
   The next `systemctl reload caddy` by anybody would have locked every
   operator out of the monitor.
5. **`deploy.sh` itself cannot clone.** `git clone https://github.com/...`
   of a private repo on a box with no credentials. `/opt/smarter-poker-
monitoring-src` has never existed; every file in the run dir is a plain
   copy somebody scp'd, which is the "hand-written rule" 10.84 describes.

## What was done

**Immediately, by hand, the way the workflow should have** (10:00 CDT): the
eight files `prometheus.yml` loads or `docker-compose.yml` mounts were copied
from `origin/main` verbatim over the box's copies (backed up as
`*.bak.<epoch>`), `promtool check rules` and `amtool check-config` passed,
both services were reloaded over their lifecycle endpoints (HTTP 200), and
`check-alert-rules-match.mjs` reported

    repo declares 89; the box is running 89.
    OK - the box is running exactly what this repo declares, and the canary is alive.

The box's `docker-compose.yml` was NOT replaced (it carried the mount the repo
lacked). `MonitoringCanary` reached Alertmanager at 15:01 UTC.

**Then the repo, so the workflow does this itself:**

- `docker-compose.yml` mounts `cron_secret`, matching the box.
- `deploy-monitoring.yml` ships the runner's own `infra/monitoring/` over the
  deploy key (`tar` to a staging dir, `cp -R` in place - a bind-mounted file
  follows its inode, and `tar`'s unlink-and-recreate would leave the running
  container reading the old one), stamps `.deployed-from` with the sha, and
  runs `MONITORING_SRC_FROM_CHECKOUT=1 bash deploy.sh` with no pipe on the
  line. It writes an ssh `Host` entry so the verify step's bare `ssh` uses the
  key.
- `deploy.sh` gains the checkout mode (refuses if nothing was shipped), asks
  Prometheus and Alertmanager to reload after `compose up` and fails if either
  answers anything but 200, and leaves a live Caddyfile that carries a real
  hash alone.
- `tests/the-monitoring-deploy-deploys.law.test.ts` pins all of it.

## What this does not fix

`ClusterPassErrors` needs ten errors in fifteen minutes. This morning's outage
produced 178. The 8-second statement timeouts on `fn_cash_clusters_tick_all`
(9 in three hours, mean 1,187 ms, max 7,993 ms) are below it and are a
separate defect, handled separately.
