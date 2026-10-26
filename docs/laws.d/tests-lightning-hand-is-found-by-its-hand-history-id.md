# tests/lightning-hand-is-found-by-its-hand-history-id.law.test.ts

fn_cash_earning_club looks up lightning_hand by hand_history_id for every attributed player of every cash hand, so public.lightning_hand carries idx_lightning_hand_hand_history_id (btree on hand_history_id), built CONCURRENTLY in the admitted migration preamble because the table is written on every Lightning hand, with the migration's transaction refusing an invalid or differently shaped leftover; before it, each probe was a parallel sequential scan (55,580 buffers, 230 ms at 291,641 rows, 2026-10-25) (20261025041900).
