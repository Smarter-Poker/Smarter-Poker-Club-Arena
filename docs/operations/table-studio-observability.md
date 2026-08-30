# Table Studio Operational Dashboard

The production dashboard is backed by two service-role-only views:

- `v_customization_health_hourly` is the alerting view. It shows estimated apply and purchase attempts, failures, apply p50/p95, Realtime failures/recoveries, and rapid-tap conflicts safely suppressed by the ordered writer.
- `v_customization_health_daily` is the diagnosis view. It groups the same signals by surface, cosmetic category, and event.

Routine successes are sampled at 20% and carry `sample_weight = 5`; failures, disconnects, recoveries, and conflicts are retained at 100%. Percentages and volume estimates therefore use the weight, while latency percentiles use the observed success sample. The raw table contains no free-form payload and cannot be read by browser clients.

## Alert thresholds

Use these initial thresholds until 30 days of baseline traffic exists:

| Signal                  |                                   Warning |                                      Critical |
| ----------------------- | ----------------------------------------: | --------------------------------------------: |
| Appearance failure rate |                        `> 1%` for 2 hours |                             `> 3%` for 1 hour |
| Apply p95               |                  `> 1,500 ms` for 2 hours |                       `> 3,000 ms` for 1 hour |
| Purchase failures       |                          `>= 3` in 1 hour |                             `>= 10` in 1 hour |
| Realtime recovery gap   |    failures exceed recoveries for 2 hours |        failures exceed recoveries for 4 hours |
| Suppressed conflicts    | investigate above 5% of estimated applies | critical only when paired with apply failures |

## Triage order

1. Check `appearance_failure_pct` and `apply_p95_ms`. A failure spike with normal latency points to entitlement/RLS/schema rejection; high latency with few failures points to database or network pressure.
2. Compare `realtime_failures` with `realtime_recoveries`. Recovery is expected after a transient channel loss; a widening gap means clients remain degraded.
3. Open the daily view and group by `category`. A single category implicates its catalog or entitlement mapping; all categories implicate the shared writer.
4. For purchase failures, compare `reason_code` directly in `customization_operations` using the service role. `insufficient_balance` is expected player behavior; `server_refused` and `transport_or_rpc_error` are incidents.
5. Run the authenticated production Playwright contract. It changes all free categories on two devices, verifies another player remains isolated, reloads for persistence, and restores both accounts.

Prune telemetry to the 30-day operating window by running `fn_prune_customization_operations(30)` from the scheduled service-role maintenance job. Only the service role can read the views or run the prune function.
