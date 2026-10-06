# tests/an-unset-budget-is-not-a-number.law.test.ts

CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must have
its own name, never folded into a plausible-looking value.

fn_ca_diamond_earn_ledger created an engine's diamond_reward_budgets line for
a new period by carrying the previous period's line forward and, when there
was none, falling back to a hard-coded two and a half million Diamonds. Under
ruling 21 that total refuses no player, but fn_ca_diamond_budget_reality then
measured real issuance against it and printed a ratio, so a plan nobody had
approved read afterwards as an approved plan. Diamond destinations design,
section 6, item 8.

The law pins the migration that closed it
(the_diamond_books_do_not_invent_a_number) and, more importantly, pins that it
sets no number. Only the invented fallback went: the carry-forward stays,
because a month with no new instruction continuing the last plan somebody set
is a real decision the code already makes. With no earlier line at all the
column is left NULL, which this schema already calls unset (the column is
nullable and its CHECK is named ca_budget_is_a_number_or_nothing), and
fn_ca_diamond_budget_reality already reports that as "NO PLAN SET. Refuses
nobody either way (ruling 21); this is simply unstated." The migration refuses
to land if the live body still carries the literal, and it neither writes nor
rewrites a budget line: the 2.5 million lines already recorded are section 6
item 7, Dan's to set, and 10.9 forbids rewriting a recorded line to make a
number look tidy.
