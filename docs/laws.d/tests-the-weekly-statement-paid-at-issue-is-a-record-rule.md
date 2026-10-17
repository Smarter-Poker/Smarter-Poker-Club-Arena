# tests/the-weekly-statement-paid-at-issue-is-a-record-rule.law.test.ts

Weekly accounting statements are issued as paid by trg_weekly_statement_issue_settled (installed unreviewed by 20261015180754); Dan's 2026-10-17 question was answered yes for that record and only that record, so 20261017104853 asserts the exact live trigger and function (BEFORE INSERT, club_weekly_accounting arriving as generated becomes paid, nothing else) and refuses if either has moved, and this law pins that the record changes no row and no behaviour.
