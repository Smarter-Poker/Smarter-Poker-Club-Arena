# The Launch Has One Health Reading (2026-10-15)

## Why

Launch readiness was spread over a dozen separate readings, and nothing answered "is the platform ready right now" in one call.

## What

Migration `20261015101222_the_launch_has_one_health_reading.sql` adds `fn_ca_launch_health()`, which is service role only. It returns one row per area, each green, amber or red, with the detail behind the colour.

| Area             | Red                                                                                                    | Amber                  |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| financial_alerts | any unresolved critical                                                                                | any unresolved warning |
| hand_settlement  | any failed or stuck hand in the last hour                                                              |                        |
| weekly_close     | a close still open 48 hours after its week ended                                                       | a close in progress    |
| tournaments      | a running event silent for 15 minutes off a break, or one still registering 15 minutes after its start |                        |
| scheduled_jobs   | a critical cron verdict                                                                                | a warning verdict      |
| launch           | the worst of the above                                                                                 |                        |

Two rules shape the readings:

- A week the owner moved below a settlement floor (20260920232523) is preserved history, not an open close.
- A reading that throws is `unknown` and counts as red.

## Purity

The function is a pure read. It deliberately does not call `fn_money_check_health`, which files a financial alert for every stale heartbeat as a side effect.

On 2026-10-15 one diagnostic call to that board, which no job schedules any more, filed seven "has never run" criticals. Its heartbeat writer is no longer called, but every one of those checks runs on its own cron job. Those seven alerts and their incidents are closed by the alert triage migration of the same day.

## Use

```sql
SELECT * FROM public.fn_ca_launch_health();
```

Pinned by `tests/the-launch-has-one-health-reading.law.test.ts`.
