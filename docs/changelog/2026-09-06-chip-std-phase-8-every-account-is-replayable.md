# 2026-09-06 - chip standard Phase 8.1: every account is replayable

**Branch** `fix/union-to-club-money-declares-itself`. Two migrations, probed, applied, mirrored byte-exact: `20260906011010_phase_8_1_the_other_side_of_a_leg_names_the_column_this_side` (01:12 UTC) and `20260906011716_a_residue_that_already_cancelled_is_not_a_finding` (01:19 UTC). Law test extended (LAW 3b, 3c). Every figure read from production between 01:05 and 01:22 UTC.

## The last blind spot, closed

The replay reported the same number every run since it was built: **579 legs a day it could not key to a column**, and therefore could not replay. A union wallet has six balance columns and an agent two, so a leg on that side needs a label to say which one moved - and the autoledger writes the label only on the side whose table it watched. The counterparty side carries none.

Read against the rows rather than guessed at, the 579 are three shapes and every one is a promo move: 288 `bbj_pool -> union_wallet` (all 288 entities ARE unions), 287 `bbj_pool -> promo_wallet` (all 287 ARE clubs, 0 agents), and the 3 `union_wallet` legs of the 09-05 promo reroute.

**The rule is exact, not a heuristic: the other side of a leg names what moved.** Money that leaves a promo bank arrives in a promo bank; the labelled side says `bbj_pools.promo_balance` or `clubs.promo_balance`, and the unlabelled side is then the promo column of whatever its entity is - a union's `promo_wallet`, a club's `promo_balance`, an agent's `promo_wallet_balance`. The entity's identity decides which, read from the tables. Nothing is inferred from the category, which can change; the rule reads the leg's own two sides. What still cannot be keyed is still counted and reported, and the migration refuses to apply unless that count is zero.

## And a flaw in the arithmetic, inherited and now fixed

With every leg keyed the replay ran clean and then filed four findings that each read, in their own words, `0.00 unexplained this interval`. A finding whose interval is zero is not a finding.

The cause was the rule I copied from the BBJ meter: "this interval plus the previous one" double-counts along a chain. A +100 boundary residue at run N is cancelled by -100 at run N+1 (correctly, no finding) and then reappears at run N+2, where this interval is 0.00 and the previous is -100 - counted once when it cancels and again when it is already gone.

What an account actually has is a **cumulative** residue since its baseline: for a boundary it oscillates around zero, for a leak it grows. The snapshot carries that now, and a finding needs a non-zero cumulative **and** two consecutive intervals moving it the same way - the supply meter's own rule, written on this platform on 2026-09-01: a leak persists, an oscillation flips. A single interval of 100 chips or more is always shown whatever its sign. The same flaw is present in `fn_bbj_reconcile_all`, which this borrowed the pattern from; it is named for the BBJ lane rather than changed here, because its window has a different cadence and its own law test.

## What the platform can now say

Two consecutive runs, each inside one `REPEATABLE READ` snapshot, minutes apart:

> **1,012 accounts checked. 0 legs unkeyable. 1 disagreement.**

Every player wallet, every union wallet and rake and promo and BBJ bank, every club treasury, both spin reserves and every agent float agrees with the journal exactly. The single disagreement is the felt, at -24.88 and then -10.74 on movements of hundreds - the engine writes a hand's seat stacks and its rake and jackpot legs in two transactions, so at any instant a population of hands has stacks written and legs pending. It changes sign as hands settle and does not accumulate. It is named as the engine's two-transaction settlement rather than tuned away with a tolerance; the fix is one transaction per hand, in the engine lane, and the replay keeps reporting it honestly until then.

## Phase 8, the rest

- **8.2 C3 (bust rebuy through the pending ledger)**, **8.3 the PITR drill** and **8.4 `chip_ledger` partitioning** (dated before December, blocked on the `ca_mint_ledger.chip_ledger_id` foreign key) are the programme's remaining items.
- The felt's in-flight settlement is now a named engine item with a measured size.
