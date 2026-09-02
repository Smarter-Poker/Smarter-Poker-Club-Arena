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
- **Unpaid hands (resolved 2026-09-01, Dan, PR #2554):** Dan's rule is
  "MUCKED HANDS SHOULDN'T BE RECORDED AND TRACKED, ONLY HANDS WHERE THE HERO
  PUTS CHIPS IN POT." Applied to `ca_hand_facts`, which stored `hole_cards` on
  every dealt hand including hands folded for free (640 of 2,265 rows, 28%).
  **The exact holding is gone** and is stripped at the database by
  `trg_ca_hand_facts_strip_unpaid_holding`. **The 169-bucket `hand_class` label
  STAYS, and Dan chose this explicitly when the question was put to him.**
  Do not "finish the job" by stripping it too: it is not decoration, it is the
  DENOMINATOR of two things. `fn_nit_check` judges NIT Game eviction on
  `avg(vpip)` across every row a player has, and `ca_player_hand_grid`'s default
  view is `hands_vpip / hands` per class. Remove the label and the chart reads
  100% everywhere while nit eviction quietly stops evicting - a rule that fails
  OPEN, which nobody notices. The law is
  `noCardsForHandsNobodyPaidInto.law.test.ts`.
- **Horses are players (2026-08-27):** no `is_horse` exclusion anywhere except
  identification and the horse's input device. See CLAUDE.md 10.5.

## Registry

| Law test file                                                       | Guards                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/a-control-that-says-none-must-mean-none.law.test.ts           | UI controls labeled "none" disable the feature entirely                                                                                                                                                       |
| tests/a-credit-line-is-spendable.law.test.ts                        | Club credit lines can actually be spent                                                                                                                                                                       |
| tests/a-demotion-closes-the-books.law.test.ts                       | Agent demotion settles outstanding balances                                                                                                                                                                   |
| tests/a-promotion-does-not-end-at-the-role.law.test.ts              | Promotion applies downstream effects, not just the role                                                                                                                                                       |
| tests/a-seat-that-waits-forever-gets-its-chips-back.law.test.ts     | Stranded seats refund                                                                                                                                                                                         |
| tests/a-unit-suffix-is-not-a-word.law.test.ts                       | Number formatting of unit suffixes                                                                                                                                                                            |
| tests/action-bar-never-leaves.law.test.ts                           | The action bar stays mounted                                                                                                                                                                                  |
| tests/an-agent-can-finally-be-paid.law.test.ts                      | Agent commission payout path                                                                                                                                                                                  |
| tests/a-claim-cannot-destroy-chips.law.test.ts                      | A commission claim locks the membership row, asserts the credit landed, and reports money nobody can reach                                                                                                    |
| tests/an-agents-book-is-not-public-reading.law.test.ts              | Only self, club admin+, an agent ancestor or the service role may read what a club owes a member                                                                                                              |
| tests/an-invoice-bills-what-was-borrowed.law.test.ts                | Invoices bill actual borrowings                                                                                                                                                                               |
| tests/animations-always-play.law.test.ts                            | Animations always play (CLAUDE.md 10.6)                                                                                                                                                                       |
| tests/approvedHamburgerGearGuard.law.test.ts                        | Hamburger menu artwork stays (see resolved conflicts)                                                                                                                                                         |
| tests/config/weightedContributedRake.law.test.ts                    | Weighted-contributed rake schedule                                                                                                                                                                            |
| tests/footer-stays-on-the-footer.law.test.ts                        | Footer placement                                                                                                                                                                                              |
| tests/hero-avatar-opens-hero-hub.law.test.ts                        | Hero avatar navigation                                                                                                                                                                                        |
| tests/loose-sql-is-not-live-ammunition.law.test.ts                  | Loose SQL in supabase/ outside migrations/ carries no DDL and names no dropped object                                                                                                                         |
| tests/no-invented-money-on-an-agent-screen.law.test.ts              | Agent and club money screens show measured figures only                                                                                                                                                       |
| tests/no-auto-table-switch.law.test.ts                              | Never auto-change tables (CLAUDE.md 10.6)                                                                                                                                                                     |
| tests/no-hover-effects.law.test.ts                                  | No hover-dependent UI                                                                                                                                                                                         |
| tests/nothing-auto-closes.law.test.ts                               | Dialogs never auto-close                                                                                                                                                                                      |
| tests/one-live-subscription-per-device.law.test.ts                  | One realtime subscription per device                                                                                                                                                                          |
| tests/one-money-path.law.test.ts                                    | Single money path                                                                                                                                                                                             |
| tests/payout-one-rule-everywhere.law.test.ts                        | One payout rule everywhere                                                                                                                                                                                    |
| tests/promotion-assigns-the-rate.law.test.ts                        | Promotion assigns commission rate                                                                                                                                                                             |
| tests/promotions-query-a-column-that-exists.law.test.ts             | Promotions query real columns                                                                                                                                                                                 |
| tests/rit-full-boards.law.test.ts                                   | Run-it-twice deals full boards                                                                                                                                                                                |
| tests/seat-plates-stay-dark.law.test.ts                             | Seat plate theming                                                                                                                                                                                            |
| tests/table-skin-must-not-paint-seats.law.test.ts                   | Table skins do not paint seats                                                                                                                                                                                |
| tests/table-skin-no-white-edging.law.test.ts                        | Table skins have no white edging                                                                                                                                                                              |
| tests/the-agents-books-tell-the-truth.law.test.ts                   | Every agent commission surface reads the ledger                                                                                                                                                               |
| tests/the-field-is-seated-before-the-clock.law.test.ts              | Tournament seating before clock start                                                                                                                                                                         |
| tests/the-ladder-is-complete-and-people-are-told.law.test.ts        | VIP ladder completeness + notification                                                                                                                                                                        |
| tests/the-last-wrong-account-path.law.test.ts                       | Account path correctness                                                                                                                                                                                      |
| tests/one-page-per-finding.law.test.ts                              | One drift finding pages once; no clock in a notify key                                                                                                                                                        |
| tests/law-registry.law.test.ts                                      | This registry itself                                                                                                                                                                                          |
| tests/unit/allInShowsAndBustsClear.law.test.ts                      | All-in showdown and bust display                                                                                                                                                                              |
| tests/unit/heroCardsAreForThisHand.law.test.ts                      | Hero holdings shown only for this hand at this table                                                                                                                                                          |
| tests/unit/noCardsForHandsNobodyPaidInto.law.test.ts                | A hand nobody put chips into is not recorded (Dan 2026-09-01)                                                                                                                                                 |
| tests/unit/heroCardsNeverCollideWithBoard.law.test.ts               | Hero card layout geometry                                                                                                                                                                                     |
| tests/unit/noReentryFieldAndPremiumScroll.law.test.ts               | Re-entry field + premium scroll rules                                                                                                                                                                         |
| tests/unit/realtimeFirehoseIsDebounced.law.test.ts                  | A realtime subscription on a per-hand table must debounce, never reload once per row                                                                                                                          |
| tests/unit/snapshotNeverDropsASeat.law.test.ts                      | State snapshots keep every seat                                                                                                                                                                               |
| server/src/tournament/aStalledTournamentIsNoticed.law.test.ts       | A RUNNING tournament that stops dealing is repaired, not left for hours                                                                                                                                       |
| server/src/tournament/seatFirstStartsOnSeatsNotClocks.law.test.ts   | A Spin or a duel starts on seats sold, never on a scheduled time                                                                                                                                              |
| server/src/tournament/headsUpIntegrityRulings.law.test.ts           | Dan's 2026-09-01 heads-up rulings: no RIT/insurance in tournaments, all-in hands survive a disconnect, no pause at two players, duel detection stays signal-only                                              |
| server/src/tournament/eliminationSweepReadsAreIndexed.law.test.ts   | The bust sweep reads through indexes and pages on a unique key, never scanning every live seat                                                                                                                |
| server/src/services/aScheduleCannotCreateASeatFirstGame.law.test.ts | A schedule cannot spawn or restart a Spin or a heads-up on a clock, and a Spin that never touched the reserve pool is counted                                                                                 |
| server/src/services/theSpinTreasuryAndTheStack.law.test.ts          | The Spin treasury is funded by the seat that fills the board, and the stack belongs to the board rather than the multiplier                                                                                   |
| server/src/services/anInlinableFunctionStaysInlinable.law.test.ts   | A per-row predicate stays foldable into its caller: no SET clause on fn_club_home_in_scope, which cost 28% of database time                                                                                   |
| server/src/services/theFloorIsFull.law.test.ts                      | Dan's 2026-09-02 occupancy rule: 75% of cash tables sit full, the other 25% run one seat to full, a horse gets up only for a human on the waiting list, and four tables is the target rather than the ceiling |
