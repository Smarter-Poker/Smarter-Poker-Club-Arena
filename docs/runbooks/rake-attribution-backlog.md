# RakeAttributionBacklog

Runbook for `RakeAttributionBacklog` in `infra/monitoring/spin-rules.yml`
(group `spin-money`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/rake-attribution-backlog`, which has
never served anything.

## What it means

```
poker_rake_attribution_gaps > 100   for: 30m   severity: warning
```

Over a hundred settled tournament fees have been banked and credited nobody:
no VIP points, no rakeback basis, no agent or super-agent commission for the
players in those events. Horses earn exactly as humans do (CLAUDE.md 10.5), so
horse-only events count here too.

## What the expression measures

`fn_spin_metrics` counts every row of the view
`v_tournament_rake_attribution_gaps`: rows of `tournament_rake_settlements`
with `settled_at` set, `amount > 0`, and `attributed_users` NULL
(`never_measured`), -1 (`attribution_threw`) or 0 (`credited_nobody`). Despite
the rule living in `spin-rules.yml`, it covers every tournament format, not
only Spins. Measured 2026-09-26 06:45 UTC: 0.

**Until 2026-09-26 this alert's description named an engine loop running
`fn_repair_tournament_rake_attribution` and
`fn_backpay_tournament_rake_attribution`. That loop is gone.** No engine code calls
either any more, and both are now read-only functions that only count and name
`fn_process_weekly_accounting` as the authority. Attribution happens on the
live settlement path: `fn_settle_tournament_rake` and
`fn_attribute_tournament_rake`, with recognition through
`fn_recognize_accounting_tournament_fees` from
`accounting_tournament_fee_sources`.

## First checks

1. The backlog by verdict and age, read-only:
   ```sql
   SELECT verdict, count(*), min(settled_at), max(settled_at), sum(amount)
   FROM v_tournament_rake_attribution_gaps GROUP BY verdict;
   ```
2. The error the attribution recorded, for the newest rows:
   ```sql
   SELECT tournament_id, club_id, amount, source, settled_at, attribution_error,
          tournament_type, variant, name
   FROM v_tournament_rake_attribution_gaps
   ORDER BY settled_at DESC LIMIT 25;
   ```
3. Is the finish itself being refused for fee reasons? If
   `TournamentFinishRefusalsPersisting{reason="fee_reconciliation"}` or
   `TournamentsBlockedByUnreconciledFees` is firing, the cause is the
   accounting fee capture described in `docs/runbooks/horse-fleet-settlement.md`
   (section "Refusal reasons"), not attribution.
4. Hourly database-side check: pg_cron `rake-attribution-drift-audit-hourly`
   (`fn_rake_attribution_drift_audit`) and its recent results.

## Likely causes

- `attribution_threw`: the attribution call raised inside settlement;
  `attribution_error` carries the message. Fix the line that raised.
- `credited_nobody`: attribution ran and found no earner, which is almost
  always a filter excluding someone who should earn (the `is_horse` filter in
  `fn_settle_tournament_rake` on 2026-08-27 is the canonical example).
- `never_measured`: a settlement path that banks the fee without calling
  attribution at all.

## Settling the damage

Attribution owed is settled through the platform's idempotent accounting path
(`fn_recognize_accounting_tournament_fees` and the weekly accounting run), with
the numbers probed first in one rolled-back `DO` block (CLAUDE.md 10.9, 11.5).
Never hand-write VIP points, rakeback or commission rows.

## What not to do

- Do not bring back a repair or back-pay loop for attribution (CLAUDE.md 10.12);
  both functions were retired to counters deliberately.
- Do not add an `is_horse` filter anywhere in this path (10.5).

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics`, view
  `v_tournament_rake_attribution_gaps`.
- Live attribution: `fn_settle_tournament_rake`, `fn_attribute_tournament_rake`,
  `fn_recognize_accounting_tournament_fees`, `fn_process_weekly_accounting`.
