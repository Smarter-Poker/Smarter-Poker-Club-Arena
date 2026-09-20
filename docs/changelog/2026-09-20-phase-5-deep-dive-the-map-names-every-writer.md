# Phase 5 deep dive: the map names every writer, and a re-read never flashes (2026-09-20)

**THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.** (Dan, 2026-09-13.)

Dan's rule between phases: verify everything the previous phase built is
fully built, wired and tested before the next one starts. This is the phase 5
verification, and what it changed.

## What the deep dive found

1. **The first kind map named the kinds that were ON the ledger, not the
   kinds a writer can PRODUCE.** Reading every function that inserts into
   `diamond_transactions` (24), `diamond_reward_catalog.action_key` (33 keys)
   and the Mint register's own classification found twelve kinds that would
   have landed in Other or the wrong bucket the day a writer produced them:
   a Stripe reversal (`refund`, negative) and a chargeback `debt_settlement`
   as Other instead of a refunded purchase; `burn`, `admin`, `seeded`,
   `bridge`, `house` as Other instead of an adjustment; `tournament_fee` (the
   arena tournament drain) as Other instead of the arena; `streak_freeze` as
   Other instead of the store; `union_grant`, `promotional`, `promo*`,
   `birthday`, `first_purchase` and the `referral_*` family as Other instead
   of a bonus. Fixed at the source on 2026-09-14 by replacing the ONE map
   (`fn_diamond_kind_bucket`, same signature, same callers), applied as
   `20260914114052 the_diamond_kind_map_names_every_writer` and probed
   against every kind above plus the whole live ledger: every kind lands in
   a named bucket; only test rows and one bare `credit` of 20 remain in
   Other. The re-land (#4947) recorded that applied migration under its
   applied version; this pull request pins it.
2. **A balance change made the panel flash to "Reading" and could let a stale
   answer overwrite a fresh one.** Every `BALANCE_UPDATED` re-read reset the
   panel to its reading state, and two overlapping reads could resolve in
   either order. `DiamondFlowPanel` and `DiamondArenaStatement` now keep the
   last known figures on screen while re-reading and carry a sequence guard
   so only the latest read lands. Pinned by a new panel test that delivers
   two balance changes back to back with the first read slow.
3. **A long bucket label beside a six-figure amount would have clipped at
   375px.** `.flow-row__label` wraps instead of ellipsising; a money label is
   read in full.

Verified again, not assumed: the RPC's bucketed totals still equal
`fn_diamond_lifetime_totals` for the same player to the diamond; every
writer kind is pinned as an exact literal in the map by
`tests/unit/whereTheDiamondsGo.test.ts`, so a new writer must be named there
or CI says so; the diamonds-only law pins the live map.

## Findings outside phase 5, recorded, not fixed here

- `fn_poker_diamond_tournament_drain` journals the tournament fee as a
  second debit row (`tournament_fee`, `balance_after` = the unchanged
  wallet) after the whole entry already left the wallet as `arena_deposit`.
  When tournaments open, `fn_diamond_lifetime_totals` and this panel would
  count the fee twice against the player. Tournaments are disabled
  (`ca_arena_settings.tournaments_enabled = false`) and no such row exists;
  the fix belongs in the drain's writer, in the arena tournament programme.

## Publish state

Phases 1 to 5 were re-landed by #4947 after the September 13 baseline
restoration (#4711) and are live: ca-static served `745d7a50a1` at 13:34 UTC
today, an ancestor chain that contains #4613's squash `e619ddd78e`.
