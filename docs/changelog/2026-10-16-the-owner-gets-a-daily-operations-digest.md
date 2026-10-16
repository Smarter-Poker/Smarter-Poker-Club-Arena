# The Owner Gets A Daily Operations Digest And Instant Critical Pages

Date: 2026-10-16

## What Changed

Smarter.Poker now emails the owner a daily operations digest at 7:00 AM Central about the previous Central day, modelled on the Pep Nation Lab digest, and pages the owner by email and text within 5 minutes when money-critical conditions appear.

Database objects (this migration):

| Object | Purpose |
| --- | --- |
| `smarter_private.sp_real_humans` | The one "real player" filter: no horses, no anonymous sessions, no retired accounts (scrambled auth email without `@`), no `.invalid` / `.local` / `.test` / `hydra.bot` / `example.*` addresses, no staff or QA accounts on the owner's own domains, no `deleted-` / `crest_cert_` / `PostDeploy` usernames, no `00000000-` fixture ids, no active `ca_cert_accounts`. |
| `public.sp_digest_settings` | Tunable thresholds for the attention rules. |
| `public.sp_daily_metrics` | One row per Central day: every metric plus the attention items as dispatched. |
| `public.sp_daily_digest_runs` | Idempotent send log, one row per day. |
| `public.sp_critical_pages` | Instant pages, deduplicated by key. |
| `fn_sp_daily_metrics_compute(day)` | Read-only metric computation for one Central day. |
| `fn_sp_daily_metrics_snapshot(day)` | Writes the day's row, evaluates the attention rules and hands each item to the Production Alerts fleet (`fn_record_operational_alert`, source `sp-daily-digest`, fleet task `01a09b86-...`). |
| `fn_sp_digest_attention(day, metrics)` | The Needs Your Attention rules. |
| `fn_sp_daily_digest(day, dispatch)` | What the email renders: metrics, prior day, 7 day series, month to date with projection, the Monday week card, and every attention item with the fleet's status read back. |
| `fn_sp_digest_claim` / `fn_sp_digest_finish` | Send log used by World Hub `/api/cron/daily-digest`. |
| `fn_sp_critical_scan` / `fn_sp_critical_mark` | Pager feed used by World Hub `/api/cron/critical-pager`. |
| `fn_sp_digest_watchdog()` | At 8:15 AM Central pages if the morning email was not sent. |

All functions are SECURITY DEFINER and granted to `service_role` only. Tables have RLS enabled with no policies and are revoked from `anon` and `authenticated`.

Schedules: `sp-daily-metrics-snapshot` (12:15 AM Central) and `sp-daily-digest-watchdog` (8:15 AM Central), each listed at two UTC hours and acting only on the Central-time match so daylight saving cannot move them.

## Follow-Up Migrations The Same Night

- `20261016040822`: the first filter counted 1,752 "real players". 1,596 were retired certification fixtures whose auth email is scrambled, 96 were `hydra.bot` load-test accounts, and staff and QA accounts sat on the owner's domains. Real players: 37.
- `20261016041108`: the first snapshot turned 29 critical alert names into their own DailyDigest inbox rows because no prior-day snapshot existed. Rising alerts are now one grouped item compared against the alert inbox itself, and that item and the drift-past-deadline item are not re-sent to the fleet (they show as already in the fleet queue). The 30 duplicate rows were reclassified informational.

- `20261016042416`: anti-cheat signals count only pairs with a real player (all 6,173 signals on 2026-10-14 were horse-with-horse pairs; reported separately), diamond liability in USD counts real players' balances only ($586.01 on 2026-10-13, not $1.1M across every wallet), and the beta-account check matches `kingfish` and `danimal5022`.

- `20261016042936`: chip supply drift pages the phone only from 100 chips (setting `supply_page_threshold_chips`). 6 of 72 hourly snapshots over 3 days carried 3.60 to 6.20 unexplained chips; any non-zero drift still shows in the morning digest and goes to the fleet. The first page (3.60 chips) was closed unsent with `fn_sp_critical_mark`.

- `20261016050452`: attention copy carries no dollar sign (Club Arena rule, enforced by `check-ui-dollar` over migration SQL). The payment item reads "Payments: 0.00 USD refunded, ...". The same text replaced the earlier wording in the two files that first defined `fn_sp_digest_attention`.

Backfill: `sp_daily_metrics` holds 2026-10-01 through 2026-10-14. Oct 12 was checked against independent queries (cash rake 217,185.27, tournament rake 100,004.56, hands 1,030,503, diamonds given 368,574, tournaments completed 21,971): all identical.

## Findings From The Deep Dive That Shaped It

- The 31 "signups" on 2026-10-14 and 975 of the "human VIPs" were certification fixtures (`@example.invalid`, `ca-customization-cert`). Real-player signups that day were 0, so phone verification was not broken. Every user metric now goes through `sp_real_humans`.
- `club_rake_daily_user` is keyed by UTC day and matches the ledger exactly (14,750.24 for 2026-10-14 UTC). The 73,222.58 figure is the Central day. The digest reports the Central day from the ledger and cross-checks the UTC rollup every night (rule `rake_rollup_mismatch`).
- Cash rake on 2026-10-14 (Central) was 73,140.01 from horses and 82.57 from real players; the digest splits it through `rake_attributions`, which sums to the ledger exactly.
- Info-level diamond incidents (14,308 open `DR5` rows) and informational alert-inbox rows are excluded from counts; alert counts are new-in-window and grouped by name.

## Rollback

```sql
SELECT cron.unschedule('sp-daily-metrics-snapshot');
SELECT cron.unschedule('sp-daily-digest-watchdog');
```
Removing the two World Hub crons from `vercel.json` stops the email and pager. The tables and functions are inert without callers.
