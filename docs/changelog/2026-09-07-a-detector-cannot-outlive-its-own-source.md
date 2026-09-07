# A detector cannot outlive its own source

**2026-09-07** — branch `fix/a-detector-cannot-outlive-its-own-source`

Found in the verification pass over yesterday's work, not by anything going
wrong. `check-ddl-reload-storms.mjs` shipped with the exact defect it was
written to stop somebody else making.

## The hole

The check reads `ca_ddl_events` and reports whether any minute in the window
held 30 or more distinct reload-triggering DDL statements. It never asked
whether that table was still being written to.

`ca_ddl_events` is filled by two EVENT TRIGGERS — `ca_ddl_watchdog_log` and
`ca_ddl_watchdog_drop_log`. Event triggers on this database are created,
replaced and dropped by agents all day; **I edited both of them myself the same
afternoon I wrote the check**. Disable either one, or empty the table, and
"no storm in the window" and "nothing is recording DDL any more" become the
same observation — a permanent, confident green from the one thing whose job is
to notice.

That is CLAUDE.md 10.86 rule 1, in my own new code, one day old.

## The fix

Before it judges anything, the check now asks how old the newest
`ca_ddl_events` row is. Past the horizon, or with no rows at all, it exits **2**
— COULD NOT TELL — and prints the query that says whether the triggers are
still enabled:

```sql
select evtname, evtenabled from pg_event_trigger
 where evtname in ('ca_ddl_watchdog_log', 'ca_ddl_watchdog_drop_log');
```

An empty table is treated as unknown age, never as age zero. An unparseable
timestamp likewise. Both were the coercion worth pinning.

## The horizon, derived rather than guessed (10.84)

Gaps between consecutive `ca_ddl_events` rows, over seven days and 14,223 rows:

```
p95   5 minutes
p99   6 minutes
max   8.93 hours   <- a genuinely quiet night
```

**24 hours** — 2.7× the worst observed quiet period, so it cannot cry wolf on
one; and if nothing at all has run DDL on this database for a full day, that is
worth being told regardless of the reason.

Six new cases pin it (21 in the file now), including the one that matters: a
gap of 8.93 hours is quiet, not broken, and must not be reported as either a
storm or an outage.

## What else the verification pass checked, and found sound

Reported because "I looked" is worth as much as "I changed":

- **Full suites on current `origin/main`**: 1,110 files / 15,418 tests (root)
  and 442 files / 6,346 tests (server). All green.
- **Both new gates executing in CI on PR #3377**:
  `Supabase Invariants — No Unqualified Writes` and
  `Supabase Invariants — Definer Authorization`, both success, both inside
  `TypeScript Check` — one of the six REQUIRED checks in the `main protection`
  ruleset, so a red gate cannot merge.
- **The watchdog job actually ran**: `No schema-reload storm is stalling the
fleet` — completed, success, on a real scheduled run.
- **The live engine build carries the channel fixes**: `a4d1c527` holds
  `removeChannel` in `BombRequestBus` and the broadcast error-path release.
  Engine log over 60 minutes: `ChannelRateLimitReached` **0**,
  `DELETE requires a WHERE clause` **0**, `deal_step_timeout` **0**.
- **`unqualifiedWrites --all` still returns its 33 historical hits**, so the
  gate detects rather than merely runs.

## The one thing that looked like a regression and was not

Mid-audit, `current_players` disagreed with the live seat count on **130 of 531
open tables** — 25%, against the 4 measured yesterday. The conditional recount
is the highest-risk change in this whole programme, and its own test file says
so: "the dangerous direction is a filter that fails to match when a value HAS
changed."

It was 03:59 UTC — inside the `:55`–`:00` maintenance freeze. The recount runs
at the END of a hand, and during the freeze no hand ends, so seats seeded during
the break sit uncounted (125 of the 130 were UNDERSTATED, consistent with seats
arriving and no hand completing). Ninety seconds after the thaw, with 288 hands
completed:

```
mismatches  130 -> 8   (1.5% of 531 open tables)
```

The write FREQUENCY is identical to before the change — both the old
unconditional write and the new conditional one fire at the same moment, at
hand end, with the same value. Only the no-op writes were removed. Verified,
not reasoned.

## And the other one

The Realtime slot climbed to **241 MB** two minutes after the same thaw, which
is the exact signature the whole programme was about. It was the thaw: 531
tables resuming at once.

```
04:01:39   68 MB
04:02:43  150 MB
04:04:04  198 MB
04:04:56  241 MB   <- peak
04:05:41  163 MB
04:08:01  5,720 bytes
04:08:51  0 bytes
```

Drained to zero in under four minutes at 459–495 hands per minute. Yesterday's
signature was the opposite: 197 MB with no drain at all, because `apply_rls` was
costing 22.9 s of database time per 15 s of WAL and could not converge by
arithmetic. A sawtooth that returns to zero is a consumer keeping up.

## Files

- `scripts/ci/check-ddl-reload-storms.mjs` — the liveness guard
- `tests/ddl-reload-storm-detector.test.ts` — 21 cases (6 new)
