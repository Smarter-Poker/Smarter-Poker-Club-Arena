# The wallet learns the Diamond Arena again (2026-09-19)

**Lane:** `cw-diamond-wallet`, branch
`agent/cw-diamond-wallet/feat/the-wallet-learns-the-diamond-arena-again`
**Programme:** Diamond Arena launch readiness, Workstream A step A7: re-land
the archived wallet programme, phases 1 through 5.

**The Diamond Arena is diamonds only. No chips, ever.** (Dan, 2026-09-13.)

## What was wrong

The September 16 restore (`ea498c1fab`, #4711) archived the wallet programme
out of `main`: #4502 (the diamond ledger sums itself), #4576 / #4608 (phases 1
and 2) and #4613 (phases 3, 4 and 5). Their database side never left
production. `fn_diamond_lifetime_totals`, `fn_diamond_wallet_summary`,
`fn_diamond_arena_reconciliation`, `fn_diamond_kind_bucket` and
`fn_diamond_flow_by_kind` have been live since 2026-09-14, and #4941 put their
migration files back on `main`. The client that reads them was the missing
half, so on `main` today:

- `DiamondService.getLifetimeStats` returned `{ 0, 0 }` on a failed read, a
  new-account figure presented as a lifetime (CLAUDE.md 10.86: unknown is not
  zero), and summed up to 5,000 rows in the browser instead of asking the
  ledger;
- the Diamonds plate printed one figure and did not know the arena exists: no
  Sendable, no In The Arena, no collateral explanation, no door;
- the Ledger tab had no Diamond Arena Statement and the Earn tab had no split
  behind Earned and Spent.

## What changed

The three archived commits were cherry-picked onto today's `main` in order
(`37f1a331b0`, `6ba372e74b`, `e619ddd78e`), without any migration or
schema-manifest file: every function they call is already live and already on
`main`. No migration is added by this change and nothing was applied.

Conflicts were resolved in favour of the newer `main`:

- `marketplaceShared.ts` already carries `idempotencyKey` (plus `signal` and
  `expectedUserId` from the commerce release); the archived hunk was dropped.
- `DiamondWalletModal.tsx` already carries the `arena_deposit` / `arena_withdraw`
  labels ("Diamond Arena Buy-In" / "Diamond Arena Cash-Out") and the other
  high-volume kinds, in the newer palette; the archived hunk was dropped.
- `MarketplacePage.tsx` and `DiamondsTab.tsx` already carry the phase-3 store
  wiring (`?next=` validated by `safeInAppRedirect`, carried through checkout,
  "Continue To The Diamond Arena" after the purchase) in the hardened form
  #4805 shipped, where the offer is made only from a verified checkout receipt
  owned by the paying account. The archived versions were dropped and the
  archived pin in `tests/unit/theWalletLearnsTheDiamondArena.test.ts` now
  names that mechanism.
- The live `fn_diamond_kind_bucket` is the redefinition in
  `20260914114052_the_diamond_kind_map_names_every_writer.sql`, which
  superseded the first draft in `20260914110559_where_the_diamonds_go.sql` the
  same day. The two tests that pinned the kind map's text
  (`tests/the-diamond-arena-is-diamonds-only.law.test.ts`,
  `tests/unit/whereTheDiamondsGo.test.ts`) now read the live version;
  `fn_diamond_flow_by_kind` is unchanged and still pinned where it is defined.

What the player gets back, phase by phase (the archived changelogs are restored
beside this one and describe each in full):

1. `DiamondService.getLifetimeStats` calls `fn_diamond_lifetime_totals` and
   returns `null` when it cannot tell; the Earn pane renders Checking /
   Unavailable + Retry / the figure and re-sums on `BALANCE_UPDATED`. The send
   carries one idempotency key per intent, the floor is one diamond, and a
   ledger row names the other player.
2. `useDiamondWalletSummary` reads `fn_diamond_wallet_summary`; the Diamonds
   plate prints On Hand, Sendable and In The Arena, says how much is held as
   refund-window collateral and why, and the Send pane checks the amount
   against Sendable.
3. The arena door is decided by the summary: Return To The Diamond Arena when
   diamonds sit at a seat, Sit Down In The Diamond Arena when the arena is
   open and the cheapest eligible seat is affordable, Buy Diamonds To Sit
   Down, N More when it is not (the store, carrying the way back), and the
   sentence Diamond Arena Opens Soon with the next freeroll countdown when it
   is closed. Today both arena flags are false and no custody is open, so
   today's render is the sentence.
4. The Ledger tab carries the Diamond Arena Statement from
   `fn_diamond_arena_reconciliation`: sessions, buy-ins, cash-outs, in play,
   settled result, and every unmatched line in the player's words.
5. The Earn tab carries Where Your Diamonds Go from `fn_diamond_flow_by_kind`:
   spent and earned by bucket, lifetime or last 30 days, no chip vocabulary.

## How it was verified

- Read-only against production: all five functions exist; the bodies of
  `fn_diamond_lifetime_totals`, `fn_diamond_flow_by_kind` and
  `fn_diamond_kind_bucket` match the repo files byte for byte, and
  `fn_diamond_wallet_summary` and `fn_diamond_arena_reconciliation` match once
  the comment lines the apply route strips are removed. The summary's JSON keys
  (`on_hand`, `collateral`, `sendable`, `in_arena`, `arena_seats`,
  `arena_entries`, `arena.{club_id,name,slug,cash_games_enabled,
tournaments_enabled,open_cash_tables,min_cash_buy_in,cheapest_table}`,
  `lifetime_earned`, `lifetime_spent`, `read_at`) are the keys
  `DiamondService.getWalletSummary` parses. `ca_arena_settings` row 1 reads
  `cash_games_enabled = false`, `tournaments_enabled = false`, and
  `poker_diamond_custody` has no open row.
- Restored suites: `tests/unit/theDiamondLedgerSumsItself.test.ts`,
  `tests/wallet-casino-realism.test.ts`, `tests/components/DiamondPlate.test.tsx`,
  `tests/components/DiamondArenaStatement.test.tsx`,
  `tests/components/DiamondFlowPanel.test.tsx`,
  `tests/unit/theWalletLearnsTheDiamondArena.test.ts`,
  `tests/unit/whereTheDiamondsGo.test.ts`,
  `tests/the-diamond-arena-is-diamonds-only.law.test.ts`,
  `tests/the-diamond-arena-reconciles.law.test.ts` (with their
  `docs/laws.d/` entries) and `tests/law-registry.law.test.ts`.
- `npx tsc --noEmit`, the copy gates (`check-title-case`, `check-ui-text`,
  `check-painted-text-case`) and the full root vitest suite, as recorded in
  the pull request.

## Not done here, on purpose

No migration. No change to `TablePage`, `TableTabBar`, `DiamondArenaCard`,
`useNextDiamondFreeroll`, `ArenaAccessBoundary` or the lobby (other lanes own
them; the plate only calls the freeroll hook that already exists). Phases 6
through 8 of the wallet programme were never merged before the restore and are
not part of this change. The two arena switches stay off.
