# A retained hand is handed off wherever its table still deals (2026-09-29)

## What was happening

Fifteen minutes of engine log, 2026-09-29 02:10-02:25 UTC (engine fa480b9b):

| Error                                                                             | Count      | Table                               |
| --------------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| `retained_hand_submission_readback_failed: HAND_SUBMISSION_TABLE_NOT_ADMITTED`    | 113 starts | 499aa67a "NLH 1/2 Classic Feeder"   |
| `retained_hand_submission_readback_failed: HAND_SUBMISSION_HANDOFF_STATE_CHANGED` | 110 starts | 6c9ee4b6 "NLH 1/2 Madness Feeder"   |
| `watchdog_kill: start_failed:start_load_table`                                    | 223        | the two above                       |
| `HAND_SUBMISSION_PLATFORM_FROZEN`                                                 | 0          | (the :55 break; not in this window) |

(Each start logs twice, `failed_to_start` and `direct_table_start_failed`, so the
raw line counts are 226 and 220.) Every rebuild also wrote a recovery row and
spent one slot of the discovery start budget. The earlier 02:03-02:18 window
had 161 and 159 starts, and 136 `Tournament.table_engine_restart_failed:
f06_movement_admission_unproven [55000]: F06_MOVEMENT_ELIMINATION_UNPROVEN` on
tournament table 93e4ffb5 (Late Night Grind PLO4, event 4ea9bcc9, one player
holding all 48,000 chips, one bust of player ...0049 unrecorded); that one
stopped by itself when the source table's last chair left at 02:15:43 and is
the F06 bust-recording stream's, not this change's.

Neither cash hand is superseded - neither table committed anything after it -
and both requests still match their chairs exactly. The door refused them for
reasons that are not in the request:

1. **499aa67a, hand 16812749** (submission 8debf775; 113fc1bc +227.57,
   4c417026 -230.82, bb698b9a -1.00, rake 3.75, BBJ 0.50). The table went
   `lifecycle='breaking'` at 15:18:08. The door admitted a cash table only
   while `lifecycle='live'`, although the engine wakes every undeleted cash
   table in waiting/running and the commit door the original settles through
   reads no lifecycle. The break waited for the hand; the hand waited for
   'live'.
2. **6c9ee4b6, hand 13637742** (submission a76d9941, dealt 2026-09-22
   15:05:14; 113fc1bc +4 from 286514ac's blind and dead ante). Six days
   frozen. Two chairs sat down 18 s and 43 s before the deal and were not dealt
   in. The door refused any unnamed open chair that joined before the deal. The
   hand's own `p_hand_row.players` roster says who was dealt, and on the 400
   most recent committed hands it equals the stack rows exactly.

And in the engine, `start()` turned every one of these refusals into a watchdog
kill and a rebuild into the same answer.

## What changed

**Database, `20260929023040`** - three anchored edits to the live
`fn_ca_resume_hand_submission`, under exact pre-image (`32cfcc98...`) and
post-image (`e0046c68...`) assertions:

- _admission_: a cash table is admitted in every lifecycle but `closed`;
  tournament tables unchanged.
- _dealt_roster_: the hand's players roster must equal its stack rows; an
  unnamed chair is admitted whenever it sat down, and still refuses if its
  player is a hand player or it sits in a dealt seat.
- _disposal_: when the lowest unfinished request lies below a committed hand
  on a cash table, the door itself writes the receipted zero-credit disposal
  (new `smarter_private.hand_submission_dispose_dealt_past`, the proofs of
  `fn_ca_dispose_superseded_hand_submissions`) and reads the next request. A
  superseded request is decided in the live path, not by a later batch.

**Engine** - `resumeRetainedHandSubmission` names the refusals answered from
durable rows (`RetainedHandSubmissionRefusedError`: TABLE_NOT_ADMITTED,
HANDOFF_STATE_CHANGED, ACCEPTANCE_UNPROVEN, ORIGINAL_PERMIT_REQUIRED,
TABLE_MISSING). `start()` fences a cash generation on one without a watchdog
kill or recovery row. `GameServer` releases the exact lease, arms no retry,
reports once per new code (`GameServer.retained_hand_refusal_holds_table`),
and holds the table - no read, lease, engine, log or discovery budget - for ten
minutes before asking again. A start releases the hold. Transient refusals
(freeze, maintenance lock, lease proof, lock timeouts, a replayable
postcommit) keep the ordinary retry.

## Proof before merge

Rolled-back psql transactions on production, post-image door and helper as
`pg_temp` functions, lease row held by a probe identity:

- 6c9ee4b6: `completed=true`, `financial_handoff=true`, hand 13637742
  committed and post-committed, 220.00->224.00 and 209.13->205.13, the other
  four chairs unchanged, net 0.00.
- 499aa67a: financial commit landed (256.78->484.35, 230.82->0.00,
  197.00->196.00, net -4.25 = rake 3.75 + BBJ 0.50); postcommit returned the
  replayable `accepted_postcommit_pending` on the probe's own 3 s lock timeout.

## The existing rows

They settle through the platform's own door, the handoff, the next time the
engine starts each table after the migration is applied. Nothing here writes a
chip.

## What actually landed in the database (follow-up, 03:20 UTC)

A second session fixed the same two refusals in parallel: #5559, migration
`20260929022629_a_retained_hand_settles_past_an_undealt_chair_and_on_a_closi`,
merged just before #5561 and installed at 03:16 UTC (door prosrc
`1949cf2d`). It admits a `breaking` cash table and an undealt chair the hand
never names (plus a zero-inflow condition). On 2026-09-29 03:18:11 UTC the
successor handoff committed 6c9ee4b6's hand 13637742 through it.

That made `20260929023040` (this file's first migration, pinned to the older
`32cfcc98` body) impossible to apply, so the follow-up retires it and carries
only what `20260929022629` does not: the live-path disposal. Migration
`20260929031904_a_hand_a_cash_table_dealt_past_is_disposed_at_its_resume_doo`
applies the single `disposal` edit above to the `1949cf2d` body (post-image
`4cc9df92`) and installs the helper unchanged. The _admission_ and
_dealt_roster_ edits described above were superseded by #5559's equivalents
and never installed.

## Pins

- `tests/a-hand-a-cash-table-dealt-past-is-disposed-at-its-resume-door.law.test.ts`
- `server/src/engine/aStandingRetainedHandRefusalHoldsTheTable.law.test.ts`
