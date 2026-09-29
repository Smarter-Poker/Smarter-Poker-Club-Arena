# A wedged table asks the door itself (2026-09-25)

## What was wrong

526 tournament tables in 388 RUNNING events could not deal, and had not been
able to deal since before the engine cutover. Each held one
`smarter_private.f06_hand_permits` row in state `reserved` whose `generation`
was no longer its event's lease holder, so `fn_f06_begin_hand` answered
`hand_permit_unresolved` for that table to every dealer any later generation
admitted, for ever.

`tournament/abandonedGenerationDoor.ts` and
`public.fn_f06_abort_abandoned_generation` are the correct disposition for
exactly that, and #5163 wired the door into the adoption on 09-24. The engine
cut over to `778075b4` at 15:29 UTC, which contains both. The wedge did not
move.

## What the rows said

Measured on production between 20:35 and 20:55 UTC on 2026-09-25, five hours
after the cutover:

|                                                             |                               |
| ----------------------------------------------------------- | ----------------------------- |
| reserved permits whose generation is not the lease holder   | 526                           |
| tables they wedge                                           | 526 of 824 running            |
| RUNNING events affected                                     | 388 of 431                    |
| seated players behind them                                  | 2,256 (2,255 horses, 1 human) |
| distinct accounts                                           | 843                           |
| chips on those felts                                        | 19,281,136                    |
| newest wedged hand (from `hand_state_snapshots.created_at`) | 13:38 UTC, before the cutover |
| wedged permits created since the cutover                    | **0**                         |
| `f06_generation_aborts` rows since the cutover              | **0** (last row 09-23 21:19)  |

So the wedge is **static**, not growing: the arrival rate since 15:29 is zero
and so is the drain rate. Every one of those permits was minted by a generation
that died before the new engine existed - most of them on 09-22, the day of the
three lease-expiring database blips the door was written for.

The door itself is not broken. Probed against production inside a transaction
that was rolled back (CLAUDE.md 11.5, one call, one `DO` block ending in
`RAISE EXCEPTION`), it decided **7 of 8** sampled dead generations cleanly,
crediting nothing; the eighth refused with a rule it named,
`F06_ABANDONED_ROSTER_CHANGED`. Of the 526 permits, 515 clear every
durable-evidence guard the door applies (no commit, no history, no dispatch, no
private state, no retained submission) and 463 clear its roster guard as well.

The door was **never asked**. Not once:

- zero `/rest/v1/rpc/fn_f06_abort_abandoned_generation` requests in the whole
  cutover hour, against 9,557 successful `fn_f06_hand_number_state` calls;
- `poker_f06_abandoned_generation_closures_total` read **0 on every one of its
  five labels** - `aborted`, `replayed`, `already_closed`, `refused`,
  `transient`.

## The cause, named

All 388 events were adopted between 15:42:08 and 15:44:33 (their
`engine_tournament_leases.acquired_at`), and that adoption did read every table:
1,411 `fn_f06_hand_number_state` calls in those three minutes, all HTTP 200.
Re-run verbatim against a wedged table today, that read returns

```
{"ok": true, "can_reserve": false, "blocked_reason": "hand_permit_unresolved",
 "unresolved_permit": {"state": "reserved", "generation": "39551f78-...", ...}}
```

which is precisely the shape `abandonedPermitGeneration` accepts, naming a
generation that is not the lease holder's. The ask therefore began, and stopped
before the RPC.

`TournamentManagerBase.decideAbandonedGeneration` has exactly one exit that
returns without ever reaching the door: the maintenance-freeze give-up. It
waited for the thaw, and on a give-up it logged a `console.warn` and returned -
**with no counter increment at all**. Every other path through
`closeAbandonedGeneration` counts. That is why the metric read zero on all five
labels, and zero on all five labels is exactly what a healthy fleet reads.
Postgres was refusing `PLATFORM_FROZEN` every minute from 15:42 to 15:47, over
the adoption window.

And the ask could not come again, because the door was wired into
`resumeLifecycle` only, and `resumeLifecycle` runs **once per manager**: a
manager on the adoption path holds its event's lease for the rest of its life
and never resumes. One ask, one chance, and nothing said it had been missed.

## The fix

