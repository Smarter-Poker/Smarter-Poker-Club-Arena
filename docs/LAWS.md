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

- **The tag versus a waiting human (resolved 2026-09-05, Dan):** the horse tag
  (variant, preferred stakes, rest day, daily cap) is ABSOLUTE. It used to yield
  to `humanNeedsRescue` in `HorseFleetManager`, and `StableHandSeatingWiring`
  pinned that bypass under the heading "A WAITING HUMAN OUTRANKS EVERY TEXTURE
  RULE". Dan reversed it: _"THERE ARE LIKE 4 HUMAN PLAYERS CURRENTLY... NOTHING
  REALLY MATTERS EXCEPT GETTING THIS RIGHT, SO WHEN HUMAN PLAYERS DO COME, THEY
  DON'T SLAUGHTER THE HORSES AND WIN ALL THE CHIPS!"_ The measurement behind it:
  of 327 live seats governed by a tag and taken after tagging, 124 (38%) sat at
  a forbidden big blind and 79 (24%) played a forbidden variant, with one horse
  on 6 tables against a tagged max of 4. `humanNeedsRescue` still sizes the fill
  and widens the candidate pool; it no longer decides whether a horse may be in
  the game. The law is `server/src/services/TheTagIsAbsolute.law.test.ts`.
  **Revisit only when the human count makes short tables expensive, and revisit
  it deliberately - not by reintroducing a bypass.**

- **Where union promo to a club lands (resolved 2026-09-05, Dan):** in the
  club's **PROMO WALLET** (`clubs.promo_balance`), not the Club Bank. The
  2026-09-03 promo model (`promo-is-disbursed-by-the-owner.law.test.ts`) had it
  land in `chip_treasury` "never a promo_balance" and refused a union club its
  own promo wallet. On 2026-09-05 Dan sent promo from the Midway Union to two
  clubs, opened each club's Promo Wallet, found 0.00, and reported the chips
  missing. Put to him as a choice between the two rules he chose the club
  Promo Wallet. So: `fn_union_promo_send(destination => 'club')` and
  `fn_promo_disburse(target => 'club')` both credit `clubs.promo_balance`; a
  club inside a union spends its own promo wallet through
  `fn_club_promo_wallet_send` (into a player wallet as cash, or an agent promo
  float); "promo chips are treated exactly like regular chips" holds at the
  point they reach a PLAYER. Every promo wallet carries a ledger
  (`fn_promo_wallet_ledger`). The union modal routes a club send by the wallet
  that is open: `union-promo-goes-to-the-promo-wallet.law.test.ts`.
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

**The registry is the directory `docs/laws.d/` - one file per law.** This
table used to live here, and every law appended to its last line, so any two
law-bearing pull requests conflicted with each other on this file. Measured
on 2026-09-04: one PR went merge-dirty FOUR times in an afternoon on nothing
but this table. That is the same failure `MIGRATION-CHANGELOG.md` had
(CLAUDE.md 10.9), fixed the same way: two files written independently cannot
conflict.

Each file is `docs/laws.d/<slug>.md` and reads:

    # tests/<the-law-test-file>.law.test.ts

    <one line: what it guards>

`tests/law-registry.law.test.ts` enforces both directions: a law test with
no file here fails CI with the exact file to create; a file here whose test
no longer exists is a ghost and fails CI too. Rules 1-4 above are unchanged;
"its row here" now means "its file in `docs/laws.d/`".

To read the whole registry as one table:

    node scripts/laws-registry.mjs
