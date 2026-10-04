# tests/a-snapshot-excluded-chair-without-a-card-does-not-hold-an-abandoned-hand.law.test.ts

`public.fn_f06_abort_abandoned_generation` may treat a live chair that is
absent from an incomplete preflop snapshot as outside that saved hand when
either the chair joined after the snapshot, or no durable
`table_hole_cards` row names that user for the exact table and hand.

The exception is narrow. The ordinary roster proof must still bind the live
chair to one playing registration at the exact table and seat, and the chair
stack must exactly equal the registration chips. A snapshot-excluded chair
with an exact-hand card and no late-join proof still refuses
`F06_ABORT_SAVED_STACKS_CHANGED`. Snapshot members must still conserve saved
stack plus investment, and the stage, pot, commit, history, private-state,
custody, receipt, zero-credit and service-role-only contracts are unchanged.

Regression:
`tests/a-snapshot-excluded-chair-without-a-card-does-not-hold-an-abandoned-hand.law.test.ts`.
