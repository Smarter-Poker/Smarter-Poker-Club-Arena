# The headings that alerted on nothing

2026-09-04 · branch `docs/sentry-realtime-programme`

`alert-rules.yml` had three groups — `cron-health`, `postgres-health`,
`vercel-health` — with no rules in any of them. Three headings that read as
coverage and alerted on nothing.

That was the visible instance. This is the audit of everything with the same
shape, and what came back is worse than the three groups: **while `cron-health`
sat empty, four Open Claw jobs were stale and the worst had been silent for
18.3 days.**

## THE AUDIT

Four questions, asked mechanically rather than by eye.

**1. Does any alert rule reference a metric the engine never emits?**
No. 52 rules, 37 distinct `poker_*` metrics referenced, 92 emitted in
`server/src`, **0 unreachable**. Every `job="..."` selector resolves to a real
scrape job. That was the failure I most expected and it is not there.

**2. Is anything loaded but empty?**
Yes, and more than the three groups. `slo-rules.yml` and `slo-alerts.yml` are
**85 and 310 bytes containing `groups: []`** — declared in `prometheus.yml`
`rule_files`, mounted in `docker-compose.yml`, symlinked onto the host by
`deploy.sh`, and containing nothing. They pass CI legitimately: the drift check
has a documented opt-out for a file whose header says `DISABLED`. That opt-out
has no expiry, and it has been open since 2026-08-28.

**3. Do the two monitoring config trees agree?**
No. `infra/monitoring/engine-01/prometheus.yml` loads four rule files where the
top-level loads seven — it is missing `supervisor-rules.yml`,
`tournament-rules.yml` and `spin-rules.yml`, i.e. all 10 supervisor rules, all 6
tournament rules and all 10 spin rules — and drops the `turn_relay` scrape job.
`check-monitoring-drift.mjs` only reads the top-level pair, so the divergence is
unchecked.

**It does not currently matter, and that is worth writing down precisely.**
`deploy.sh:76-80` symlinks from `$SRC_DIR/infra/monitoring/$f` — the top-level
directory. The `engine-01/` copy is deployed by nothing. It is a documented
alternate-path variant from Phase 5.1.3a that was never wired in, and its
`README.md` is genuinely useful history. But an unreferenced second copy of the
monitoring config, drifting quietly, is exactly the shape that ran the hamburger
revert war for two days: the next agent reads it, believes it is live, and
"fixes" the real one to match.

**4. What is scheduled but not running?**
This is where the audit stopped being tidy.

## WHAT WAS ACTUALLY BROKEN

**Four Open Claw jobs stale, worst silence 18.3 days:**

```
/cron/player-stats-refresh
/cron/venue-tournaments
/cron/video-library-reels
/cron/video-library-scraper       worst silent_minutes: 26,418  (18.3 days)
```

**`v_openclaw_job_staleness` already existed.** It already computed
`is_stale`, already had a per-job threshold, already knew. **Nothing has ever
read it.** For the third time in one day — after the settlement outage and the
`financial_alerts` backlog — the database knew and had no way to say it out
loud.

**Twelve pg_cron jobs failed simultaneously at 17:46**, all `job startup
timeout`, including `sp_prune_hand_state_snapshots_2m`,
`daily-missions-outbox-minute`, `ca-auto-reconcile-tick` and
`credit-stalled-seat-first-stacks`. 13 failures in the hour, against 856 runs.
Nothing watched that either.

## WHAT SHIPPED

**`fn_cron_fleet_health()` + `CronFleetMetrics` + five `cron-health` rules**
(`20260904183931`). pg_cron job counts, runs and failures over an hour; Open
Claw job count, stale count and worst silence.

The alerting is built on **silence**, not failure rate, because that is what
this platform's own history says is observable. The World Hub `CLAUDE.md`
records the `CRON_SECRET` rotation where all 85 Open Claw jobs returned 401 and
nothing noticed — a 401 is refused before `withCronHealth` records anything, so
_"the log does not fill with errors, it STOPS."_ A failure-rate gauge is
structurally blind to that. `OpenClawFleetLongSilence` fires at 24 hours; the
case it was written from had run 18 days.

