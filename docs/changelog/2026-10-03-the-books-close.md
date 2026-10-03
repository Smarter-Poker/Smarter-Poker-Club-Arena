# The books close (2026-10-03)

Phase 4 of 9. Migration `20261003024413_the_books_close`; the tournament-book fix in section 1 is part two.

Every item below was read from production on 2026-10-03, and each is fixed at the line that caused it. No chips moved, nothing was backfilled, and no job was added (CLAUDE.md 10.11, 10.12).

## 1. A tournament's book read as open when it was closed

`fn_tournament_money_conservation` had 22 open alerts: 20 "retained money it never paid out" (+20.00 to +2,850.00) and 2 "paid out money it never collected" (-180.00 each). None of them was about the money; each came from `fn_tournament_conservation_delta`. That function and its batch twin in `fn_pay_backed_payout_shortfalls` are qualified together on native PG17, so the fix ships in its own migration with that qualification (phase 4, part two).

## 2. A week closed every period but one

Midway Union's week of 2026-09-21 to 2026-09-28 completed at 23:51 on 2026-10-01. Its periods for Club JAQK, SHARK CLUB and the union settled and closed. The period for the union's own club row (`clubs.id` equals the union id) stayed `processing`.

- `fn_union_issue_weekly_invoices` opens a period for every club it squares up, including the union's own row.
- `fn_mark_scope_accounting_settled` only settles the clubs in `fn_accounting_week_clubs`, and that list leaves the union's own row out.

So that period could never close, and every week would have left one more open. The settler now settles every period the week opened for the union. The migration then calls the settler once for the week that ran under the old code. That is the platform's own idempotent close path.

## 3. A payment reminder could not reach a statement

From 2026-09-20 to 2026-10-02, `fn_union_age_invoices` failed for Midway Union with `accounting_conversation_audience_is_immutable`. Overdue statements were not marked overdue and nobody was chased.

The reminder went through `fn_union_send_club_message`. That function finds the old "Midway Union Statements" group by name and adds the club's admins to it. Statements are now delivered in private accounting conversations, and those two groups had been converted into accounting conversations. The accounting conversation's audience guard correctly refuses a new member. The rolled-back probe reproduced the refusal on SHARK CLUB.

`fn_union_remind_statement` now posts the reminder into every conversation the statement was delivered to, as the sender who delivered it, and adds nobody to any conversation. If a statement was never delivered, it is delivered first. In the probe, this worked for the delivered statements of both clubs and for the August SHARK CLUB statement that had never been delivered (two private conversations). The failure was only dormant because the four house statements were waived to 0.00 on 2026-10-02.

## 4. The union law paged about a retired recorder

At 00:20 on 2026-10-03, `fn_union_law_selftest` raised a critical alert with one breach: `record_rake_delegation_missing`.

- `20261002140203` retired `record_rake`. It now records nothing and returns `record_rake_retired`.
- The law is that rake is never recorded around `atomic_distribute_rake`.

A `record_rake` that only refuses keeps that law. One that writes without delegating still breaks it, and the check still catches that case. The old check tested where the code lived rather than the law itself, the same mistake `20260909012510` fixed. The probe's self-test reads zero breaches.

## Records

- The two open union-law alerts and the six ageing alerts are resolved, each with its cause named. This was done right after the apply, in its own statement, not in the migration. With those two UPDATEs inside it, the Supabase MCP held the migration for a confirmation nobody was there to give. Each attempt timed out at 180 s without reaching the database; I confirmed each time that nothing had applied. Every part of the file passed on its own.
- Every edited function is pinned to the md5 read on 2026-10-03. Each edit replaces exactly one stale block and refuses to run if the block is missing or the replacement does not take.

## Proof

- **Production probe.** A single MCP call ending in `RAISE`, so nothing committed. It rebuilt every edited function in `pg_temp` from the live text using the migration's own replacements. Results:
  - the self-test reads no breaches;
  - the stuck period settles, and the union has no open period left;
  - both alert sets resolve, 2 and 6;
  - the old reminder refuses SHARK CLUB, and the new reminder delivers to both clubs' delivered statements and to SHARK CLUB's August statement, which had never been delivered (two private conversations).
- **Law test.** `tests/the-books-close.law.test.ts`.

## Live

Applied as schema_migrations `20261003033117 the_books_close`.

- The `@live-proof` reads true.
- Midway Union has no open or processing period.
- `fn_union_age_invoices` no longer names `fn_union_send_club_message`.
- `fn_union_remind_statement` is executable by the service role only.
- Neither `authenticated` nor `anon` gained anything.

## Left for later phases

- **Trial balance watch.** `fn_ca_trial_balance_watch` windows ledger legs by `created_at` (the transaction start). A leg that commits after a supply snapshot lands one window early, so hourly differences come in matching +x/-x pairs. Over 10 days they net to a few hundred chips against gross movement in the millions. That is the same mechanism `20261002164500` fixed in the supply meter. The fix needs the snapshot to record its `pg_snapshot`, and it is tracked for phase 5 (alerts reach a person).
- **The union-law self-test does not finish.** Its warnings half sums `agent_commissions` and `rake_records` since a date (`fn_union_distribution_check`). It timed out under the 600 s cron budget on 2 of the last 3 nights, and under a 120 s probe today, so on those nights neither its breaches nor its warnings reach anyone. This is phase 5 work (alerts reach a person).
- **cron "job startup timeout".** `ca-payout-guarantee-check-hourly` failed with this 56 times in 3 days. That is availability work, phase 7.
