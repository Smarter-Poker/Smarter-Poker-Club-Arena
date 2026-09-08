# Two landmines under the 2026-09-14 rule flip

2026-09-08. `supabase/migrations/20260908041432_the_verification_pass_fixes_what_read_as_armed.sql`.

Nine diamond rules are scheduled to change from `log` to `refuse` on 2026-09-14
and 2026-09-22. A verification pass over what those flips would actually do
found two things that read as armed and were not, and would have failed on the
day rather than in a test.

## 1. The cap collision

`fn_ca_diamond_earn_ledger` refuses a promotional issuance when the rule mode is
`refuse`. Two different daily caps could apply to the same movement, and the
lookup took whichever row the planner returned first - so on the flip day the
refusal would have been decided by an arbitrary one of two numbers. Made
deterministic: the binding cap is the smallest that applies, and the refusal
message names which one fired.

## 2. The unclassified line

`fn_ca_diamond_journal_origin` returned NULL for a movement shape that had begun
appearing in the journal. A NULL origin means the register does not follow the
row at all, so the movement would have been invisible to the supply identity -
and on the flip day, invisible to the rule that was supposed to refuse it. The
shape is classified now, and the migration asserts that no journal row in the
live table classifies to NULL.

## Why this is written down

Both were found by asking what the flip would do, not by a test failing. A rule
in `log` mode exercises none of its refusal path, so every flip is a first run
in production unless somebody deliberately reads the path first. That reading is
the work; this file is the record that it happened.
