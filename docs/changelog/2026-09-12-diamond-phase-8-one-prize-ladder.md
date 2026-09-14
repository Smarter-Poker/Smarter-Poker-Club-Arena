# Diamond Phase 8: One Prize Ladder, And It Knows Its Unit

Status: Phase 8 In Progress. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door.

## Four Spellings Of One Rule

The rule that turns a prize pool into per place amounts was written four times. `fn_ca_tournament_place_amounts` is the payer. `fn_tournament_place_prize_exact` is the reprice path. A third copy lives inside `fn_tournament_payout_reconcile`, which exists to check the other two. `computePlacePrize` is the TypeScript. Two languages, four spellings, one rule, and nothing held the three SQL copies to each other.

That is the drift shape this estate was bitten by twice on 2026-09-12 alone. The plain cash rule had become five rules. The games list had become five copies. Both were found by looking, not by failing, which is the part worth noticing: a rule written in four places does not announce that three of them have moved.

They are one function now. `fn_ca_prize_ladder` takes cents and entries and a unit, and returns cents. The three callers keep the validation they legitimately own. The payer still knows about Spin ladders, the trim to the final field and the Bubble reserve. The reprice path is still pure. The checker is still read only. What they no longer each own is the division, which is the part that drifted.

## And It Takes The Unit

Phase 7 taught the cash tables that a Diamond does not divide, and `computePlacePrize` learned it earlier the same day. This is the SQL half of that change. A Diamond tournament now prices its ladder in whole Diamonds, and the two languages implement one rule in the one place each of them keeps it.

On a 513 pool with the nine place structure, the chip ladder still pays 153.90, 102.60, 71.82, 51.30, 41.04, 33.35, 25.65, 17.96, 15.38. The Diamond ladder pays 154, 103, 72, 51, 41, 33, 26, 18 and 15. Both sum to 513 exactly.

## The Checker Had To Move In The Same Migration

This is the part that was not optional. `fn_tournament_payout_reconcile` does not merely report. It tops up a place it believes was underpaid. Had the payer snapped a Diamond prize to a whole Diamond while the checker went on dividing to the cent, the checker would have read every Diamond tournament as underpaid by up to 99 cents a place and paid the difference, manufacturing the very overpayment it exists to detect.

That is not a hypothetical. It is what happened on 2026-08-29 with the Union Morning Classic, where a float in the engine and exact decimal in the database disagreed by a cent, the reconciler topped up the difference, and the event paid 513.01 against a 513.00 pool twice a day until it was found. The payer and the checker learn the unit together or not at all.

## Proved Rather Than Asserted

The migration refuses to apply unless the chip answers are unchanged, and it establishes that three ways rather than by inspection.

A reference copy of the pre change arithmetic is rebuilt inside the migration and run against the new ladder across every distinct payout structure the database stores, crossed with the pools that land on the interesting rounding boundaries, including the 513.00 and 483.00 that produced real one cent errors.

The payer is then asked, before a byte of it changes, what it says about 500 real completed tournaments. After the rewrite it is asked the same 500 questions, and every answer must match to the cent. A tournament it refused to price must still be refused, because a refusal is an answer too.

The checker's arithmetic is compared the same way over 2,000 real completed tournaments, against its exact pre change rule. The checker itself is never invoked. A function that moves money is not something to call two thousand times inside a migration to satisfy curiosity, and what changed inside it was one block of arithmetic, so that block is what was compared.

All three passed, which is why the migration applied. Had any one of them disagreed on a single tournament, nothing would have been applied at all.

## What Was Left Alone, Deliberately

The checker keeps its own entry semantics. It reads the stored structure verbatim, with no de duplication and no place filter, exactly as it did before. Three malformed shapes exist where that would disagree with the new ladder's residual rule, and across the 160,955 tournaments in this database carrying an array payout structure there are zero duplicate places, zero non positive percentages and zero malformed places. The payer rejects every one of those shapes outright in any case.

