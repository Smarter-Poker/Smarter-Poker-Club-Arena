# A Rebuy Seated From Another Table Is Movement Evidence

Found while checking Classic games after the 2026-10-24 engine release: Table 13 (3e3d1587) of "Union PKO Afternoon (PLO4)" (12135e5b) had dealt nothing since 19:53:39 UTC with 5 players seated, while the event's other four tables kept dealing. The 21:00 UTC restart did not clear it. Engine `/health` listed it as stalled: `f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED`. Owner rule: tournaments must always self-heal and finish.

## Cause, read from rows

- 19:53:26 TylerRVA (fb825ba4) busted on Table 16 (da33eedb).
- 19:53:30.71 he rebought. The purchase writes its funding receipt (75852135) before it chooses a chair, so the receipt's registration image names Table 16.
- 19:53:30.74 the purchase seated him on Table 13, seat 5 (6,000 chips). Its immutable result (entry_purchase_idempotency_receipts, knockout candidate e41ad793 `rebought`) names that chair.
- Table 13's hand 46740543 was being dealt at that moment, so it sealed (19:53:40.14) without him.
- 19:53:41.56 balancing parked Table 13 (break 5135b05b).

`smarter_private.f06_movement_prior` admits an undealt chair by a move receipt, by a rebuy whose receipt and bust are both on that table, or by an entry recorded no earlier than the chair was taken. A rebuy seated from another table matched none, so every re-admission refused and the 5 players could neither play, move nor bust. The never-dealt proof (`f06_movement_never_dealt_prior`, 20261021172832) already admits this exact purchase; the dealt-table proof never got the rule.

## Fix

`20261024211825_a_rebuy_seated_from_another_table_is_movement_evidence.sql` adds one passage to the arrival loop: the never-dealt `rebuy_proven` predicate, plus what a dealt table must also show (no move since the bust, no hand on this table dealt the chair since it was taken, taken before the park). It records the chair as an entry with its `atomic_purchase`, so the purchase loop, seat, registration and roster checks apply unchanged. Removing the passage reproduces the pre-image byte for byte, and the migration asserts that.

Proved first (CLAUDE.md 11.5) in one read-only, rolled-back transaction against production: the installed proof refused Table 13; the post-image proved roster 5, eliminated 1, and admitted fb825ba4 as rebuy 75852135 for 6,000 chips, with no other purchase or arrival.

No row is written and no chip moves. Once installed, the engine's existing park re-admission takes the proof and the break proceeds through its normal move receipts. No repair job.

Pinned by `tests/a-rebuy-seated-from-another-table-is-movement-evidence.law.test.ts`; the earlier F06 laws now name this migration as their successor.
