# Post-Deploy E2E: the client half is green, the live-table half is red because the engine has not restarted in four days

2026-09-23. `Post-Deploy E2E (production)` was still failing on
`4a178da2f3f5d97d2a668456286ebaa01d734e2c`, the revision serving production at
both `https://ca-static.smarter.poker/build-info.json` and
`https://smarter.poker/hub/club-arena/build-info.json` (both read
`ca_sha 4a178da2f3...`, `built_at 2026-09-23T05:18:42Z`, run `35821708947`).

Yesterday's pass
(`2026-09-22-post-deploy-e2e-two-client-defects-and-a-frozen-tournament-fleet.md`)
merged as squash `4a178da2f3` and was cut off before it could verify. This
records what that verification found: one of its two jobs is now green, the
other is not, and the reason the other one is red is not what that changelog
said it was.

Every number below is read from `/health`, from rows, or from a run log. None
is inferred.

## Job 1, `Client browser verification`: green

Verified, not assumed. Run `35822185470` was re-run on the same live SHA at
2026-09-23T12:44Z and `Client browser verification` completed `success`, as it
had on the original 05:23Z run. The club-data touch floor and the tournament
lobby rebinding both hold against the live bundle. Nothing was changed here.

## Job 2, `Live-table and engine verification`: (a) production is broken

One assertion fails, and it is the first thing the job reads, so nothing
downstream of it has ever executed on this SHA:

    tests/e2e/production-live-table-realtime.spec.ts:129
    expect(health.stalledTableCount, 'production had stalled tables before observation').toBe(0)
    Expected: 0
    Received: 65

All four tests fail on that same line inside `readEngineHealth`, before the
spec opens a page. Read live at 2026-09-23T12:42Z, `/health` agreed exactly:
`stalledTableCount 65`, `deadStalledCount 65`, `dealableTableCount 103`,
`wholeFleetStalled false`, `liveness ok`. Sixty-three per cent of the dealable
fleet is past `TABLE_DEAD_STALL_MS`.

The assertion is correct and was not touched. It is the only reader in the
estate that refuses to certify a publish against a fleet that is not dealing.

### Who is affected, from rows

The twenty stalled tables `/health` publishes belong to six RUNNING
tournaments. `hand_history` is the witness that was there, and it says these
tables have dealt nothing for one to five days:

| tournament                            | tables here | last hand on them         | lease row |
| ------------------------------------- | ----------- | ------------------------- | --------- |
| `$100 Freeroll - 12:00 PM`            | 3           | 2026-09-18 22:07 to 22:10 | none      |
| `Afternoon Free Buy (NLH)` `615783bf` | 1           | 2026-09-18 22:12          | none      |
| `Morning Free Buy (NLH)`              | 3           | 2026-09-19 14:04 to 14:29 | none      |
| `Monday Rebuy Rush`                   | 6           | 2026-09-21 20:09 to 21:19 | present   |
| `Afternoon Free Buy (NLH)` `6c12bfb7` | 4           | 2026-09-22 13:06 to 13:30 | present   |
| `Friday Five-Card Bounty`             | 3           | 2026-09-22 13:24 to 13:52 | present   |

Those twenty tables hold 2 to 8 open seats each (`table_seats.left_at IS
NULL`), 97 in total. They are horses, and under section 10.5 that makes them
players sitting in a frozen event with chips on the felt. `$100 Freeroll` has
reached blind level 162 and `Afternoon Free Buy` `615783bf` level 126 while
their tables dealt nothing, so the clock kept running on stacks that could not
act.

### What yesterday's changelog got wrong

It named the cause as six tournaments that hold no row in
`engine_tournament_leases`, and concluded that `tournamentManagerQuarantine`,
already on `main` since 2026-09-21, reaches them.

Three of the six do hold a lease row, and their heartbeats stop at the exact
second their tables stop dealing:

- `Monday Rebuy Rush`, lease acquired 2026-09-21T20:02:02Z, last
  `heartbeat_at` 2026-09-21T21:19:22Z; its six tables' last hands are
  21:18:38 to 21:19:03 the same evening.
- `Afternoon Free Buy` `6c12bfb7`, acquired 2026-09-22T13:02:25Z, last
  heartbeat 13:30:41Z; last hands 13:06 to 13:30.
- `Friday Five-Card Bounty`, acquired 2026-09-22T13:02:25Z, last heartbeat
  13:53:15Z; last hands 13:24 to 13:52.

All three carry `engine_version 8825af51` and `instance_id 1-3846b8bb`, the
process still serving. A manager that stops heartbeating while still owning a
live lease is not the shape the quarantine names, which is a manager that
could not be STOPPED and still holds its slot. Two of these three froze after
that quarantine was written. So "already fixed on `main`" is not established
for the newer population, and nobody should treat it as settled until the
engine runs `main` and the count is read again.

### Why `secsIdle` says forty minutes when the truth is days

Yesterday's note said `/health.stalledTables[].secsIdle` is restamped at each
hourly restart and thaw. That is right, and it is worth recording why, because
the fix for it is already written and a future agent must not write it twice.

