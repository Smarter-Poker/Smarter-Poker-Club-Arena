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
