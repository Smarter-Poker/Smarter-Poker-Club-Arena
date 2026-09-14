# Phase 1 of 8: the wallet learns the Diamond Arena

**Date:** 2026-09-13
**Branch:** `agent/cw-wallet2/feat/phase-1-the-wallet-learns-the-diamond-arena`
**Programme:** the diamond wallet as the funding surface for the Diamond Arena
(phases 1-8; this is the read model everything after it renders).

## The rule this programme is built on

**The Diamond Arena is diamonds only. No chips, ever.** Dan, 2026-09-13,
twice, answering my own proposal of an "arena chips" plate and a
diamonds-to-chips conversion flow. The database already enforces it
(`poker_arena_membership_guard`, 20260908152822: any chip balance on the
diamonds club raises "Diamond Membership Is Automatic And Has No Chip Wallet
Or Hierarchy"). Measured before this phase: the arena club has 0 members with
a chip balance, 0 `chip_ledger` rows, 0 chip stacks across its 17 tables.
`tests/the-diamond-arena-is-diamonds-only.law.test.ts` keeps the WALLET on the
same side: no chip figure in the summary read, no chip label on an arena
ledger row, no surface pairing the arena with chips, and the guard stays in
the migrations.

## What was true before

The wallet printed one diamond figure, `profiles.diamonds`, and did not know
the Diamond Arena exists: zero references in `PlayerWalletPage`, the ledger
hook or `DiamondService`. Meanwhile the platform already held three figures a
player is judged by and shown none of:

- **collateral** - purchased diamonds inside the refund window, which
  `send_wallet_diamond_transfer` refuses to send
  (`insufficient_transferable_diamonds`); computed in that RPC, shown nowhere;
- **in the arena** - diamonds moved into `poker_diamond_custody` by
  `fn_poker_diamond_buyin` for a cash seat or a tournament entry; already
  outside `profiles.diamonds`, so a seated player's wallet just looked smaller;
- **whether the arena is open** - `ca_arena_settings.cash_games_enabled` and
  `tournaments_enabled`, both `false` today (release gated on accounting
  certification).

## What this phase ships

**`fn_diamond_wallet_summary()`** (migration `20260914015457`): one read
returning `on_hand`, `collateral` (the exact expression the transfer RPC
refuses on, so `sendable` is what a send will actually allow), `sendable`,
`in_arena` with seat and entry counts, the arena club with its open flags, and
the lifetime totals from `fn_diamond_lifetime_totals`. SECURITY DEFINER because
`ca_arena_settings` and `diamond_purchase_lots` are not readable by
`authenticated`; pinned to `auth.uid()` unless the caller is `service_role`,
raising `wallet_summary_is_own_only` otherwise - no route to another player's
figures. Probed on production in a rolled-back block (see below).

**`DiamondService.getWalletSummary()`** parses it strictly (a non-numeric
figure or a string `"true"` flag is a failure, not a guess) and returns `null`
when it cannot tell (10.86).

**Ledger labels.** `arena_deposit` / `arena_withdraw` read "Diamond Arena
Buy-In" / "Diamond Arena Cash-Out" instead of the humaniser's "Arena Deposit";
the gift kinds and every high-volume kind of the last 30 days that had no
label (daily challenge claims are 55,183 of 57,000 rows) get one.

**Wired in (verification pass, 2026-09-14).** A read nobody calls is a stub,
so the page now owns it through `useDiamondWalletSummary` (three outcomes:
reading / failed / known; re-reads on `BALANCE_UPDATED` and on tab
visibility). The Send pane prints **Sendable**, the figure the transfer RPC
will actually honour, says when it could not read it rather than printing On
Hand as if it were sendable, and tells a player holding refund-window
collateral why the two differ - before the server refuses them. The client
check and the input's `max` use the same figure. Phase 2 draws the plate and
the hero's three figures from the same hook; phase 3 opens the door.

**World Hub parity (same pass).** Its wallet fell back to "Adjustment" for
any unknown kind, so every daily challenge claim and any future arena row
read as an admin correction. Same labels there now, and an unknown kind is
humanised instead (PR #1754).

## Verified

- Migration applied outside the break window; recorded as
  `the_wallet_learns_the_diamond_arena`.
- Production probe, rolled back: as an `authenticated` player the function
  returns that player's own figures; naming another player raises
  `wallet_summary_is_own_only`.
- `tests/unit/theWalletLearnsTheDiamondArena.test.ts` (5),
  `tests/the-diamond-arena-is-diamonds-only.law.test.ts` (5), law registry.
