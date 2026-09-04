# Finishing the monitoring audit: the four open items

2026-09-04 · branch `docs/sentry-realtime-programme`

The previous pass shipped alarms and left four things open. This closes them —
three fixed, and the fourth diagnosed precisely enough to hand over, because
fixing it needs a deploy I cannot verify from here.

---

## 1. THE STALE OPEN CLAW JOBS — one was never broken

Four jobs read stale. They are not the same problem.

### `/cron/player-stats-refresh` — the job was fine, the monitor was wrong

It was **deliberately removed** from `openclaw-cron-dispatcher.py` on
2026-09-03, with a full explanation in the file. It could never have worked:
the handler asks `fn_refresh_player_stats` for a 26-hour window — roughly 130
seconds of `hand_history` jsonb work — against PostgREST's 8-second
`service_role` statement timeout. Twenty-four fires a day, twenty-four
timeouts.

The statistics were never stale, because pg_cron job
`refresh-player-stats-hourly` (jobid 76, `'17 * * * *'`, 90-minute window,
advisory-locked) had been doing the same work **inside** Postgres where no
PostgREST timeout applies, succeeding 24 out of 24. Two schedulers for one job,
one structurally unable to finish. The right one was kept.

But `v_openclaw_job_staleness` has no concept of retirement, so a correctly
removed job reads `is_stale = true` forever. **Yesterday that cost nothing
because nothing read the view. Today it pages** — the alert I shipped this
morning would have fired on it every 30 minutes indefinitely, and an alarm
that is always on is an alarm nobody reads. That is exactly how
`financial_alerts` reached 1,345 unread rows.

Fixed properly rather than by silencing: `ca_retired_cron_jobs`, a table with a
mandatory `reason`, and the view now excludes what it lists. Seeded with this
one job and its documented reason.

The table's own comment carries the warning it needs: _retiring a job to
silence its alarm, rather than because the work moved or ended, is the failure
this table must not become. Broken jobs do not belong here — they belong fixed._

The migration asserts both directions: the retired job disappears from the
view, **and at least three genuinely stale jobs keep reporting**. A retirement
mechanism that quietly silenced the other three would be worse than no
mechanism at all.

### The other three are genuinely broken and still page

```
/cron/video-library-scraper   last success 2026-08-29 06:00
/cron/video-library-reels     last success 2026-08-29 07:00
/cron/venue-tournaments       last success 2026-09-02 04:00
```

**The two video-library jobs stopped the day `_resolve_script()` landed.** The
dispatcher comment dated 2026-08-29 explains the mechanism itself: these run a
local Python script, `SCRAPER_PY` used to resolve only against
`Path.home()/'Documents'/...` — Dan's Mac — and on Hetzner the file was absent,
so `should_skip_on_secondary()` skipped all five video-library jobs every day
_and logged the skip as normal operation_. Video ingestion depended on a laptop
process staying alive; when that stopped on 2026-04-22 the library froze for
129 days and nothing alerted.

The portability fix added a resolution order — `SP_SCRAPER_DIR`, then the
dispatcher's own directory, then the Mac path. **It resolves correctly only if
the scripts are deployed beside the dispatcher on Hetzner**, and the last
success being the same day that change landed says they are not.

**`/cron/venue-tournaments` has no handler at all.** There is no
`pages/api/cron/venue-tournaments.js` in the World Hub; the dispatcher maps it
to the workers host at `/cron/venue-tournaments` (line 894), so whether it
exists depends on the workers deployment.

**Both need `bash scripts/deploy-openclaw.sh` and someone watching a fire
cycle.** I have not run it: it restarts the dispatcher's systemd unit on
Hetzner and I cannot verify the result from here, and that script has a history
— it was silently broken for months against an SSH key that never existed.
These are now alertable, which is the part that was missing; they were silent
for up to 6.5 days with nothing able to say so.

---

## 2. `slo-rules.yml` AND `slo-alerts.yml` — the mistake was the definition

Both were `groups: []` with a `DISABLED` comment, while being declared in
`rule_files`, mounted in `docker-compose.yml`, and symlinked onto the host by
`deploy.sh`. Three layers of plumbing carrying nothing. They passed CI
legitimately through the drift check's documented `DISABLED` opt-out — which
has no expiry, had been open since 2026-08-28, and nobody owned closing it.

They were disabled because every rule read
`probe_success{job="vercel_health"}` from a blackbox-exporter this stack does
not deploy. That is still true.

**The mistake was equating "SLO" with "external HTTP probe."** A service level
objective is a promise about the service, and the promises this platform makes
to a player are about **dealing, responding and settling** — every one of which
the engine already measures and Prometheus already scrapes.

Seven recording rules and seven objectives, all against metrics that exist
today:

