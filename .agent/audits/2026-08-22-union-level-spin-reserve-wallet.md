# Union-level Spin reserve wallet

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Tier:** 3 (money routing + balance movement)
**Migration:** `supabase/migrations/20260822030000_union_level_spin_reserve_wallet.sql`
**Applied to production as:** `union_level_spin_reserve_wallet`
**Test:** `tests/config/spinReserveOwnership.test.ts` (11 assertions)

Dan, verbatim: _"THE RESERVE POOL COMES FROM THE UNION NOT THE CLUBS. IT ONLY
COMES FROM THE CLUBS IF THEY ARE A STAND ALONE CLUB WITH NO UNION AFFILIATION.
AND YOU NEED TO CREATE THE WALLET TO HOLD THE SEEDED AND RESERVE FUNDS."_

---

## 1. What was actually wrong

Half of this shipped on 2026-08-20. `fn_spin_reserve_seed_from_union` already
debited a union wallet to fund a pool, so the _funding_ looked union-level. The
**pool** did not follow. `spin_bonus_pools` was keyed by `club_id`, so one union
ran three unrelated reserves:

| pool         | balance   | seeded | spins |
| ------------ | --------- | ------ | ----- |
| Midway Union | 10,746.40 | 10,000 | 1,455 |
| Club JAQK    | 5,000.00  | 5,000  | 0     |
| SHARK CLUB   | 5,000.00  | 5,000  | 0     |

All 20,000 of that seed came out of the union's **`promo_wallet`** — money
earmarked for promotions — because no reserve wallet existed to take it from.
Four `spin_reserve_seed` rows in `union_wallet_transactions`, 2026-08-20
19:37–19:46 UTC, all `wallet='promo_wallet'`.

**Why three pools is not just a smaller version of one.** The reserve exists
because a 100x is paid out of accumulated volume. Split the same capital three
ways and each fragment clears the 100x threshold at a third the rate, so the
top tier stays locked for everyone while the union collectively holds plenty.
Pooling is not an optimisation here, it is the product.

## 2. What changed

**Ownership has exactly one answer.** `fn_spin_reserve_owner(club)` returns the
club's union if it has one, otherwise the club itself. `fn_spin_reserve_pool()`
wraps it and guarantees the row exists. Every RPC calls that one function; no
caller decides for itself, which is how three pools happened in the first place.

**The engine did not change at all.** Every RPC keeps its exact signature and
still takes the _playing_ club's id — resolution happens inside the database.
That was deliberate: the smallest possible change surface on a money path, and
no cached client can fall out of contract with it.

**`spin_bonus_pools.club_id` now holds the OWNER id.** The column keeps its
name and its unique index. A union already _is_ a `clubs` row in this schema
(`is_union = true`, same uuid as `unions.id`), so union-owned rows needed no new
key type and every existing join still resolves. `owner_kind` records which it is.

**The wallet.** `union_wallets.spin_reserve_wallet`, with
`fn_spin_reserve_wallet_fund()` to put capital in and
`fn_spin_reserve_seed_from_union()` now defaulting to it as the seed source
instead of raiding `promo_wallet`. `union_wallet_transactions.wallet` accepts it
(and `insurance_wallet`, which the column existed for but the CHECK had omitted).

**Surplus now has a destination.** Above the ceiling, money used to be
decremented off the pool and named no recipient — it left the ledger and landed
nowhere. It now credits the union's reserve wallet with a matching
`union_wallet_transactions` row. Standalone clubs, which have no union wallet,
behave exactly as before.

**Rake did not move.** `rake_records` is still written with the _playing_
club's id. Rake belongs to the club that generated it and reaches the union
through the existing settlement path; booking it against the pool owner would
pay unions twice and starve every club's own P&L. There is a test for this.

## 3. Dan's decisions

- The two 5,000 club seeds **merge** into the union pool.
- The union ceiling rises **20,000 → 30,000** so the merge does not immediately
  trip a surplus return.
- **Standalone clubs behave identically to today** — same draw gate, same
  shortfall logging. No second set of rules to reason about.

## 4. Two traps found while building this

**`fn_spin_reserve_owner` must be executable by `anon`, and that is not a
mistake.** A function invoked inside a view has its EXECUTE privilege checked
against the _calling_ role, not the view's owner. Revoking it from `anon` would
have made every `v_spin_tier_availability` read fail — the exact dark-badge
outage of 2026-08-21, reintroduced by the very view meant to prevent it. It is
safe to grant: it maps a club to its union, and `clubs.union_id` is already
readable by `anon`. It exposes no balance. Every other `fn_spin_*` stays revoked.

