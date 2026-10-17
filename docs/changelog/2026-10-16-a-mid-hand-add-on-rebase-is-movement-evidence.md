# A Mid-Hand Add-On Rebase Is Movement Evidence (2026-10-16)

## What Happened

85313174 "Coffee Break Freeroll (PLO4)" (16 playing) dealt nothing on its three
live tables (0c6edb9d, cdc8cdcf, 30c09ebd) from 17:03 UTC. The watchdog killed
and rebuilt them at 17:12, and every re-admission of their parks (74fa4319,
a3d58b20, c0be0f07) logged
`f06_movement_admission_unproven [55000]: F06_MOVEMENT_STACK_RECEIPT`.

## Cause

The add-on window opened while each table's last hand was being dealt. Four
players bought the add-on mid-hand (17:02:14-17:02:50, 3,000 chips each). The
engine had read their seats before the chips arrived, so the stack settlement
rebased those seats: it wrote the engine's result plus exactly the 3,000 that
arrived, recorded one `ca_seat_stack_rebases` row each and published them in
`stack_result.rebased`. Seats and registrations hold those chips.

`smarter_private.f06_movement_prior` refused any non-empty `rebased` and
compared every written stack with the engine's request stack, so a paid add-on
that landed mid-hand froze the table for the life of the event.

Behind that, 30c09ebd held a second shape: 70a7e704 busted there in hand
36294016, rebought 5 s later and was re-seated in the same chair row while the
last hand was already being dealt. An undealt chair was admitted only by a move
or an entry/re-entry receipt recorded after the chair was taken; a rebuy is
neither and its receipt precedes the re-seat by ~40 ms, so the proof refused
`F06_MOVEMENT_WHOLE_ROSTER_REQUIRED`.

## Fix

Migration 20261016183932 changes only `f06_movement_prior`:

1. A rebased player is admitted only by its one rebase receipt (engine
   before/after = the request, seat before = engine before + rebase, written =
   request + rebase) and the add-on funding receipts walked back from the seat
   the settlement found to the stack the engine dealt: each on this table,
   after the previous hand and the chair, no later than the seal, its
   registration image the running stack, the grants summing to exactly the
   rebase. Written and `tournament_player_chips` must equal request + rebase,
   and every rebased key must be a player the hand dealt. The receipts precede
   the seal, so the purchase loop never counts them twice.
2. A chair bought back after a sealed bust and re-taken while the proven hand
   was dealt is admitted only by the player's latest entry/re-entry/rebuy
   receipt being that rebuy (between the bust and the re-seat, playing on this
   table and seat number, exactly the rebuy grant), the bust being the last
   hand here that dealt the player (this chair row, 0, written 0, the chair in
   its vacated zero-stack generations), and no move or hand since.

Every other refusal is unchanged and a proof that needs neither is
byte-identical.

## Proof

- Production, one read-only transaction ended in ROLLBACK: the installed body
  refused all three tables; the post-image admitted 0c6edb9d (roster 6),
  cdc8cdcf (roster 4) and 30c09ebd, citing the exact rebase rows and receipts.
- Native: `python3 scripts/ci/test-mid-hand-add-on.py --pg-bin <bin>` installs
  the pre-image, proves both refusals, applies the migration file verbatim,
  proves both admissions, a byte-identical ordinary proof, 29 counterfactual
  refusals and the ACL (39/39 on PostgreSQL 16).
- `tests/a-mid-hand-add-on-rebase-is-movement-evidence.law.test.ts`.
