# The Diamond books do not invent a number (2026-10-04)

Two of the eight defects in `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md`
section 6, "What Is Already Wrong Today": item 4 and item 8. Both were re-read
on production on 2026-10-04 and both were still live. Neither needed an
economics decision and neither got one. A third, item 3, was already fixed and
is recorded at the end.

Migration: `20261004211453_the_diamond_books_do_not_invent_a_number.sql`.
Laws: `tests/a-house-credit-is-registered.law.test.ts`,
`tests/an-unset-budget-is-not-a-number.law.test.ts`.

## Item 4: a paid trivia entry broke the Diamond identity

`enter_trivia_tournament_v2` (md5 `e636c45d5552ce1484e602bbb5d07917`,
unchanged since the design was written) retires the player's whole entry fee
through the diamond journal, which the register follows, so the fee is burned
from that player. It credits the 10 percent cut to `ca_diamond_house` and
writes a `ca_diamond_house_ledger` row. It wrote **no house `mint` row** to
`ca_mint_ledger`, and the register does not see `ca_diamond_house_ledger`, so
the house ended up holding Diamonds the register had never issued.

Measured, in a transaction that ended in `RAISE EXCEPTION` and rolled back
(11.5 rule 1, one call, one self-aborting `DO` block): on a 50 Diamond entry
the prize pool took 45, the house took 5, one house ledger row was written, no
`ca_mint_ledger` row was written, and
`fn_ca_diamond_register_vs_supply().difference` moved from `0.00` to `5.00` -
exactly the cut. That difference being 0 is the assertion every Diamond
migration ends on, so **the next Diamond migration to run after a paid trivia
entry would have refused itself.**

Nothing was lost and nothing needed settling. No trivia entry has been made
since 2026-02-12 (208 entries, the last at 15:54:35 UTC),
`ca_diamond_house_ledger` holds no `trivia_tournament_entry_cut` row at all,
the house balance is 0 and the identity difference is 0.

The fix is rule R2 of the design, section 3.1: crossing the line between a
player and the house is a registered pair in one transaction - the payer's
spend journal row, which retires it from the player, and a house `mint` row,
which issues it to the house. The shape is copied from
`fn_poker_diamond_tournament_settle_fee`, the estate's other Diamond house
credit, which writes exactly one `mint` row for the house reasoned
`DR14 (poker_tournament_fee)`. The register key is the house ledger row's own
idempotency reference and `ca_mint_ledger.op_id` is UNIQUE, so a replay cannot
issue the cut twice; the duplicate-entry check at the top of the door already
made one unreachable, and a replay in the rehearsal returned
`already_entered`.

Through the fixed door - built in `pg_temp` and run against the same fixture,
because section 2 rule 3 forbids a `CREATE OR REPLACE FUNCTION` probe in
`public` - the difference stayed `0.00`, one `mint` row was written, and the
house ledger row was unchanged.

**Which repository owns the caller.** Not this one. The door is reached from
the World Hub, `pages/api/trivia/tournament-enter.js` line 35, repo
`Smarter-Poker/Smarter-Poker-World-Hub`; Club Arena's `src/` and `server/`
trees have no caller. The function, though, is Club Arena's: its body was
written by this repo's
`20260903002841_diamond_e_every_earn_engine_has_a_budget_line` (DR14, "the
entry fee cut is banked, not burned"), and the register, the house account and
the identity assertion all live here. World Hub's
`20260906120000_trivia_pvp_containment` only re-checks the signature and
re-grants EXECUTE to `service_role`. So the fix belongs here, the door keeps
its signature, its `service_role`-only grant and its `search_path`, and the
World Hub needs no change and no redeploy.

## Item 8: the earn ledger wrote a budget nobody set

`fn_ca_diamond_earn_ledger` created an engine's `diamond_reward_budgets` line
for a new period as `COALESCE(<previous period's line>, <a literal>)`, so an
engine that had never had a line got one of two and a half million Diamonds,
written by a trigger and approved by nobody. Under ruling 21 the engine total
refuses no player, but `fn_ca_diamond_budget_reality` then compared real
issuance against it and printed a ratio - 10.86 rule 1 exactly, "I could not
tell" folded into a plausible-looking value.

**The fix sets no number.** Only the invented fallback went. The carry-forward
is a real decision the code already makes and it is sound - a month with no
new instruction continues the last plan somebody set - so it stays. With no
earlier line at all the column is left NULL, which is what this schema already
calls unset: `budget_diamonds` is nullable and its own CHECK is named
`ca_budget_is_a_number_or_nothing` (`budget_diamonds IS NULL OR (>= 0 AND <=
1000000000)`).

The health function needed no change, which was worth checking rather than
assuming. `fn_ca_diamond_budget_reality` already reads an unset plan
correctly: verified on production, and in the rehearsal a line created for an
engine that had never had one came out with `budget_diamonds` NULL, a NULL
ratio, and the verdict "NO PLAN SET. Refuses nobody either way (ruling 21);
this is simply unstated." Nothing else breaks on a NULL:
`fn_ca_diamond_engine_spent` reads `spent_diamonds` (NOT NULL DEFAULT 0) and
`fn_ca_diamond_trial_balance` uses the budget as neither divisor nor sum.

The two-and-a-half-million lines already on the table
(`daily_mission_milestones` for 2026-09 and 2026-10, `signup` for 2026-05,
2026-07 and 2026-08) are **not** touched. They are section 6 item 7, "three
reward budget lines are fiction ... they refuse nobody and are Dan's to set",
and rewriting a recorded line to make a number look tidy is what 10.9 forbids.
This stops the next one being invented.

## Item 3 was already fixed

Section 6 item 3, the Diamond creation door dropping `guaranteedPrize`,
`isRebuy`, `isReentry`, `addOnAvailable`, `addOnCost` and `addOnFromStart`
silently, was closed on 2026-09-29 by
`20260929160000_the_chip_legs_refuse_a_diamond_row` (section 3 of that file).
The live `fn_poker_diamond_create_tournament` now raises
`diamond_tournament_money_key_not_read` naming the offending keys, admits each
key's default (`0`, `false`, `null`), still refuses `guarantee` with
`diamond_tournament_format_not_open` (Phase 9 line (a) waits on Dan), and
still reads its own `rebuy`, `reentry`, `addOn` and `addonCost`. The migration
is recorded as applied and
`tests/the-chip-legs-refuse-a-diamond-row.law.test.ts` pins all six keys, the
refusal name and the defaults admission. No work was manufactured for it.

## How both edits were made

In place on the live definition, with the live md5 pinned before the
substitution, the single occurrence of the replaced anchor proved by arithmetic,
and the reverse substitution proved afterwards - so every other line of both
functions is provably unchanged. Neither function is on
`fn_ca_guard_watchlist()` (checked), so no guard redefinition is declared. One
migration, one transaction, one PostgREST reload (section 2 rule 1). No cron,
sweep, backfill, reconciler or compensating write anywhere in it (10.12), and
nothing priced.
