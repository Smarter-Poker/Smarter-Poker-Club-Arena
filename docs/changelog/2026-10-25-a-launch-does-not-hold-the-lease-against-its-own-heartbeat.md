# A launch does not hold the lease against its own heartbeat

**Date:** 2026-10-25
**Owner page:** "Engine Restart Storm - 41 engine kills in 15min on 41 tables, most at tournament_lease_lost - tables are being destroyed and rebuilt in a loop" (13:27 UTC / 08:27 Chicago)
**Migration:** `20261025200555_a_launch_does_not_hold_the_lease_against_its_own_heartbeat.sql`
**Law:** `tests/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.db.law.test.ts`
**Native proof:** `scripts/ci/test-launch-lease-key-share-postgres.py`

## What the owner saw

Three pages today. This document is about the first and the mechanism behind
the second; the third is covered at the end.

1. **Engine Restart Storm**, 13:27 UTC. 41 tables destroyed and rebuilt.
2. **Tables Have Stopped Dealing**, 19:46 UTC - "1 MTT(s) past their start
   time and never started".
3. Payout Accepted - a normal notification, not a fault.

## What actually happened, read from rows

`engine_recovery_events`, 13:27:10.749 to 13:27:10.887 UTC: 41 rows,
`watchdog_kill_rebuild`, detail `tournament_lease_lost`, one per table, every
table belonging to **Morning Free Buy (NLH)** (`56b17547`, 369 entrants,
scheduled 13:30). Not a loop: one burst, 140 ms wide, then nothing. The
tournament's launch receipt was claimed at 13:24:14 and **completed at
13:26:55**, fifteen seconds before the kill.

Prometheus on engine-01 (`poker_lease_heartbeat_outcomes_total{scope="tournament"}`):
`busy` +6 in the 30 s window ending 13:27:15. Every other manager on the fleet
renewed normally in that window.

The same shape twice more the same day, both on a tournament that had just
launched, both the only manager to lose its lease at that moment:

| time (UTC) | tournament           | launch receipt                                                                                                                                        | heartbeat           | engine log                                                                                        |
| ---------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| 18:25:35   | `7d1abc56` (1 table) | 18:25:08 -> 18:25:24                                                                                                                                  | busy +6 at 18:25:45 | `RUNNING - 1 tables` at :32.99, `lease_proof_expired ... expired before it was renewed` at :35.96 |
| 19:27:30   | `1cea37b0` (1 table) | claimed 19:27:06; the launch queued behind an ExclusiveLock waiter on advisory lock 530090 (the cutover of the owner-ordered Lightning reset release) | busy +2, +4         | `Starting...` at :06, `Created for table` at :12, expired at :30                                  |

Each time GameServer's verdict was **unproven** - "could not prove its lease
generation inside its window: no answer arrived, and the database did not say
it moved". The `engine_tournament_leases` row still named this instance and
this generation throughout. Nothing took the lease. The manager simply could
not get a `kept` for twenty seconds.

## The cause

`fn_begin_tournament_launch_atomic` and `fn_complete_tournament_launch_atomic`
(three overloads each) open with:

```sql
SELECT ... FROM public.engine_tournament_leases l
 WHERE l.tournament_id = p_tournament_id
 FOR UPDATE;
```

and hold that row lock until the launch transaction commits - 30 s statement
budget, and a 41-table launch on a slow afternoon uses most of it.

`heartbeat_tournament_leases_v4` renews a lease by locking its row
`FOR NO KEY UPDATE ... SKIP LOCKED` and answers **`busy`** for a row it cannot
lock. `FOR UPDATE` conflicts with `FOR NO KEY UPDATE`. So for as long as the
launch runs, every heartbeat for that one tournament - the ordinary pass every
5 s and the hedge - comes back `busy`, and `busy` extends nothing by design
(it is the correct answer for a row another transaction is settling). The
manager's 20 s proof window ends, `TournamentManagerBase.expireTournamentLeaseAuthority`
fires, `fenceForTournamentLeaseLoss` fences **every table the manager owns**
with `tournament_lease_lost`, and GameServer rebuilds them all. One launch,
41 kills.

This is the exact defect that was fixed on the hand-commit path on 2026-09-10
(`20260910064701_a_hand_commit_does_not_hold_the_lease_against_its_own_heartb`):
"FOR KEY SHARE excludes a takeover (FOR UPDATE) and nothing else, so the
heartbeat can still renew this row." The launch functions were written with
the stronger lock and never given the same correction. They were the last
protocol-2 hot path still taking `FOR UPDATE` on a lease row for the life of a
long transaction (`fn_spin_draw_and_settle_atomic` and the F06 recovery
functions also take it, but on a settlement that ends the manager anyway).