**What it deliberately does not measure: "jobs that have never run."** That was
the first thing I reached for, and it cannot be done honestly — `cron.job`
records no creation time, so a `NULL` last_run is indistinguishable between a
dead job and one not yet due. Seven jobs read `NULL` right now and five are
simply younger than their first window. A gauge that pages every time somebody
schedules something is how a table ends up with 1,345 unread alerts, which is
where `financial_alerts` was found this morning.

That ambiguity is itself the finding, and it is why `fn_uncollected_entry_check`
could sit in `financial_alerts` saying, of itself, _"has never run. It is
expected every 60 minutes, and until it does its silence means nothing."_
Nobody could tell. That one still needs a human to decide whether it should
exist.

**Three `postgres-health` rules.** The engine-01 stack drops the `supabase_pg`
scrape job because no `postgres_exporter` is deployed — so rather than wait for
one, these are written against gauges the engine emits from `SECURITY DEFINER`
functions. It is the Postgres exporter now, for the things that matter.

- `ReplicationSlotPinningWal` watches **`restart_lag`**, not flush lag. That is
  the horizon Postgres cannot recycle WAL past — it is the number that actually
  fills the volume, and this morning it sat at **703 MB while flush lag read
  305 MB**. The `replication` group only watched the smaller one.
- `EngineDatabaseClockSkew` — `poker_db_clock_skew_ms` was emitted and unwatched.
  Every turn timer, maintenance window and retention cutoff is computed against
  one clock or the other.
- `DatabaseRpcErrorsElevated` — the engine reaches Postgres only through
  PostgREST; a sustained error rate there is seats and settlements failing to
  write.

**`vercel-health` is deleted, not filled.** Every rule it would want reads
`probe_success{job="vercel_health"}` from a blackbox-exporter this stack does
not deploy, and the engine cannot substitute — it cannot see whether
smarter.poker is reachable from outside. That coverage is not missing, it lives
in the World Hub's `publish-watchdog.yml`, which runs every 15 minutes and
deliberately does not share a failure domain with the pipeline it watches. The
heading is gone and a comment records what it would take to bring it back
properly, because an empty group is worse than no group.

**And the systemic fix: the drift check now catches an empty GROUP.**
Check 4 validated whole _files_. `alert-rules.yml` passed it for months because
the file as a whole had plenty of rules — three of its eight groups were empty
and nothing looked inside. New check 4b walks every group in every loaded file.
Proven both directions: inserting an empty `proof-of-emptiness` group fails the
check with a named error, and removing it passes.

## VERIFICATION

```
alert groups:   engine-health 3, cron-health 5, postgres-health 3,
                host-health 3, replication 5, settlement 5, money-health 4
                (no empty groups; vercel-health removed)
drift check:    OK: 7 rule file(s) loaded, mounted at matching paths, non-empty
live gauge:     125 pg_cron jobs (124 active), 858 runs / 13 failures in 60m
                69 Open Claw jobs, 4 stale, worst silence 26,422 min
server:         tsc clean, 94 files / 1,069 tests
```

The collector's own tests caught a real flaw before it shipped: the first
version published `poker_cron_pg_jobs 0` and `poker_cron_pg_failures 0` before
it had ever read anything, which reads as "125 jobs became 0, and 13 failures
became none". It now publishes nothing but its staleness until it has actually
looked. That is the same rule as an absent lag series, and the test that failed
was the one asserting it.

## STILL OPEN

- **The four stale Open Claw jobs are still stale.** This shipped the alarm,
  not the repair. `/cron/player-stats-refresh`, `/cron/venue-tournaments`,
  `/cron/video-library-reels`, `/cron/video-library-scraper` need someone to
  find out why they stopped — the dispatcher registration, the secret, or the
  handler. They will now page.
- **`slo-rules.yml` and `slo-alerts.yml` are still empty**, legitimately marked
  `DISABLED`. Re-enabling them means deploying blackbox-exporter into
  `infra/monitoring/docker-compose.yml` and adding the `vercel_health` job —
  the same prerequisite `vercel-health` had. The `DISABLED` opt-out in the drift
  check has no expiry and nothing owns re-enabling it.
- **`infra/monitoring/engine-01/` is deployed by nothing and checked by
  nothing.** Either fold it into the drift check or delete it and keep the
  README as history. Leaving a divergent copy where an agent will find it is the
  documented failure mode from §10.7.
- **12 pg_cron jobs failed together at 17:46** with `job startup timeout`. One
  event, now alertable, but nobody has explained it.
