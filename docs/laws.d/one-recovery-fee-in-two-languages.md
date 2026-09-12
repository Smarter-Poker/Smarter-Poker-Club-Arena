# server/src/tournament/oneRecoveryFeeTwoLanguages.law.test.ts

The fee on a rebuy or a re-entry is not configured anywhere. It is derived from
the ratio the buy-in and its fee happen to stand in, capped at ten percent, and
truncated down. Until migration 20260912103907 that derivation was written four
times in SQL and once in TypeScript, and nothing held any of them together.

The SQL three are one function now, fn_ca_recovery_fee_cents, and
server/src/tournament/recoveryFee.ts is the other half. Two is the fewest
possible: the quote is computed in TypeScript before the player is charged and
the charge is computed in SQL, and neither can call the other.

Every expected value in oneRecoveryFeeTwoLanguages.vectors.json was produced by
fn_ca_recovery_fee_cents, over the 54 distinct buy-in and fee pairs and the 16
distinct charge amounts this database actually holds, in both denominations.
The SQL is the source of truth for the file; the TypeScript is the thing under
test, so the law fails when the TypeScript drifts away from the database.

Each side derives the ratio itself, from the same two configured numbers,
rather than being handed a ratio the file has already rounded. That shape is
deliberate. SQL divides in exact decimal and JavaScript divides in binary
floating point, and a fee that truncates at a boundary is precisely where the
two could disagree. Handing both sides a pre-rounded ratio would hide the one
failure this law exists to catch.

What the law pins beyond equality: the fee never exceeds the ten percent cap
floored to the unit, never exceeds the charge, and is never negative; a Diamond
tournament whose charge is a whole number of Diamonds pays a whole Diamond fee
and leaves a whole number of Diamonds for the pool; and the chip answer is
identical to the pre-change rule written out longhand, which is what keeps the
chip estate still.