| Objective    | Rule                                              |
| ------------ | ------------------------------------------------- |
| Availability | 99% of scrapes over 30m, break-guarded            |
| Dealing      | hands/sec collapses while tables are still seated |
| Dealing      | a single table stalled >15 min                    |
| Responding   | p95 action processing >1s                         |
| Responding   | p95 broadcast latency >2s                         |
| **Settling** | **success ratio <99.5%**                          |
| Plumbing     | PostgREST error rate                              |

The settlement objective is the one worth naming: the baseline before
2026-09-03 was 99.8–100%, and on the day a no-op trigger broke seat writes it
ran at **56–75% for thirteen hours with no alert anywhere on the platform**.
This is the objective that would have caught it in ten minutes.

External reachability is still not covered and cannot be from this stack — the
engine cannot see itself from the internet. That lives in the World Hub's
`publish-watchdog.yml`, which deliberately does not share a failure domain with
the pipeline it watches. Both files now say so instead of implying coverage.

---

## 3. `infra/monitoring/engine-01/` — deleted, README kept

Six config files: a second `prometheus.yml`, `docker-compose.yml`,
`alertmanager.yml`, `Caddyfile`, `slo-rules.yml`, `slo-alerts.yml`.

**Deployed by nothing.** `deploy.sh:76-80` symlinks
`$SRC_DIR/infra/monitoring/$f` — the top level — and every engine-01-specific
change described in that README (the `host.docker.internal` retargeting, the
route prefixes) was folded into the parent long ago and _is_ the live stack.

Meanwhile it had drifted: four rule files behind the parent, missing all 10
supervisor, 6 tournament and 10 spin rules, and missing the `turn_relay` scrape
job. `check-monitoring-drift.mjs` only ever read the top-level pair, so none of
that was checked.

An unreferenced second copy of a config, sitting where an agent will find it,
is the documented §10.7 failure mode — the next reader believes it is live and
"fixes" the real one to match. That is the hamburger revert war exactly.

Configs deleted; the README kept and headed as superseded, because its account
of _why_ the stack was co-located on engine-01 is genuinely useful history.

**And the drift check now fails if a second one appears.** It detects by
**content**, not filename — the first version flagged
`grafana-provisioning/datasources/prometheus.yml`, which is a legitimate
Grafana datasource that `deploy.sh` does deploy. Only a file that actually
declares `scrape_configs:`, `rule_files:`, an Alertmanager route, or a compose
service counts. Proven both directions.

---

## 4. THE 17:46 pg_cron FAILURES — diagnosed, not fixed

`job startup timeout`, twelve jobs at once. Not a one-off: it was **chronic**
between 2026-08-28 and 08-31 — 97 failures in a single hour on 08-30, 71, 68,
65 across many hours — and has since settled to occasional bursts.

**Ten jobs share the schedule `* * * * *`.** They all fire on the same second,
and pg_cron must launch a background worker for each within its startup
timeout. When the pool is contended, the ones that lose the race record exactly
this error. The 08-28→08-31 window is when the fleet grew to its current 125
jobs.

I have not changed it, because the two available fixes are both someone else's
call: you cannot stagger a job that must run every minute, so it is either
raising `cron.max_running_jobs` / `max_worker_processes` (a Postgres setting
that needs a restart and Supabase-side change) or reducing how many jobs need
per-minute cadence (a design decision about ten separate money and seat
sweeps). `PgCronFailuresElevated` now fires above 10 failures an hour, so the
next occurrence is visible rather than archaeological.

**Also found and not fixed:** three money reconcilers failing on statement
timeout — `rake-law-adherence-hourly`, `reconcile-ledger-integrity-6h`,
`bomb-multi-winner-repair-hourly`. And a job erroring 63 times an hour on
2026-08-29/31 with `relation "public.user_presence" does not exist` — a
reference to a dropped table.

---

## VERIFICATION

```
alert groups:   16 groups, 78 rules, 62 metrics referenced, 0 UNREACHABLE
                (every sp:* recording rule resolves; every poker_* exists)
drift check:    OK - 7 rule files loaded, mounted, non-empty; no stray config tree
staleness:      /cron/player-stats-refresh gone; 3 genuinely stale still reporting
server:         tsc clean, 103 files / 1,419 tests
```

Both new guards were proven to fail against the broken state before being
trusted: an inserted empty group fails by name, and a planted second
`prometheus.yml` fails by path while the Grafana datasource does not.

---

## WHAT REMAINS, HONESTLY

Three items, all needing a hand I do not have from here:

1. **Run `bash scripts/deploy-openclaw.sh`** and watch one fire cycle. That is
   what restores `/cron/video-library-scraper` and `/cron/video-library-reels`
   — the scripts need to land beside the dispatcher on Hetzner, or
   `SP_SCRAPER_DIR` needs setting.
2. **`/cron/venue-tournaments` has no handler.** Decide whether it should exist
   on the workers host or be retired into `ca_retired_cron_jobs` with a reason.
3. **pg_cron worker starvation** — raise the worker pool or reduce the ten
   per-minute jobs.

The alarms for all three are live. That is the difference from this morning:
none of them can go quiet for eighteen days again without somebody being told.
