# The jackpot outflow was an enumeration, and a returned seed fell outside it

2026-10-03. `20261002145612_the_jackpot_lifetime_counts_an_unopened_pool` was
merged on `main` and **not applied**: it was the single remaining entry keeping
`Production Integrity Audit`'s `Every merged migration is live` red. It had been
dispatched once and **refused by its own assertion**, reading 200.00 of
unexplained lifetime residue against a 1.00 tolerance.

The refusal was correct, and it was not the board moving under it. The figure is
read **after** `EXECUTE v_new`, so the migration's own new body did not
reconcile. This is what it was telling us.

## What it changes

Only `fn_bbj_conservation_check`, by text replacement of the 20261002135140
body (pre-image md5 `b1fb89dc98aaad152bd5b2085b88bbfa`, still the live body).
20261002135140 had put a post-epoch pool's journalled welcome seeds and burns
into the lifetime identity, but found those pools through their **meter
baseline**. A pool the hourly meter has not opened yet has none, so for up to an
hour after a club is created its 100.00 seed was balance with no inflow, and
`lifetime.moved_since_resolution` read -100.00. The follow-up widens the
later-opened set to every `bbj_pools` row whose opening - its baseline if the
meter has opened it, else its `created_at` - is after the epoch, and gives legs
back to the epoch residue only for a pool that HAS a baseline, so the epoch
figure is byte-identical.

## Why the first version did not close it

Read from rows at 03:53-04:05 UTC. Across **every** post-epoch pool the journal
carries exactly three leg categories:

| direction | category                  | legs | amount   |
| --------- | ------------------------- | ---- | -------- |
| in        | `club_opening_allocation` | 90   | 9,000.00 |
| out       | `burn`                    | 88   | 8,800.00 |
| out       | `treasury_transfer`       | 2    | 200.00   |

The body named only `'burn'` as a later pool's journalled outflow. So it brought
two pools' 100.00 seeds in as inflow against no outflow: **the 200.00 is those
two legs**, exactly.

Both are honest and conserved. Each is `bbj_pool -> club_treasury` 100.00 for
the same club at 20:49:52 and 21:04:18 UTC (pools `1ade3ec6`, `41cfec59`) - the
club deactivation returning the certification seed to the treasury instead of
burning it in place, alongside the Spin reserve's 200.00 returning under
`spin-deactivation-seed-return`. Each club's treasury was then burned whole
under `cert-retire:<club>`: 100,000.00 minted at opening, 100,000.00 retired.

**No player's money is implicated and nothing is owed.** All four unbaselined
pools hold 0.00 in every bank, have 0.00 `total_paid_out`, took no contribution
and paid no jackpot. They are empty round trips belonging to clubs that no
longer exist.

The live body reads 0.00 today only because it ignores those pools outright and
both treasury returns happen to be among them. The hole is latent, not absent:
the first **baselined** pool retired that way makes the live body read +100.00
too.

## The fix, and why it is not another enumeration

Naming what to INCLUDE is what left `treasury_transfer` outside the identity, so
the journalled legs are now the **complement of what the rest of the identity
already holds**:

- out: everything except `bbj_payout` and `promo`, the two families `v_out`
  already carries through `bbj_payouts` and the three promo-sweep terms;
- in: everything except `bbj_contribution`, which `v_in` already carries through
  `fn_bbj_contributions_total()`.

A new retirement category cannot fall outside a complement (CLAUDE.md 10.86
rule 4). The migration also asserts the journalled legs net to zero, so a
genuinely stranded seed is **refused, not absorbed**.

**No tolerance was widened.** It stays 1.00 lifetime and 0.01 epoch, asserted at
apply. Nothing is credited, written off, rebaselined or moved; the migration
writes no `chip_ledger` row, touches no `bbj_pools` balance, and changes no
residue.

## Measured

Pure read-only SELECT arithmetic over the live rows (no DDL probe, CLAUDE.md
section 2 rule 3): absorbed 8,400.00 unchanged either way; journalled inflow and
outflow both 9,000.00, net 0.00 - identical under the complement form and under
an explicit `('burn','treasury_transfer')` list. The welcome-certification
programme is creating and retiring a club every few minutes, so the gross
figures climb (8,800.00 at 03:55, 9,000.00 at 04:05) while the net stays exactly
0.00. The churn manufactures pools; it does not manufacture an imbalance.

No `financial_alerts` row was open for this check: the f3e82f59 incident row
(`a5a64228`) was already resolved by 20261002135140 at 14:57 UTC.

## Still open, deliberately out of scope

The two `treasury_transfer` legs carry **no idempotency key** and the generic
`auto-ledgered clubs.chip_treasury delta 100.00` description, while the Spin
reserve's return in the same transaction is declared properly (`reversal`, keyed,
described). The BBJ side of the club-deactivation seed return rides the
auto-ledger instead of declaring itself. That is a defect in the deactivation
door, not in this identity, and it is reported rather than widened into this
change (CLAUDE.md 10.9, financial scope).

## The pin

`tests/the-jackpot-epoch-counts-each-pool-from-its-own-opening.law.test.ts`
gains a case moved in the same commit: the journalled legs are the complement,
`AND l.category = 'burn'), 0) AS burned` is refused, and both assertion
thresholds are pinned so a later agent cannot make this green by loosening them.
