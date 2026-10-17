# The Weekly Statement Paid-At-Issue Rule Is A Reviewed Record Rule

**Date:** 2026-10-17
**Migration:** `20261017104853_the_weekly_statement_paid_at_issue_is_a_record_rule.sql`
**Law:** `tests/the-weekly-statement-paid-at-issue-is-a-record-rule.law.test.ts`

Dan asked whether "paid at issue" is the right rule for weekly statements. Production was read first: the trigger `trg_weekly_statement_issue_settled` (installed with no reviewed source by `20261015180754`) fires BEFORE INSERT and only turns a `club_weekly_accounting` row arriving as `generated` into `paid`. It never updates a row and cannot reach any other invoice type. Every real receivable or payable on production (agent to player, agent to subagent, club to agent, transaction receipts, union to club, union club P&L) is paid with its chip transfer attached; the 7 weekly statements have no transfer because they are records of a closed week, never collected.

Decision: the rule stays. A record nobody owes should not sit in any overdue, reminder or collection path that reads `generated` as an open bill. The new migration changes no row and no behaviour: it asserts the live trigger and function are exactly the measured definition (refusing if either moved) and writes the rule's scope into the database catalog, so the rule is reviewed and cannot widen silently.
