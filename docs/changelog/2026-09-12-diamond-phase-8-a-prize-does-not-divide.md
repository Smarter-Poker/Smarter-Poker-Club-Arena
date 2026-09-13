# Diamond Phase 8: A Prize Does Not Divide

Status: Phase 8 Started. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door.

## The Last Place In The Estate That Assumed A Cent

Phase 7 taught the cash tables that a Diamond does not divide. Four dividers learned it: the run-it-twice per-board slice, the multi-board settlement, the tie chop inside one board, and the payout unit; the hi-lo split turned out to have learned it already. Every one of them now reads its table's unit instead of assuming a cent.

The prize ladder never did. `computePlacePrize` and its two SQL twins are hard-wired to cents, and the function's own header says so approvingly: the single division at the end is "the one place a half-cent is legitimately decided". That is exactly right for a chip tournament. It is exactly wrong for an indivisible unit, where a half Diamond is not a small imprecision but an amount no door in this estate accepts. The custody reserve floors it, the hand settler refuses it, and the wallet stores diamonds as an integer column.

This is the first piece of Phase 8, and it is deliberately the arithmetic rather than the doors. Diamond tournaments are still refused everywhere; what changes here is that the ladder they will one day use can pay in whole Diamonds.

## What Survives, Which Is The Point

A payout rule that pays whole Diamonds while losing its exactness has traded one defect for a worse one. So the guarantees are asserted in both denominations:

- **The places sum to the pool exactly.** Not to within a unit. The last paid place still takes whatever remains, and because a Diamond pool is a whole number of Diamonds and every share above it is snapped to a whole Diamond, the remainder is a whole Diamond too, by induction rather than by hope.
- **The residual lands on the last paid place**, never on a headline one.
- **The chip ladder did not move.** `unitCents` defaults to 1, so `Math.round(x / 1) * 1` is `Math.round(x)` and the chip path is unchanged by construction. The law pins the exact figures the production reconciler is pinned to, and a separate case proves that every place with the parameter omitted equals the same place with it passed as 1.

## The Defect The Test Found

A pool of one Diamond over nine places paid **ninth place everything and first place nothing**.

That has always been the arithmetic. Every non-last share rounds to zero, so the last place absorbs the whole pool as its "residual". At cent granularity reaching it needs a nine-place event with a pool under nine cents, so it has never happened and would have been a rounding curiosity if it had. At Diamond granularity the unit is a hundred times larger, the case is a hundred times closer, and it is not a curiosity: it is the entire prize going to the wrong player.

A pool that cannot pay every place now pays the places it can, one unit each from the top, in finishing order. There is no fairer answer available, because an indivisible unit cannot be split nine ways, and every other answer pays somebody more than the player who beat them.

## A Chip-Side Finding, Reported Rather Than Smuggled

The same defect is in the chip ladder, at pools under nine cents, and `payoutExactness.law.test.ts` proves it: that law's BigInt reference reproduces the old answer exactly, because the SQL reconciler `fn_tournament_payout_reconcile` implements the same rule and the law exists to keep the two agreeing. Repairing it for chips means moving the reconciler and the law's reference in the same commit.

That is a chip-estate change and it does not belong inside a Diamond slice, so the short-field rule is scoped to units larger than a cent and the reason is written where the scope decision is made. A nine-place chip event with a pool under nine cents is not reachable. A nine-place Diamond event with a pool under nine Diamonds is one short field away.

## Still To Come In This Phase

The survey found **eight** distinct divisions in the tournament money path that can produce a fraction of a Diamond, and this closes the first and largest of them. The others, in rough order of how badly they need it: the rebuy fee ratio, which truncates a _ratio_ to cents on every rebuy and flows straight into the prize pool; the final-table chip chop; multi-claimant bounty splits; the PKO half; the mystery bounty activation split; and the two SQL copies of this same ladder, which is three copies of one rule and therefore the drift pattern this estate has already been bitten by twice today.

Diamond tournaments remain refused at every door, and `cash_games_enabled` remains false.