`releasePauseGate()` in `server/src/engine/ServerTableEngineBase.ts` credits
`markProgress()` on resume. On 2026-09-18 that credit was made conditional,
`if (this.handForHandResolve !== null)`, so that only a table whose loop
actually reached the pause gate is vouched for: "once an hour, every hour, a
frozen table was vouched for by a break it had never joined."

That guard is on `main` and is **not** in the build serving production.
`git show 8825af51...:server/src/engine/ServerTableEngineBase.ts` contains zero
occurrences of it. So production still hands every frozen table a fresh clock
at every thaw, and the numbers behave exactly as that predicts: read at
12:42:19Z, all 65 reported `secsIdle` 2429 to 2436, i.e. 12:01:47Z, and
`/health.maintenance.resumeWaves` records the thaw running 12:01:39Z to
12:01:50Z across 455 tables. The stall clock in production cannot report more
than one hour no matter how long a table has really been dead, and for the
five minutes after each thaw `deadStalledCount` reads low or zero.

Do not "fix" this again. It is fixed; it is waiting behind the same door as
everything else below.

## The door, and why this task did not open it

The engine serving production is `8825af51817f379c4261658ca29ecc9d8d81932d`,
committed 2026-09-18 16:16 CDT, **188 commits behind `origin/main`**. Its
process uptime read 398,787 s (4.6 days) at 12:42Z, so it has not restarted
once, and an engine restart is the only thing that clears a dead tournament
manager out of memory. The hourly break restarts nothing by itself: the
cutover is performed by `auto-deploy-hetzner.yml`, and that workflow has not
produced a success since before 2026-09-21.

Its last run, `35752228277` (2026-09-22T16:09Z), failed at the step
`Every database function this build calls exists in production`:

    fn_ca_commerce_claim_due_renewals() is called by
    server/src/services/CommerceRenewalConsumer.ts and does not exist in
    production. Apply its migration before this build ships.

plus `fn_ca_commerce_deliver_due_notices` and
`fn_ca_commerce_execute_renewal`. Confirmed directly: `pg_proc` in production
returns zero rows for all three, and `supabase_migrations.schema_migrations`
holds `20260922141732`, `20260922142828`, `20260922150506` and onwards but
**not** `20260922143541_club_and_union_diamond_commerce`, which is merged on
`main` as a 126 KB file. The door check is behaving correctly. One task's code
landed ahead of its schema and the whole engine release train has been parked
behind it ever since, which is why the tournament-manager work, the
park-credit guard above and 185 other commits cannot reach the fleet.

The estate is already shouting about this, so no detector was added.
`production-integrity-audit.yml` run `35856014070` (2026-09-23T11:41Z) fails
three jobs by name: `Every merged migration is live` (listing the missing
`ca_commerce_*` tables, indexes and triggers), `The engine is running main`
("Hetzner serves 8825af51... but protected main requires 0662cc2a"), and
`The engine pipeline is not starving`. Issue #4076 is open and names the
stalled tables.

**Applying that migration was considered and deliberately refused.** Its third
executable statement is

    DELETE FROM public.feature_pricing WHERE feature = 'club_creation';

and the rest installs a diamond commerce catalog, published price versions,
purchase, refund and renewal paths that debit through `deduct_diamonds` and
credit through `add_diamonds_to_balance`. That is a price and payment change
belonging to assignment CA-DIAMOND-COMMERCE-2026-09-22. Section 10.9 says an
unrelated price or payment structure is not added to the assignment by a
repair, and its fifth condition is that the agent can write the paragraph
explaining every affected party. I cannot write that paragraph for another
task's pricing cutover, so I did not run it. Reverting
`CommerceRenewalConsumer.ts` was refused for the same reason in the other
direction: it would delete a working task's delivery to unblock mine.

## What this task changed

Nothing in the live-table path, on purpose. The failing assertion is correct,
the cause is named, its fix is already on `main`, and the thing standing
between that fix and production is a schema apply that belongs to another
assignment and is already reported by three named audit jobs and an open
issue. Section 10.11 is explicit about the alternative: if you cannot reach
the cause in the time you have, say so plainly and say what you know, and do
not ship a detector and describe it as handled. No sweep, back-pay, redrive,
retry or watcher was written, and the spec's fleet gate was not weakened,
scoped or moved. Weakening it would have turned the only reader that sees 65
frozen tables into a green tick.

## The verdict, per job, in the words section 10.86 asks for

- `Client browser verification`: **green**, verified on the live SHA by re-run
  `35822185470`.
- `Live-table and engine verification`: **(a) production is broken.** 65 of
  103 dealable tables have not dealt for one to five days. It will stay red
  until `auto-deploy-hetzner` ships an engine, and that needs
  `20260922143541_club_and_union_diamond_commerce` applied by the assignment
  that wrote it.
- Everything the live-table spec asserts after line 129: **(c) I could not
  tell.** The precondition fails first, so those assertions have never run on
  this revision, and no claim is made about them here.

## Verified

`npx tsc --noEmit` clean. All eight gate scripts print ok
(`check-css-modules`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `check-ui-text`, `check-no-emoji`,
`check-horses-are-players`, `check-discarded-read-then-write`).
`python3 scripts/ci/verify-source-bindings.py` intact; no pinned file changed,
so no restamp was required. No source file was modified, so no spec needed
moving and no law changed.
