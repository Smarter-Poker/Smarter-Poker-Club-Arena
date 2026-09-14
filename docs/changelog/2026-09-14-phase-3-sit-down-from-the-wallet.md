# Phase 3 of 8: sit down from the wallet

**Date:** 2026-09-14
**Branch:** `agent/cw-wallet2/feat/phase-3-sit-down-from-the-wallet` (stacked on
phase 2, PR #4608, which is stacked on phase 1, PR #4576)

**The Diamond Arena is diamonds only. No chips, ever.** (Dan, 2026-09-13.)

## The funnel, end to end

Phase 2's door opened when the arena was open. Open is not affordable: the
cheapest seat in the arena is NLH 1/2 at **80 diamonds** (read from the rows
2026-09-14), and a player holding 30 was sent to a lobby that could only
refuse them. The door is now decided by three facts the summary carries:

| the player                               | the door                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| holds diamonds at a seat                 | Return To The Diamond Arena (the lobby)                                                    |
| arena open, can afford the cheapest seat | Sit Down In The Diamond Arena (the lobby), and the plate says which seat and what it costs |
| arena open, short by N                   | Buy Diamonds To Sit Down, N More (the store, with the way back)                            |
| arena closed                             | Diamond Arena Opens Soon, and the next freeroll countdown when one is scheduled            |

**The cheapest seat is read, not guessed.** `fn_diamond_wallet_summary`
(migration `20260914101812`) now reports `arena.min_cash_buy_in`,
`arena.cheapest_table` and `arena.open_cash_tables`, selected with
`fn_poker_diamond_buyin`'s own table predicate (nlh, not a tournament, not a
cluster, not a template, a live status, none of the feature flags it refuses)
so the number is never a seat that function would refuse. Applied and probed:
80 / NLH 1/2 / 17 eligible tables / arena closed.

**The store offers the way back.** The wallet sends a short player to
`/marketplace?tab=diamonds&next=/clubs/diamond-arena`. `MarketplacePage`
validates `next` with `safeInAppRedirect` (the same validator the sign-in
redirect uses - an in-app path or nothing), `DiamondsTab` carries it through
the Stripe / StoreKit round trip in the return params, and on
`?purchase=success` the page shows "Payment Received. Your Diamonds Land In A
Few Seconds, And Your Seat Is Waiting." with **Continue To The Diamond Arena**.
The way onward is a router navigation; `next` is stripped from the URL when
taken.

**The one free way in.** A freeroll costs nothing, so while the arena is closed
the plate counts down to the next scheduled one through the same
`useNextDiamondFreeroll` the Home card uses - read only while the plates are
on screen and the arena is known to exist.

## Verified

- `tests/components/DiamondPlate.test.tsx` (10): reading, failed, known,
  closed sentence, open + enough on hand (door fires, cheapest seat named),
  open + short (Buy Diamonds To Sit Down, 50 More fires the store path and
  never the lobby), seated, freeroll countdown, unknown cheapest seat (never
  claims an amount), and no chip anywhere on the plate.
- `tests/unit/theWalletLearnsTheDiamondArena.test.ts` (13): the RPC parse
  including the new keys, the migration's predicate clauses, the store's
  validated `next`, the continue offer, the freeroll gate.
- `tsc`, eslint, the four copy gates and `check-route-targets` clean; 523
  tests across the covering suites.
