# The ledger replay knows which legs its snapshot saw (2026-10-04)

Migration `20261004135607`. Law `tests/the-ledger-replay-knows-which-legs-its-snapshot-saw.law.test.ts`.

## What happened

The 2026-10-04 06:40 replay filed, besides the unlabeled rake-treasury legs
(`20261004123650`), four small drifts against the reading of 2026-10-01 06:47:

| account | unexplained |
|---|---|
| player 70fa710b wallet (incident c8a4dcb2, critical) | +190.00 |
| Midway rake treasury (residual on 30bf6669) | +10.00 |
| jackpot pool a7a65cfc promo (f972f5db) | -6.21 |
| Deep Stack club promo (89f91485) | +6.21 |

All four are three legs written at 06:39:52-06:40:00, while that reading's
REPEATABLE READ snapshot was being taken: tournament a7f2e09c's finish wrote
its 190.00 prize (xid 750498527) and 10.00 fee (750498599) - two xids, one
transaction timestamp, i.e. subtransactions - and the promo sweep moved 6.21
(750500000). Their top-level transactions were still running (750498100,
750498145, 750499996 are in the snapshot's xip). A pg_snapshot lists only
top-level xids, so `pg_visible_in_snapshot` reported the subtransaction xids as
visible: the replay treated the legs as already counted while the balances it
had recorded did not contain them. Excluded from both windows, they read as
drift.

## Fix

`public.ca_ledger_replay_readings` holds, per reading snapshot, the ids of the
legs with xid >= the snapshot xmin that the reading could actually see (the
run is REPEATABLE READ, so a later statement of it sees exactly what the
reading saw). `fn_ca_leg_accounts_since_snapshot` and `_for` treat a leg as
already counted only if it is visible in the previous snapshot AND its xid is
below that snapshot's xmin or the previous reading recorded it. A previous
reading with no recorded row keeps the old rule, so behaviour changes from the
first reading after the migration.

Proof (rolled back, production): with a reading row built from the true
visibility, the legs the new rule counts and the old one did not are exactly
`750498527 prize_liability->player_wallet 190.00`,
`750498599 prize_liability->union_wallet 10.00` and
`750500000 bbj_pool->promo_wallet 6.21` - nothing else.

## Live

Applied to production 2026-10-04 ~14:30 UTC; all four live proofs read true and grants are unchanged. Incidents c8a4dcb2, f972f5db and 89f91485 resolved with this migration as the correction.
