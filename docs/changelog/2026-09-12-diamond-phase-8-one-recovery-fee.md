# Diamond Phase 8: One Recovery Fee, And It Knows Its Unit

Status: Phase 8 In Progress. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door.

## The Fee Nobody Configures

The fee on a rebuy or a re-entry is not set anywhere. It is derived, from the ratio the buy-in and its fee happen to stand in, capped at ten percent, and truncated down. That derivation was written four times: in the refund authority, in the money core that performs the charge, inline inside the escrow view, and again in TypeScript in the quote the player is shown before they pay.

One rule, four spellings. The prize ladder carried the same shape until earlier today, and this is the same repair for the same reason. The Phase 8 audit calls this site the worst of the eight it found, for a specific reason: every other divider in the tournament path runs at settlement, and this one runs on ordinary play. What it produces flows straight into `prize_pool`, which is the pool everything else divides.

## What Was Actually Wrong

`trunc(gross * ratio * 100 + eps) / 100` truncates to a cent, because a cent is hard-coded as the smallest amount anybody can be paid. For a chip tournament that is correct. For a Diamond tournament it is not. A 10 Diamond rebuy at a 10/110 fee ratio produced a fee of 0.90 and dropped 9.10 Diamonds into the prize pool. Nine and a tenth Diamonds is not an amount this estate can pay, store or reserve: the custody reserve floors it, the hand settler refuses it, and the wallet stores diamonds as an integer column.

## This Is Not A New Rake Rate

That distinction is the whole of the argument for making the change at all, so it is worth stating plainly rather than leaving to be inferred.

The rule already truncated the fee down to the smallest payable amount. The defect was that it believed the smallest payable amount is always a cent. The fee is still the same ratio, still capped at ten percent, still truncated down, still in the player's favour. It is told what a unit is instead of assuming one, exactly as the cash tables were in Phase 7 and the prize ladder was this morning.

On the ten-for-one-hundred-and-ten ratio every Diamond amount now comes out whole: a 15 charge pays 1 and sends 14 to the pool, a 200 charge pays 18 and sends 182. A 10 charge pays nothing, which is the same whole-number floor behaviour the buy-in split already documents for small totals. The cap is floored to the unit too, because a cap that is not on the grid is not a cap the fee can honour.

## Proved Rather Than Asserted

The migration refuses to apply unless the chip estate is unchanged, and it establishes that three ways.

The refund authority is asked what it says about 2,000 real charge shapes before a byte of it changes, and asked the same 2,000 questions afterwards. Every answer must match, and a charge it refused to split must still be refused, because a refusal is an answer too. The escrow view is compared the same way across 150 real tournaments.

The money core is never called. A function that charges a player is not something to invoke thousands of times inside a migration to prove a division, so what changed inside it is what gets compared: a reference copy of the exact pre-change expression, run against the new rule over every charge amount this database has ever recorded paired with every fee ratio any tournament configures. That cross product is 160 pairs, which is not a sample of the reachable input space but the whole of it.

All three passed. Had any one of them disagreed on a single charge, nothing would have been applied.

## Two Languages, One Rule, Held Together

Three SQL copies became one, which leaves two implementations: the quote computed in TypeScript before the player is charged, and the charge computed in SQL. Neither can call the other.

`server/src/tournament/recoveryFee.ts` is the TypeScript half, a dependency-free leaf for the same reason `payoutMath.ts` is one. The new law pins it against 1,728 vectors produced by the SQL itself, over the 54 distinct buy-in and fee pairs and the 16 distinct charge amounts this database actually holds, in both denominations.

Each side derives the ratio itself from the same two configured numbers rather than being handed one the file has already rounded. That shape is deliberate: SQL divides in exact decimal and JavaScript divides in binary floating point, and a fee that truncates at a boundary is precisely where the two could disagree. Handing both sides a pre-rounded ratio would have hidden the one failure the law exists to catch. They agree on all 1,728.

## The One Wire Left

`TournamentRowLite` now carries an optional `unit_cents`, and no select populates it yet. That is deliberate rather than forgotten, and it is recorded here so it is not discovered later as a surprise.

Reading the unit into the quote means joining clubs into the tournament read, which belongs with the work that opens the Diamond tournament door rather than with the arithmetic. The arithmetic is correct for both denominations now, and the quote defaults to a cent when the field is absent, so the chip path is unchanged. The field is the one wire left to connect, and everything downstream of it is already waiting.

## Applied

Migration `20260912103907_one_recovery_fee_and_it_knows_its_unit.sql`, applied once. Never reapply.

All three new functions are `{postgres=X/postgres}` and were created owner-only in the migration that declares them, rather than closed afterwards.
