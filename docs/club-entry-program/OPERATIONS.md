# Club Entry Operations Runbook

## Feature Controls

The `club_entry_feature_flags` table controls `create_club`, `find_player`, and
`join_club`. Each row supports an enabled switch and a deterministic rollout percentage.
The client uses `fn_get_club_entry_flags` to hide unavailable actions, while every
authoritative mutation/search RPC independently enforces the corresponding flag.

Emergency disable:

```sql
update public.club_entry_feature_flags
set enabled = false, updated_at = now(), updated_by = auth.uid()
where key = 'join_club';
```

Progressive rollout:

```sql
update public.club_entry_feature_flags
set enabled = true, rollout_percentage = 25, updated_at = now(), updated_by = auth.uid()
where key = 'find_player';
```

Restore a feature by setting `enabled = true` and `rollout_percentage = 100`.

## Health Dashboard

The service-role-only `club_entry_daily_metrics` view reports daily attempts,
successes, failures, p95 duration, and average result count by flow and event.

```sql
select *
from public.club_entry_daily_metrics
where day >= current_date - interval '14 days'
order by day desc, flow, event;
```

Alert when any of the following persists for ten minutes:

- completion success is below 95% for Create or Join;
- p95 Create or Join duration exceeds 2.5 seconds;
- p95 Find Player duration exceeds 1.5 seconds;
- invalid/blocked Join outcomes exceed three times their seven-day hourly baseline;
- zero successful completions are recorded while attempts continue.

## Privacy and Audit

Telemetry accepts only allowlisted, low-cardinality fields: source, status,
error code, result count, and variant. Never add player names, search text, club
codes, invite URLs, email addresses, or free-form metadata.

Direct client writes to `audit_trail` are revoked. Staff can inspect mutation audit
records; normal users can inspect only records attributed to themselves. The
database trigger records Club, membership, and search-privacy mutations.

## Incident Procedure

1. Disable only the affected feature flag.
2. Confirm the UI reports the temporary unavailability and the RPC rejects bypasses.
3. Inspect daily metrics, server logs, and mutation audit records by request/user ID.
4. Correct the fault and validate in a non-production environment.
5. Restore at 5%, then 25%, then 100%, checking success rate and p95 at each stage.
6. Record the incident window, root cause, affected request count, and recovery time.

Do not delete idempotency records during an incident. They prevent retries from
creating duplicate clubs, memberships, or applications.
