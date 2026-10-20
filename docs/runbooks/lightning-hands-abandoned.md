# Lightning Hands Abandoned

Use this runbook for `LightningHandsAbandoned` in the `lightning-settlement`
group of `infra/monitoring/alert-rules.yml`. The alert observes; it never
pauses a Cluster, retries a settlement, restarts the engine or moves money.

## What fired

More than 10% of Lightning (fast-fold) hand ends in the last ten minutes were
`abandoned` rather than `settled`, with at least 20 hand ends in the window, for
five minutes. The engine counts every hand end in
`poker_lightning_hands_total{outcome}` (`settled`, `abandoned`,
`settlement_unknown`, `frozen`); every abandon path in
`server/src/lightning/LightningHandHost.ts` (`abandon(reason)`) increments
`abandoned`.

Why 10%: from 2026-10-12 18:00Z to 2026-10-19 22:20Z, in 10-minute windows, the
abandoned share was 0 everywhere except two windows (worst 1.5%, 3 of 210 on
2026-10-19 15:45Z). During the 2026-10-18 19:29-22:20Z incident it was 12-68%
in every window. The incident abandoned 1,611 hands with
`settlement_refused:physical_settlement_refused`, about 65% of that Cluster's
hands, and nothing paged because no rule read this counter.

## Read the reason first

The counter carries no reason label (that would be unbounded). The reason is
durable in the database:

```sql
SELECT cluster_id, split_part(abandon_reason, ':', 1) AS reason_class,
       abandon_reason, count(*), min(created_at), max(created_at)
  FROM public.lightning_instance
 WHERE state = 'abandoned'
   AND created_at > now() - interval '30 minutes'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;
```

and in the engine log as `[LightningHost:<instance>] abandoned: <reason>`.

- `settlement_refused:*` - the database refused the hand's settlement. Read the
  refusal reason against the settlement function and the Cluster's pool and
  wallet state before anything else. This is money-adjacent: never replay a
  settlement by hand; follow CLAUDE.md 10.9.
- `host_lease_lost*`, `leadership_lost` - engine ownership moved; compare with
  the maintenance break and engine restarts.
- `begin_dealing_refused:*`, `bind_refused:*`, `keepalive_refused:*`,
  `deal_failed`, `runout_stalled`, `conservation_check_failed` - read the named
  step in `LightningHandHost.ts`.

```promql
sum by (outcome) (increase(poker_lightning_hands_total[10m]))
```

## Limits

A firing says hands are ending unsettled; it does not say which Cluster or why.
Recovery of the alert proves only that the share fell below 10%. Do not add a
watcher, cron or retry loop to clear it; fix the refusing step at its source.