Why it shows up as "the newest tournament dies while the fleet is fine": only
the launching event's row is locked. Why it clusters on slow afternoons: the
launch has to run past ~15 s (20 s window minus the last `kept`) before the
proof lapses, which a 41-table pre-seat or a launch queued behind the
maintenance advisory lock does, and a 2-table launch on a quiet database does
not.

## The fix

All six launch overloads now take **`FOR KEY SHARE`** on the lease row. What a
launch needs from that lock is that the generation it verified is not taken
over while it runs: a takeover is `claim_tournament_lease_v2`'s `FOR UPDATE`,
a release is a `DELETE`, and `FOR KEY SHARE` blocks both exactly as before.
The heartbeat's `FOR NO KEY UPDATE` is not blocked, so the launching manager
keeps renewing through its own launch. Two launches of the same event are
still serialized where they always were - `tournament_launch_receipts FOR
UPDATE` and `tournaments FOR UPDATE` inside
`fn_*_tournament_launch_before_lease_generation`. Nothing else in any overload
changes: same rows read, same generation and 30 s staleness checks, same
receipt adoption, same answers.

The migration edits each live definition by one exact anchor (one hit per
overload, measured against production at 20:05 UTC), refuses a definition
whose anchor count is not exactly one, is a no-op once applied, and asserts
afterwards that no launch overload takes `FOR UPDATE` on
`engine_tournament_leases`, that all six take `FOR KEY SHARE`, that the
takeover still locks `FOR UPDATE` (or `KEY SHARE` would fence nothing), and
that the heartbeat still uses `FOR NO KEY UPDATE ... SKIP LOCKED`.

### Proven, not reasoned about

`scripts/ci/test-launch-lease-key-share-postgres.py` (native PostgreSQL, two
sessions, in its own workflow
`.github/workflows/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.yml`
like the other native proofs, because ci.yml's bytes are pinned by the
financial source bindings) loads the six
overloads exactly as installed before the migration
(`scripts/qualification/fixtures/launch-lease-key-share/preimage.sql`), the
production heartbeat body and a takeover shaped like the real one, parks a
launch inside its body with the lease-row lock taken, and asks the heartbeat:

```
PASS: before the migration, a launch in flight answers its own heartbeat with busy (FOR UPDATE)
PASS: before the migration, a completion in flight answers busy too
PASS: migration rewrote all six launch overloads to FOR KEY SHARE and re-applies as a no-op
PASS: after the migration, a launch in flight answers its own heartbeat with kept and moves heartbeat_at
PASS: after the migration, a completion in flight is renewed too
PASS: after the migration, a takeover (FOR UPDATE) still waits behind a launch in flight
PASS: the fixed launch still verifies the generation and still launches
```

## Damage

None to settle. Every table was rebuilt by its manager within the same second
and Morning Free Buy started on time at 13:30 and completed at 16:20 with its
field intact; the two single-table events were rebuilt the same way. No hand
was mid-commit (all 41 kills carried `handCount: 0`), no chips moved, no
player was mis-seated.

## The second page: "1 MTT past its start time and never started"

Read from rows: the one overdue MTT was **Daily 25 Chip Freezeout**
(`501008e1`, club `e14bc9f7`, scheduled 19:00, **zero entrants, zero
registrations**). It was never going to deal: nothing was owed to anyone. The
engine's empty-past-start rule (`server/src/tournament/emptyPastStartEvent.ts`,
2026-10-15) cancels such an event 30 minutes after its start once a top-up
has come back empty, and `fn_tournament_metrics` deliberately counts an empty
event as overdue only from 40 minutes so the cancel normally lands first. It
was cancelled by the engine at 19:52:12 - 22 minutes late - because the
engine was replaced at 19:29 (the owner-ordered Lightning reset release,
`c3ed8648`, sealed 19:31) and a fresh engine spends its first minutes
re-adopting ~300 running tournaments before it walks the registering ones;
the empty-top-up counter it needs is in memory and starts again at zero.
No code change here: the cancel is the correct outcome and it happened; the
delay was the restart, which was the owner's call that afternoon. The lease
fix above removes the two single-table kills that the same restart's cutover
lock caused.

## Pins

- `tests/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.db.law.test.ts`
  - the migration carries the anchor, the KEY SHARE clause and all four
    post-conditions, in one transaction;
  - no migration after `20261025200555` may re-define a launch overload with
    `FOR UPDATE` on the lease row;
  - the heartbeat's latest definition still says `FOR NO KEY UPDATE OF l SKIP LOCKED`;
  - the native proof stays in CI (its dedicated pull_request workflow).
- `docs/laws.d/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.md`
