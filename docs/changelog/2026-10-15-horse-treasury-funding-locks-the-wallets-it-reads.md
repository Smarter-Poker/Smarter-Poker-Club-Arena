# Horse Treasury Funding Locks The Wallets It Reads

## What Broke

Applying `20261015053941` (top the 72 Lightning pilot horses up to 200 chips) at
09:31 UTC was refused whole by `fn_ca_balance_has_its_ledger_row`: treasury delta
-11716.40, ledger net -11717.40. No chips moved.

## Cause

`fn_seed_horses_to_floor` summed the shortfall to debit from the treasury in one
statement and wrote each horse's declared leg from later statements, with no
lock between them. The pilot horses were playing the club's 1-chip Spins (about
400 since admission, all inside the pilot club), so a wallet moved between the
reads and the debit and the legs disagreed by 1.00.

## Fix

`20261015093554` locks the club row and every horse wallet the function reads,
in user order, before its first read. Nothing else in the body changes. The
same transaction then runs the approved top-up (Dan: "top up the 72 pilot horses
to 200 chips each from the pilot treasury, about 11,534 chips") and asserts
conservation, every horse at or above 200, exactly 72 horses, no other human, a
bound on the amount, and no Lightning state change. `20261015053941` is marked
`SUPERSEDED BY 20261015093554`.

## Proof

Rolled-back probe at 09:36 UTC holding the same locks, with deferred guards
forced (`SET CONSTRAINTS ALL IMMEDIATE`): 72 horses, 11,688.20 chips, treasury
96,820.00 to 85,131.80, every guard passed. The amount is above the approval's
"about 11,534" because Spins moved the horses' balances; it stays inside the
asserted bound of 72 x 200.
