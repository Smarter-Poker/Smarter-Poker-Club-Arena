# tests/a-house-credit-is-registered.law.test.ts

Rule R2 of the Diamond destinations design (section 3.1): a Diamond crossing
the line between a player and the house is a registered PAIR in one
transaction, the payer's spend journal row plus a house `mint` row in
ca_mint_ledger. Nothing crosses with one row, and nothing crosses through
ca_diamond_house_ledger, which the register does not see.

enter_trivia_tournament_v2 crossed it with one row. It retired the player's
whole entry fee through the journal, credited the 10 percent cut to
ca_diamond_house, wrote a ca_diamond_house_ledger row, and wrote no mint row,
so the house held Diamonds the register had never issued and
fn_ca_diamond_register_vs_supply() read a difference equal to the cut. That
difference being 0 is the assertion every Diamond migration ends on, so the
next Diamond migration to run after a paid trivia entry would have refused
itself. Measured on production on 2026-10-04 in a rolled-back transaction: a
50 Diamond entry moved the difference from 0.00 to 5.00. Nothing had been lost
yet, because no trivia entry had been made since 2026-02-12.

The law pins the migration that closed it
(the_diamond_books_do_not_invent_a_number): the live door edited in place with
its md5 pinned and the reverse substitution proved, the house `mint` row with
the house's own holder id and its DR14 reason, the house ledger row kept
beside it because the pair is both rows, the register key taken from the house
ledger's own idempotency reference so a replay cannot issue the cut twice, and
the identity asserted at 0 on the way out. The door stays a service_role door,
branches on nothing about horses (10.5), and the migration adds no cron, sweep
or backfill (10.12).
