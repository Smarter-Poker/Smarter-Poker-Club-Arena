# TournamentCompletedUnpaid

Runbook for `TournamentCompletedUnpaid` in
`infra/monitoring/tournament-rules.yml` (group `tournament-health`). Written
2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-unpaid`, which has never
served anything.

## What it means

```
poker_tournaments_unpaid_completed > 0   for: 15m   severity: critical
```

A tournament finished in the last six hours with a non-zero prize pool and
nothing of value was delivered against it: no cash prize on the wallet ledger
and no satellite award. Players bought in and nobody was paid.

## What the expression measures

`fn_tournament_metrics(10, 10, 6)`: `unpaid_completed` counts `tournaments`
with `status = 'COMPLETED'`, `ended_at` in the last 6 hours,
`coalesce(prize_pool, 0) > 0`, no `wallet_transactions` row with
`related_entity_id` = the tournament and `category = 'prize'`, and no
`tournament_satellite_awards` row for it. A satellite pays in a seat or a
ticket rather than chips, and both count as payment, so a satellite in this
number is one that failed to settle, not one that paid in kind (the rule was
widened on 2026-09-12 after twelve false firings, all satellites).

A COMPLETED non-satellite tournament requires its terminal receipt (trigger
`non_satellite_completed_requires_terminal_receipt`), issued by the terminal
door `fn_complete_tournament_terminal`. So a firing means one of three things:
the receipt was issued with no prize credit behind it, a path reached
COMPLETED some other way, or the prize was written somewhere this query does
not read (a different `category`, a missing `related_entity_id`). Step 3 below
tells the third apart from the first two.

## First checks

1. Which events, read-only:
   ```sql
   SELECT t.id, t.name, t.tournament_type, t.variant, t.prize_pool, t.ended_at,
          t.satellite_target_id
   FROM tournaments t
   WHERE t.status = 'COMPLETED' AND t.ended_at > now() - interval '6 hours'
     AND coalesce(t.prize_pool, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.category = 'prize')
     AND NOT EXISTS (SELECT 1 FROM tournament_satellite_awards a WHERE a.tournament_id = t.id);
   ```
2. The field and what each place was owed:
   ```sql
   SELECT user_id, position, prize, status, eliminated_at
   FROM tournament_players WHERE tournament_id = '<id>' ORDER BY position NULLS LAST;
   ```
3. Every wallet movement tied to the event, whatever its category, in case the
   prize was written under a different category:
   ```sql
   SELECT user_id, type, category, amount, description, created_at
   FROM wallet_transactions WHERE related_entity_id = '<id>' ORDER BY created_at;
   ```
4. How it reached COMPLETED: the engine log for the id
   (`docker logs --since 6h club-arena-engine 2>&1 | grep <id>`), and any
   `financial_alerts` whose `context` names it.
5. Database-side detection that runs on its own schedule: pg_cron
   `tourney_payout_sweep_detect_daily` and `tourney_money_conservation_hourly`.
   Those are detectors; they do not pay.

## Settling the damage

CLAUDE.md 10.9 gives the agent the decision. The outcome is read from rows
(steps 2 and 3), the credit goes through the platform's idempotent path
(`fn_tournament_payout_reconcile`, `fn_credit_and_log`, the per-user prize
keys) so nobody is paid twice, the numbers are proved in one rolled-back `DO`
block and asserted in the migration, and the `financial_alerts` row is resolved
with a note. Prefer the finishing order the live engine recorded over one
reconstructed from timestamps.

## What not to do

- Do not hand-write wallet rows or update `club_members.chip_balance`.
- Do not revert the tournament out of COMPLETED; settled records are corrected
  forward through the traceable path, never rewritten.
- Do not add a payout sweep as the fix (10.12). Find the path that completed
  the event without paying and change that line.

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts`, SQL `fn_tournament_metrics`.
- Terminal door: `server/src/tournament/terminalSettlementRpc.ts`
  (`fn_complete_tournament_terminal`), `satelliteSettlementRpc.ts`
  (`fn_settle_satellite_tournament`).
- Reconcile path: `fn_tournament_payout_reconcile`.