**1. The refusal is met in `startManagedTableEngine`, so that is where the door
is asked.** That method reads the same state and throws
`f06_engine_admission_unproven` every ~15 s for as long as the table is wedged -
it is the live path for that table, on an event that is already blocked, at the
moment it is blocked. It now asks the door there, on an exact
`hand_permit_unresolved` answer about its own table naming a generation that is
not its own, and then **still refuses that attempt**: the next admission
re-reads what the door left and proves itself normally. Nothing deals on an
unproven projection.

This is not a sweep, a healer, a backfill, a re-drive or a cron (CLAUDE.md
10.12). It adds no schedule and no second writer. The receipt is derived from
(event, dead generation), so a second ask replays the first rather than minting
anything.

Two cooldowns keep it from becoming a retry loop. An UNDECIDED answer is not
re-asked for `ABANDONED_GENERATION_ADMISSION_COOLDOWN_MS` (60 s) - longer than
the door's own three-attempt ladder, so the admission's 15 s cadence never
becomes the door's. A rule the door NAMED waits
`ABANDONED_GENERATION_REFUSED_COOLDOWN_MS` (10 min), because asking again
cannot pass until something outside this table changes.

**A rule is not a life sentence, and the first version of this got that wrong.**
It memoised a definite refusal permanently, per manager. Two existing pins in
`AbandonedGenerationAdoption.test.ts` went red and were right to: "asks again in
a later adoption after a refusal". They are the reason this is a finite wait
instead. 44 of the 56 generations still wedged after the settlement below are
refused `F06_ABANDONED_ROSTER_CHANGED`, whose cause lives outside the table
entirely - so a manager that had written those generations off for the rest of
its life would have held their tables blocked even after the roster was
repaired. The adoption path, meanwhile, consults no cooldown and writes none: it
is the door's caller of record and asks exactly as it always has, which is what
those two pins were protecting.

**2. Every end of an ask is a number.** `decideAbandonedGeneration` now returns
`'decided' | 'refused' | 'undecided'` instead of a boolean - the third outcome
CLAUDE.md 10.86 rule 1 requires - and the counter gains two labels:

- `frozen`, counted by the maintenance-freeze give-up before it returns;
- `unreadable`, counted when a table's state could not be read. The adoption
  sweep's `if (!error) state = data` swallowed that silently, which is rule 2's
  "never coerce an unreadable answer into an empty one": an unread table was
  indistinguishable from a healthy one.

Both labels are pre-seeded, so an absent reading and a zero reading are not the
same observation.

## Pinned

`server/src/tournament/aWedgedTableAsksTheDoorItself.law.test.ts`
(`docs/laws.d/server-src-tournament-aWedgedTableAsksTheDoorItself.md`), 13
pins, one of which exists only because the permanent memo was written first: the
refused wait must be finite. Negative proof, run before this landed: removing
the admission-time ask and the freeze count turns 6 of them red; dropping
`unreadable` from this counter's own seeding turns the label pin red. That last one was found by the
negative proof itself - the pin originally searched the whole
`engineInstruments.ts`, where `poker_f06_drained_custody_outcomes_total` is
seeded with `['refused', 'unreadable', 'malformed']` two declarations above, so
it passed while the counter under test had lost the label. It is bounded to this
counter's own declaration now (`testHelpers/sourceWindow.ts`).

## What was NOT changed

`fn_f06_abort_abandoned_generation` is untouched. It refuses correctly, and
nothing here weakens a guard: not the durable-evidence checks, not the roster
check, not `F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION`, and not the rule that
a table can never re-issue a hand number it already dealt - which
`fn_f06_begin_hand` keeps refusing while any of its three witnesses (the permit,
`hand_atomic_commits`, `hand_history`) survives. No permit is deleted; the
permit ledger stays permanent (`tests/the-permit-ledger-outlives-the-hand.law.test.ts`).

## The settlement

The door is the platform's own idempotent disposition for this, it moves no
money (`credit: 0`), and 526 tables full of seated players were waiting on it.
So it was called for every wedged generation, through the exact receipt the
engine derives (`md5('f06:abandoned:successor:<event>:<generation>')`), so a
later engine ask REPLAYS this one rather than minting a second. Between 21:06
and 21:12 UTC, verified from rows afterwards:

