# An abandoned first hand of an event that never dealt is a misdeal (2026-10-03)

## What happened

Heads-up SNG **NLH Heads-Up 2** (`b290375a-5c44-4593-a6a7-09dc844090f3`), two
real players (SLCProf, fox_86), 1000 chips each, $1.90 + $0.10, went RUNNING at
22:26:57 UTC on 2026-10-02 and dealt **no hand** for six and a half hours.

Its lease generation `5d91c9f5` reserved the event's first hand `20715764`
(permit `762e02bc`) on table `4f6b8c6f`, wrote both hole cards at 22:27:35 and
died before the hand's snapshot. Nothing else of the hand exists: no snapshot,
commit, history, private state, dispatch, submission, discard or F06 operation.
Both chairs hold 1000, equal to their registrations and the event's starting
chips.

Every adopting generation asked `fn_f06_abort_abandoned_generation`. Its misdeal
clause (2026-09-26) voids a dealt hand that never reached a commit only when it
can prove that no chip left a chair. It proved that ONLY by comparing each chair
with the table's **last committed hand**, and a first hand has none
(`v_last.id IS NULL`). So the door refused `F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT`
at every ask (every 10 minutes and at every hourly adoption, 24+ times). The
table admission failed `f06_engine_admission_unproven` every 15 s, the blind
clock held at level 0, and `atomic_cancel_tournament` refuses a started event,
so the event could neither deal nor be cancelled. Engine release `df939490`
(#5913, unplaceable-park withdrawal) does not touch this clause.

## The fix (root)

`20261003051223_an_abandoned_first_hand_of_an_event_that_never_dealt_is_a_mi.sql`:
when the void hand is the event's first hand (no `hand_history` for the event,
no `hand_history` and no `hand_atomic_commits` at any of its tables), the stack
every chair must hold is the event's `starting_chips`. The roster check already
requires chair stack = registration chips. Every table with a committed hand is
still proved against it, and every other refusal is unchanged. The door still
credits 0 and writes no chair or registration. The receipt records
`first_hand_of_event` and `starting_chips`.

Proved on production first in a self-aborting `DO` block, using this exact body
as a `pg_temp` function: `ok`, `misdeals_voided 1`, `credit 0`, permit
`aborted_unsettled`, both chairs and registrations 1000 / playing, level 0
unchanged. The transaction was rolled back.

The engine already asks the door again for a refused generation every
`ABANDONED_GENERATION_REFUSED_COOLDOWN_MS` (10 minutes) from the table admission,
so once the migration is installed the event deals within 10 minutes. No restart
and no repair job are needed.

Law: `tests/an-abandoned-first-hand-of-an-event-that-never-dealt-is-a-misdeal.law.test.ts`.