A subtler decision went the other way. The normaliser KEEPS a place whose percentage is zero, clamped to zero basis points, because `computePlacePrize` keeps it and so did the reprice path. An earlier draft dropped it, which looked like tidying and was not: the residual goes to the last entry, so dropping a trailing zero percentage place moves the residual to a different player. That draft was corrected before anything was applied, and the law now requires a structure of that shape to be present in its vectors.

The chip ladder's own short field defect is reported rather than smuggled. At pools holding fewer cents than there are places, the last place absorbs the pool and the winner is paid nothing. The new short field rule is gated to units larger than a cent, so the chip path is unchanged by construction. Repairing it for chips means moving `payoutExactness.law.test.ts`'s BigInt reference in the same commit, which is a chip estate change and does not belong inside a Diamond slice. A nine place chip event with a pool under nine cents is not reachable. A nine place Diamond event with a pool under nine Diamonds is one short field away, which is why the Diamond side is fixed here.

## The Bond Across The Language Boundary

Three SQL copies became one, which leaves two implementations in total, and two is the fewest possible: the engine prices places in TypeScript and the database prices them in SQL, and neither can call the other.

The TypeScript pair is held together by a byte for byte comparison. The new law, `oneLadderTwoLanguages.law.test.ts`, is the equivalent bond across the language boundary, and it cannot be a byte comparison. Every expected value in its vector file was produced by `fn_ca_prize_ladder` executing in Postgres, in both denominations, over the structures this platform ships. The SQL is the source of truth for the file and `computePlacePrize` is the thing under test, so the law fails when the TypeScript drifts away from the database.

On exactness it asserts the bound rather than the convenient equality. A chip ladder spends the pool to the cent, always. A Diamond ladder does too, except in the short field, where the pool's sub Diamond remainder goes to nobody, because there is nobody it can go to. That remainder is always smaller than one unit and is zero whenever the pool is a whole number of Diamonds, which every Diamond pool in this estate is by construction.

## A Door That Was Opened By Accident, And The Assertion That Missed It

`fn_tournament_place_prize_exact` gained a parameter, and a parameter means the old function had to be dropped and a new one created. A new function in this project's `public` schema is created with default privileges that grant EXECUTE to anon, authenticated and service_role. The old function's ACL was `{postgres=X/postgres}`: nobody but the owner could call it. The new one came back reachable by anon, and it is SECURITY DEFINER, so it ran as the owner past RLS for a caller with no account.

The migration did revoke, and the revoke was not enough. It revoked from PUBLIC, and the assertion that followed it checked exactly that one thing. The anon, authenticated and service_role grants are separate entries, so the migration proved the part it had thought of and said nothing about the part it had not. That is worse than having no assertion, because a narrow check that passes reads as a guarantee.

The pre-push hook `check-definer-authorization` caught it before the branch left the machine, which is what that hook is for. Migration `20260912095522_the_prize_ladder_keeps_the_door_it_was_given.sql` restores the door to exactly where it was and asserts the whole ACL rather than one entry of it. The three new helpers are closed the same way, since each is only ever called from inside a function owned by postgres.

The repair's own revokes are written out one statement at a time rather than looped over an array of signatures. `check-definer-authorization` models what a browser can reach by reading the migrations themselves and applying every GRANT and REVOKE to the roles it actually names, so a revoke issued through `EXECUTE format(...)` names nothing it can see. A loop would have closed the door in the database while leaving the gate certain it was open.

Writing that second assertion turned up the same shape of error one more time. A NULL `proacl` is not an empty ACL; it means the object still carries the built-in defaults, and the built-in default for a function is EXECUTE to PUBLIC. `aclexplode(NULL)` returns no rows, so an EXISTS over it reports "no grants" for the most open state there is. The check now names that case explicitly.

## Applied

Migrations `20260912090000_one_prize_ladder_and_it_knows_its_unit.sql` and `20260912095522_the_prize_ladder_keeps_the_door_it_was_given.sql`, each applied once. Never reapply.

All four functions are `{postgres=X/postgres}`: anon, authenticated and service_role cannot execute any of them.

There is one Diamond arena club and there are zero Diamond tournaments, so every tournament this change touched is a chip tournament and every one of them prices exactly as it did before.
