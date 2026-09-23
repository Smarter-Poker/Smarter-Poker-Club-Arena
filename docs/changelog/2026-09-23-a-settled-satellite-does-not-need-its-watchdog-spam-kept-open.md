# A settled satellite does not need its watchdog spam kept open

Production Alerts board: `operational_alert_events` id=8, `MoneyAlertsGoingUnread`.

PR #5145 (CLASS 5) and PR #5146 (CLASS 6) extended
`fn_resolve_settled_financial_alerts` to close the two
`Tournament.atomic_*_finish_refused`/`outcome_unknown` families once the
named winner was proven paid. Both deliberately left
`Satellite.stuck_completing_unawarded` open, describing it only as "a
different failure shape". This closes that source: CLASS 7.

## Root cause

All 533 unresolved rows for `Satellite.stuck_completing_unawarded` name only
9 distinct `tournament_id` values, every row dated 2026-09-08 03:54:01
through 2026-09-08 14:53:20 UTC. The discovery-watchdog that raises this
alert re-fired on the same 9 stuck satellites roughly once a minute for
eleven hours before its own underlying cause was fixed — one tournament
(`a6a1b360-821c-4201-b378-1591e3df3892`) alone produced 106 duplicate rows,
all carrying the identical `prize_pool 28.5 / alive_count 0 /
satellite_target_id null` payload.

All 9 named tournaments were in fact settled on 2026-09-09. A sibling
`financial_alerts` row of this exact source
(`fe00d1ee-8b13-4a7d-a2bc-68aa56abebec`, tournament `a6a1b360`) already
carries `resolved=true` / `resolved_at 2026-09-09T06:38:07Z`, with a
resolution note naming a batch of 22 satellites settled via migration
`a_finished_satellite_must_be_able_to_settle`: "all 22 satellites are
COMPLETED with escrow 0.00 and 1,919.00 paid to their winners... the rest
were paid the cash value" — and explicitly correcting this alert's own
context fields as wrong at the time it fired ("it reported alive_count 0 and
satellite_target_id null, and both were wrong").

Verified independently, live, against the *current* state of all 9
tournaments named by the 533 unresolved rows (not against that older
resolution note): every one reads `tournaments.status = 'COMPLETED'`,
`tournament_escrow.closed_at` set (2026-09-09 06:12–06:14 UTC),
`prize_balance = 0.00`, `prize_out > 0` (28.50 or 285.00 — 95% of
`gross_in`), and 0 rows in `tournament_satellite_awards` for any of the 9
(consistent with the "paid the cash value" branch, not a real seat
delivery). The true, un-duplicated defect this alert reported was fixed
twelve days before this migration; what remained was bookkeeping spam left
behind because the 2026-09-09 settlement resolved the underlying
tournaments, not each duplicate alert row the watchdog had already written
about them.

No new duplication is occurring: the newest row of any status for this
source predates 2026-09-09, so the watchdog is not currently reproducing
this pattern. This migration only closes the backlog its old firing left
behind.

## The fix

CLASS 7 in `fn_resolve_settled_financial_alerts`: a
`Satellite.stuck_completing_unawarded` alert resolves once its named
tournament's own `tournament_escrow` row proves the pool was fully disbursed
— `closed_at IS NOT NULL`, `prize_balance = 0`, and
`prize_out + refund_prize > 0` (money actually moved, not merely a balance
that happened to already be zero). Proof is read fresh from `tournament_escrow`
on every run of the resolver, not cached or assumed from this migration's own
investigation, so it stays correct if escrow state ever changes. Restates
CLASS 1–6 verbatim from `20260923195015` (PR #5146) so this migration is
correct and self-sufficient regardless of merge order.

## Hardening (CLAUDE.md 10.11/10.12)

- **Root cause fixed**: the missing class in the resolver, not a new sweep,
  cron, or compensating write. No money moves — it was already settled on
  2026-09-09.
- **Damage settled**: through the resolver's own existing idempotent path, on
  its existing 20-minute cron (`ca-resolve-settled-alerts-20m`).
- **Regression test**: `server/src/tournament/ASettledSatelliteDoesNotNeedItsWatchdogSpamKeptOpen.guard.test.ts`.
- **Detection**: none needed — `MoneyAlertsGoingUnread` already measures the
  backlog this closes 533 rows of.

## Verification

Probed in a rolled-back transaction (CLAUDE.md 11.5) against production
before opening the PR: `CREATE OR REPLACE FUNCTION` plus a dry run
(`p_apply=false`) asserting `stuck_completing_settled` equals the live count
of unresolved rows for this source, ending in a deliberate `RAISE EXCEPTION`
so nothing committed. All 36 hand-verified regex/string assertions in the
guard test pass against the migration file (no `node_modules` in this
sandbox to run `vitest` directly). CI's own PostgreSQL 17 rehearsal is the
authoritative check.

---

Production Alerts Fleet — PRIMARY lane. Board: Smarter-Poker/Smarter-Poker-Club-Arena#5070.
