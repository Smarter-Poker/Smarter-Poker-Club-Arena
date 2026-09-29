# TournamentStuckCompleting

Runbook for `TournamentStuckCompleting` in
`infra/monitoring/tournament-rules.yml` (group `tournament-health`). Written
2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-stuck-completing`, which has
never served anything.

## What it means

```
poker_tournaments_stuck_completing > 0   for: 10m   severity: critical
```

A tournament has sat in COMPLETING for over ten minutes. Its prize pool is
undistributed until it leaves that state. The engine's terminal recovery should
finish a COMPLETING event within a pass; this firing means it refused to, and a
refusal is deliberate (a position collision, a field with no dealt-in
survivor, a receipt that disagrees) rather than a guess.

## What the expression measures

`fn_tournament_metrics(10, 10, 6)`: `stuck_completing` counts `tournaments`
with `status = 'COMPLETING'` and `updated_at < now() - 10 minutes`. Any write
to the row resets `updated_at`, so a row something keeps touching can hide
here; read the terminal evidence, not only the age.

## First checks

1. Which events, read-only:
   ```sql
   SELECT id, name, tournament_type, variant, prize_pool, updated_at,
          now() - updated_at AS stuck_for
   FROM tournaments WHERE status = 'COMPLETING' ORDER BY updated_at;
   ```
2. The field as the database has it:
   ```sql
   SELECT user_id, status, position, chips, eliminated_at
   FROM tournament_players WHERE tournament_id = '<id>'
   ORDER BY position NULLS FIRST, chips DESC;
   ```
   Two players at the same position, a `playing` player with chips, or a player
   with no position are the usual refusals.
3. What recovery said. `recoverStuckCompletingTournaments`
   (`server/src/tournament/tournamentRecovery.ts`) reports each refusal under a
   named key and raises a `financial_alerts` row:
   `docker logs --since 1h club-arena-engine 2>&1 | grep -E 'recoverStuckCompleting|<id>' | tail -40`,
   and
   ```sql
   SELECT created_at, severity, source, message, resolved, resolution
   FROM financial_alerts
   WHERE context::text LIKE '%<id>%' ORDER BY created_at DESC LIMIT 10;
   ```
   `terminal_receipt_disagreement` and `*_outcome_unknown` mean the database
   answered something the engine could not accept; the receipt function names
   why.
4. Is the finish refused by accounting? `TournamentFinishRefusalsPersisting`
   and `docs/runbooks/horse-fleet-settlement.md` cover the fee-reconciliation
   and prize-set refusals.

## Settling the damage

The finish goes through its one door: `fn_complete_tournament_terminal` (or
`fn_settle_satellite_tournament` for a satellite), which returns an immutable
receipt. When the evidence disagrees, prefer the witness that was there: the
order the live engine recorded eliminations, not a reconstruction from
timestamps (CLAUDE.md 10.9). Prove the outcome in one rolled-back `DO` block,
assert it in the migration, resolve the `financial_alerts` row with a note.

## What not to do

- Do not set `status = 'COMPLETED'` by hand; the
  `non_satellite_completed_requires_terminal_receipt` trigger refuses a
  completion without its receipt, and forcing one skips the payout.
- Do not write positions or wallet rows directly, and do not delete seats
  (CLAUDE.md 11.5 rule 3).
- Do not add a sweep that completes stuck events (10.12). Fix the reason the
  terminal door refused.

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts`, SQL `fn_tournament_metrics`.
- Recovery: `server/src/tournament/tournamentRecovery.ts`,
  `completingDwell.ts`, `recoveryFieldGuard.ts`.
- Terminal door: `server/src/tournament/terminalSettlementRpc.ts`
  (`fn_complete_tournament_terminal`, `fn_resolve_tournament_terminal_outcome`),
  `satelliteSettlementRpc.ts`.