|                                    |                 |
| ---------------------------------- | --------------- |
| receipts written                   | 306             |
| permits closed `aborted_unsettled` | 427             |
| permits closed `never_started`     | 8               |
| tables freed                       | 435             |
| events freed                       | 332             |
| wedged permits remaining           | 91 in 56 events |

CLAUDE.md 10.9's five tests, each PASS from rows:

1. **READ, not assumed** - 526 permits by `permit_id`; 2,256 seats and
   19,281,136 chips counted; the door's verdict taken from a rolled-back probe
   before anything committed.
2. **Nobody paid twice** - the door credits 0 and writes no wallet row.
   `F06_GENERATION_ALREADY_ABORTED` refuses a second receipt per generation and
   an identical receipt replays the stored outcome. Measured after: **0
   `chip_ledger` rows at any freed table** since the settlement.
3. **Nothing clawed back** - no debit anywhere. The door's own guard proves
   `table_seats.stack = snapshot stack + totalInvested`, i.e. the chair never had
   the investment deducted, so voiding the hand returns every chair to exactly
   its pre-hand stack. Verified after: all **1,846 chairs on the freed tables
   have `stack = tournament_players.chips`, 0 exceptions**, 12,794,572 chips, and
   every chair has a `playing` registration.
4. **Proved in a rolled-back transaction first** - one `execute_sql` call, one
   `DO` block ending in `RAISE EXCEPTION` (11.5 rule 1). 8 generations sampled:
   7 would succeed, 1 refused `F06_ABANDONED_ROSTER_CHANGED`.
5. **The paragraph** - 435 hands that a dead generation had reserved but never
   dealt were voided and their tables released. Nobody was paid and nobody was
   charged, because no chips had left any chair: the pre-deal investment lives in
   the snapshot, not in `table_seats.stack`, and the snapshot is the thing being
   voided. Every one of the 1,846 players still sitting at those 435 tables holds
   exactly the stack they held before the hand that never finished - 1,845 horses
   and 1 human, decided by the identical door in the identical transaction, under
   law 10.5.

## Still open, measured, and not papered over

**1. Every one of the 91 permits left is refused by a rule the door names.**
Read by probing the door for all 56 remaining generations and rolling back:

| verdict                                        | generations |
| ---------------------------------------------- | ----------- |
| `F06_ABANDONED_ROSTER_CHANGED`                 | 44          |
| `F06_ABORT_COMMITTED_OR_DISPATCHED`            | 4           |
| `F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT`         | 4           |
| `F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION` | 4           |
| would succeed                                  | **0**       |

The roster 44 are a `tournament_players` row at that table with
`status = 'playing'` and no live `table_seats` chair. That is a separate defect
in whatever released the chair without settling the registration, and the door is
right to refuse: closing a permit under a roster it cannot account for is how
chips get invented. The 4 retained submissions are decided by this change once
`resumeRetainedHandSubmission` finishes the original, which the admission path
already calls before it reads state. The 4 dispatched hands belong to the
dispatch consumer.

**2. The 435 freed tables have not resumed dealing, and the reason is no longer
the permit.** Measured 45 minutes after the settlement: every sampled freed table
answers `can_reserve: true, blocked_reason: null`; all 435 are `running` or
`waiting` with 2 or more live chairs; all 332 events hold a lease heartbeating
within 60 s and are not on break - and **not one has reserved a new hand.**
Platform-wide in that window only **9 to 11 of 434 RUNNING events dealt at all**,
and `/health` reports `tablesExpectedDealing: 124` against 824 running tournament
tables, with `tournamentManagersQuarantined: 20` and
`poker_tournaments_running_without_owner: 21`. So the fleet is not dealing for a
second, larger reason that is independent of this defect and outside this change:
closing the permits removed a real and necessary blocker, and it was not the only
one. That belongs with whoever holds the restart certificate and the quarantined
managers, and it is stated here rather than counted as a win.

**3. Draining the wedge is also the durable fix for the prune exposure.** The
16,819 `accepted` permits at the wedged tables sit on horse-only prunable hands,
and pruning a wedged table's already-dealt history makes `f06_movement_permits`
refuse that table permanently. Nothing has been destroyed yet (0 rows). Every
table freed above removes one from that exposure, which is why draining rather
than suppressing the prune is the clean path.