**A merge must not be booked as an `adjustment`.** `v_spin_reserve_health`
counts `kind='adjustment'` as shortfall events and `pages/api/cron/spin-sweep.js`
alerts on any non-zero count. Booking the merge as an adjustment would have
paged someone about a shortfall that never happened. New ledger kinds `'merge'`
and `'wallet_return'` exist for this reason, and `shortfall_events` reads 0
after the merge.

**`v_spin_tier_availability` is now driven FROM `clubs`, not from the pool.**
After pooling, an affiliated club has no pool row of its own; a pool-keyed view
returns nothing for it and its lobby badge goes dark. This is the 2026-08-21
lesson applied before it could bite: _what a deployed client selects is that
client's contract._

## 5. Verified in production

```
orphan_pools           0     (no pool owned by an affiliated club)
clubs_without_pool     0     (every club resolves to a pool that exists)
clubs                  3  =  tier_rows 3      (every club still gets a badge row)
pools                  1     Midway Union, owner_kind 'union'
                             balance 20,944.34 · seeded 20,000 · ceiling 30,000
                             highest_stake 100 · 1,491 spins
merge_rows             4     netting 0.00     (both sides booked, money conserved)
unions_without_wallet  0
anon_exec_money_fns    []    (fn_spin_reserve_owner excepted, by design)
shortfall_events       0
```

The balance reads 20,944.34 rather than 20,746.40 because 36 further spins
settled between measurement and apply — `spin_count` 1,455 → 1,491. Money is
conserved; the difference is live volume.

Behavioural checks:

- `anon` reads `v_spin_tier_availability` and gets 3 rows, one per club.
- `service_role` reads the exact column list `spin-sweep.js` selects, including
  `can_draw_500x`, which is deliberately still there (see §6).
- `fn_spin_draw_multiplier` called for **Club JAQK** returned
  `owner_id = Midway Union`, `reserve_balance = 20,944.34`, `locked: []`.
- An unknown uuid resolves to itself — the standalone path.
- Wallet paths exercised inside a transaction that was then aborted:
  fund-from-promo (250 moved, wallet 0 → 250), seed an affiliated club from the
  reserve wallet (debited 100, credited the **union** pool), a foreign union
  refused with `union_does_not_own_this_reserve`, an overdraw refused with
  `insufficient_union_funds` and the available/requested figures rather than
  silently clamped. Balances confirmed unchanged afterwards.

Test suite from a clean worktree off `origin/main`: **229 files, 2,889 passed,
5 skipped, 0 failed.**

## 6. Deliberately NOT done

**The 500x columns stay in `v_spin_reserve_health`.** The tier is retired, but
`pages/api/cron/spin-sweep.js` in the World Hub still selects `can_draw_500x`
and that reader deploys separately. Dropping the column while a live reader
selects it is the 2026-08-21 incident verbatim. Two-step it: ship the cron
change, wait, then drop.

**`union_wallets` has no UI for the new wallet yet.** `spin_reserve_wallet`
reads 0 and will stay 0 until someone funds it.
`pages/api/club-arena/union-wallet.js` does not surface it.

## 7. Follow-ups

1. **Surface `spin_reserve_wallet`** in the union wallet UI and API, and give
   it a fund control. Right now it is only reachable through the RPC.
2. **Retire the 500x columns** from `v_spin_reserve_health` and `spin-sweep.js`
   together, reader first.
3. **Three permanently unbooked spins.** `dea62e98`, `a374cdd3`, `78181713`
   (2026-08-21 17:44 UTC, Midway Union, buy-ins 1/2/3) all completed with
   `spin_multiplier = null`. `fn_spin_sweep_unbooked` requires
   `spin_multiplier > 0`, so it skips them and they will show in `unbooked_24h`
   until they age out, then be unbooked forever. Pre-existing and unrelated to
   this change — but it means the draw did not happen for three games that ran.
   Worth understanding _why_ before it recurs.
4. **`20260821_challenge_rerolls.sql` was never applied.** Regenerating the CI
   schema manifest for this PR removed `fn_reroll_challenge` from it — the
   function is declared by that migration file and does not exist in
   production. Nothing calls it (the phantom-RPC gate reports 0 phantoms), so
   it breaks nothing today, but it is a feature the repo believes in and the
   database has never heard of. Apply it or delete the file.
5. **Decide whether the seed idempotency key should be owner-scoped.**
   `fn_spin_reserve_seed_from_union` defaults its key to
   `spinseed:<union>:<club>`, so seeding "for JAQK" and "for SHARK" are distinct
   keys that both credit the same union pool. That is arguably right — two
   deliberate seeds — but it should be a decision rather than an accident.
