# LAWS.md — the single registry of binding laws

Created 2026-09-01 after the hamburger-menu revert war (#2321 -> #2401 ->
#2429 -> #2432): two law tests demanding OPPOSITE artwork coexisted in
different worktrees, and every agent that read one re-reverted the other's
work. Two laws fighting is not a stricter repo, it is a coin flip decided by
whichever test the next agent notices first.

## The rules of this registry

1. **Every `*.law.test.*` file must be listed here.** Enforced by
   `tests/law-registry.law.test.ts` — an unregistered law test fails CI with
   instructions to add it below, in the same commit that writes it.
2. **Laws are read from `origin/main`, never from your local tree.** Worktrees
   go stale by hundreds of commits; a stale tree carrying a retired law is how
   the revert war sustained itself. Before enforcing any law, confirm it still
   exists on current `origin/main`.
3. **Never resolve a conflict between two laws by writing a third.** If you
   find two entries (or two tests) demanding opposite things, STOP and ask
   Dan. Record his answer here and delete the loser in the same PR.
4. **Retiring a law** requires deleting BOTH the test file and its row here in
   the same PR, with the reason in the PR body. A row without a file (or a
   file without a row) fails CI.

## Resolved conflicts — do not reopen

- **Hamburger menu artwork (resolved 2026-09-01, PR #2432):** the hamburger
  STAYS on every drawer trigger. "Em bars" in Dan's 2026-08-20 instruction
  means EM DASHES (U+2014) in player-facing copy — a punctuation rule, not an
  artwork rule. The law is `approvedHamburgerGearGuard.law.test.ts`. The
  retired counter-law (`noThreeBarArtwork.law.test.ts`) must not come back.
- **Horses are players (2026-08-27):** no `is_horse` exclusion anywhere except
  identification and the horse's input device. See CLAUDE.md 10.5.

## Registry

| Law test file                                                        | Guards                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/a-control-that-says-none-must-mean-none.law.test.ts            | UI controls labeled "none" disable the feature entirely                                                                                                          |
| tests/a-credit-line-is-spendable.law.test.ts                         | Club credit lines can actually be spent                                                                                                                          |
| tests/a-demotion-closes-the-books.law.test.ts                        | Agent demotion settles outstanding balances                                                                                                                      |
| tests/a-promotion-does-not-end-at-the-role.law.test.ts               | Promotion applies downstream effects, not just the role                                                                                                          |
| tests/a-seat-that-waits-forever-gets-its-chips-back.law.test.ts      | Stranded seats refund                                                                                                                                            |
| tests/a-unit-suffix-is-not-a-word.law.test.ts                        | Number formatting of unit suffixes                                                                                                                               |
| tests/action-bar-never-leaves.law.test.ts                            | The action bar stays mounted                                                                                                                                     |
| tests/an-agent-can-finally-be-paid.law.test.ts                       | Agent commission payout path                                                                                                                                     |
| tests/an-invoice-bills-what-was-borrowed.law.test.ts                 | Invoices bill actual borrowings                                                                                                                                  |
| tests/animations-always-play.law.test.ts                             | Animations always play (CLAUDE.md 10.6)                                                                                                                          |
| tests/approvedHamburgerGearGuard.law.test.ts                         | Hamburger menu artwork stays (see resolved conflicts)                                                                                                            |
| tests/config/weightedContributedRake.law.test.ts                     | Weighted-contributed rake schedule                                                                                                                               |
| tests/footer-stays-on-the-footer.law.test.ts                         | Footer placement                                                                                                                                                 |
| tests/hero-avatar-opens-hero-hub.law.test.ts                         | Hero avatar navigation                                                                                                                                           |
| tests/no-auto-table-switch.law.test.ts                               | Never auto-change tables (CLAUDE.md 10.6)                                                                                                                        |
| tests/no-hover-effects.law.test.ts                                   | No hover-dependent UI                                                                                                                                            |
| tests/nothing-auto-closes.law.test.ts                                | Dialogs never auto-close                                                                                                                                         |
| tests/one-live-subscription-per-device.law.test.ts                   | One realtime subscription per device                                                                                                                             |
| tests/one-money-path.law.test.ts                                     | Single money path                                                                                                                                                |
| tests/payout-one-rule-everywhere.law.test.ts                         | One payout rule everywhere                                                                                                                                       |
| tests/promotion-assigns-the-rate.law.test.ts                         | Promotion assigns commission rate                                                                                                                                |
| tests/promotions-query-a-column-that-exists.law.test.ts              | Promotions query real columns                                                                                                                                    |
| tests/rit-full-boards.law.test.ts                                    | Run-it-twice deals full boards                                                                                                                                   |
| tests/seat-plates-stay-dark.law.test.ts                              | Seat plate theming                                                                                                                                               |
| tests/table-skin-must-not-paint-seats.law.test.ts                    | Table skins do not paint seats                                                                                                                                   |
| tests/table-skin-no-white-edging.law.test.ts                         | Table skins have no white edging                                                                                                                                 |
| tests/the-agents-books-tell-the-truth.law.test.ts                    | Every agent commission surface reads the ledger                                                                                                                  |
| tests/the-field-is-seated-before-the-clock.law.test.ts               | Tournament seating before clock start                                                                                                                            |
| tests/the-ladder-is-complete-and-people-are-told.law.test.ts         | VIP ladder completeness + notification                                                                                                                           |
| tests/the-last-wrong-account-path.law.test.ts                        | Account path correctness                                                                                                                                         |
| tests/law-registry.law.test.ts                                       | This registry itself                                                                                                                                             |
| tests/unit/allInShowsAndBustsClear.law.test.ts                       | All-in showdown and bust display                                                                                                                                 |
| tests/unit/heroCardsAreForThisHand.law.test.ts                       | Hero holdings shown only for this hand at this table                                                                                                             |
| tests/unit/heroCardsNeverCollideWithBoard.law.test.ts                | Hero card layout geometry                                                                                                                                        |
| tests/unit/noReentryFieldAndPremiumScroll.law.test.ts                | Re-entry field + premium scroll rules                                                                                                                            |
| tests/unit/snapshotNeverDropsASeat.law.test.ts                       | State snapshots keep every seat                                                                                                                                  |
| server/src/tournament/aStalledTournamentIsNoticed.law.test.ts        | A RUNNING tournament that stops dealing is repaired, not left for hours                                                                                          |
| server/src/tournament/seatFirstStartsOnSeatsNotClocks.law.test.ts    | A Spin or a duel starts on seats sold, never on a scheduled time                                                                                                 |
| server/src/tournament/headsUpIntegrityRulings.law.test.ts            | Dan's 2026-09-01 heads-up rulings: no RIT/insurance in tournaments, all-in hands survive a disconnect, no pause at two players, duel detection stays signal-only |
| tests/a-retry-never-tells-a-paid-player-they-did-nothing.law.test.ts | A retried write that comes back "already done" describes work that call committed; registration adopts it instead of telling a charged player they did nothing   |
