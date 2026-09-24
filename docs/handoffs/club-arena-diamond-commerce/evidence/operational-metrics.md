# Operational Metrics: Which Records Answer Which Question

This file answers R2 line 1301 (Phase 7.5): "Measure payment success/ambiguity, duplicate-suppressed attempts, pending fulfillment age, due-renewal lag, refund age, sponsorship utilization and accounting postcondition failures ... Keep actual net paid diamonds separate from retries, waivers, proposed quotes and refunds". It also covers the questions the owner asked: trials started, conversions, renewals, `needs_attention`, refunds by state, and the admission would-deny rate.

## How to run these queries

Every `ca_commerce_*` table has RLS enabled, and **all** privileges are revoked from `anon`, `authenticated` **and `service_role`**:

- M1:424-427
- M3:109, M3:227, M3:253
- M4:143-144

These queries therefore run only as the database owner. On this project that means the Supabase SQL route (`execute_sql`) or `psql` as `postgres`. Run each one read-only, as one statement per call (R2 Appendix A, line 1727):

```sql
BEGIN READ ONLY; SET LOCAL statement_timeout = '10s';
-- one SELECT from below
COMMIT;
```

These queries were written against the column definitions in M1 to M4. They were **not executed** against any database for this document, because no production access was used and no local cluster could be started. These are reads. None of them is a corrective writer, and none may become one (R2 line 1303; repository `CLAUDE.md` 10.12).

**Table availability.** Tables marked (M3) or (M4) exist only after those migrations are installed. The repository does not record them as installed. Short names follow `c1-wiring-map.md`.

**The controlled-fixture limitation (D77).** No commerce table carries a fixture or test flag, so these counts cannot exclude controlled fixtures. The isolated runners never touch production. Any production row is therefore a real account's action unless someone exercised production by hand, and repository `CLAUDE.md` 11.5 forbids that.

## 1. Trials started

Sources: `ca_commerce_trials` (M1:168) and `ca_commerce_trial_scopes` (M1:179).

```sql
SELECT date_trunc('day', t.trial_start) AS day,
       t.cohort,
       count(DISTINCT t.id)  AS operator_trials,
       count(s.scope_id)       AS scopes_enrolled
  FROM public.ca_commerce_trials t
  LEFT JOIN public.ca_commerce_trial_scopes s ON s.trial_id = t.id
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Trials active right now:

```sql
SELECT count(*) FILTER (WHERE now() >= trial_start AND now() < trial_end) AS active,
       count(*) FILTER (WHERE now() < trial_start)                        AS scheduled,
       count(*) FILTER (WHERE now() >= trial_end)                         AS ended
  FROM public.ca_commerce_trials;
```

## 2. Conversions (trial scope to paid)

Definition: a scope whose trial has ended **and** that has at least one purchase with `net > 0` committed at or after its trial start.

A paid purchase cannot happen inside a trial (M2:562-564). Any such purchase is therefore either the post-trial authorization executed at the trial end (`kind='renewal'`) or a later manual purchase. Sponsored purchases count for the club scope.

```sql
WITH ended AS (
  SELECT s.scope_kind, s.scope_id, t.trial_start, t.trial_end, t.cohort
    FROM public.ca_commerce_trial_scopes s
    JOIN public.ca_commerce_trials t ON t.id = s.trial_id
   WHERE t.trial_end <= now()
)
SELECT e.cohort,
       count(*)                                                     AS scopes_trial_ended,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.ca_commerce_purchases p
          WHERE p.scope_kind = e.scope_kind AND p.scope_id = e.scope_id
            AND p.net > 0 AND p.created_at >= e.trial_start))       AS scopes_converted,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.ca_commerce_purchases p
          WHERE p.scope_kind = e.scope_kind AND p.scope_id = e.scope_id
            AND p.net > 0 AND p.kind = 'renewal'
            AND p.created_at >= e.trial_end
            AND p.created_at <  e.trial_end + interval '24 hours'))  AS converted_by_trial_end_authorization
  FROM ended e
 GROUP BY 1
 ORDER BY 1;
```

## 3. Renewals, and net paid diamonds kept apart from everything else

Paid collections by kind. Replays write no row, and waived trials write no purchase, so neither is counted here:

```sql
SELECT p.kind,
       (p.sponsorship_id IS NOT NULL)            AS sponsored,
       count(*)                                  AS purchases,
       count(*) FILTER (WHERE p.net > 0)         AS paid_purchases,
       sum(p.gross)                              AS gross_diamonds,
       sum(p.net)                                AS net_diamonds_debited
  FROM public.ca_commerce_purchases p
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Net collected after refunds. Refunds are the exact reversals in `ca_commerce_refunds`:

```sql
SELECT (SELECT COALESCE(sum(net), 0)   FROM public.ca_commerce_purchases) AS net_debited,
       (SELECT COALESCE(sum(gross), 0) FROM public.ca_commerce_refunds)   AS refunded_gross,
       (SELECT COALESCE(sum(net), 0)   FROM public.ca_commerce_purchases)
     - (SELECT COALESCE(sum(gross), 0) FROM public.ca_commerce_refunds)   AS net_retained;
```

Renewal outcomes. The events are written by `fn_ca_commerce_execute_renewal`: `'renewal_' || outcome` at M2:914-915 and M3:987-988.

```sql
SELECT kind, date_trunc('day', occurred_at) AS day, count(*)
  FROM public.ca_commerce_events
 WHERE kind IN ('renewal_renewed', 'renewal_needs_attention')
 GROUP BY 1, 2
 ORDER BY 2, 1;
```

Proposed quotes are kept apart and are never revenue. Quote status is written lazily, so an `open` quote past `expires_at` is effectively expired:

```sql
SELECT status, (status = 'open' AND expires_at <= now()) AS open_but_expired, count(*), sum(net) AS quoted_net
  FROM public.ca_commerce_quotes
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

## 4. `needs_attention`, and due-renewal lag

Mandates in attention, by reason. The reason is the `last_result` written at M2:905 and M3:978:

```sql
SELECT m.last_result->>'reason' AS reason,
       m.sku,
       (m.sponsorship_id IS NOT NULL) AS sponsored,   -- column exists only after M3; drop this line before M3
       count(*)
  FROM public.ca_commerce_renewal_mandates m
 WHERE m.state = 'needs_attention'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;
```

Mandate states overall:

```sql
SELECT state, count(*) FROM public.ca_commerce_renewal_mandates GROUP BY 1 ORDER BY 1;
```

Due-renewal lag: authorized work that is due and unclaimed. It is non-zero whenever the consumer is not running (`activation-matrix.md`).

```sql
SELECT count(*)                                   AS due_unclaimed,
       min(due_at)                                AS oldest_due,
       max(now() - due_at)                        AS max_lag,
       count(*) FILTER (WHERE now() - due_at > interval '24 hours') AS beyond_lateness_window
  FROM public.ca_commerce_renewal_mandates
 WHERE state = 'authorized' AND due_at <= now()
   AND (lease_until IS NULL OR lease_until <= now());
```

Consumer heartbeat (M3 only, M3:158):

```sql
SELECT consumer_heartbeat_at, now() - consumer_heartbeat_at AS age,
       launch_cohort_activated_at, admission_enforced_from, checkout_enabled, catalog_visible
  FROM public.ca_commerce_settings WHERE id = 1;
```

Pending notice age. Delivery is by the Engine. `suppressed_at` exists only after M3; before M3, drop that predicate.

```sql
SELECT kind, count(*) AS pending, min(due_at) AS oldest_due, max(now() - due_at) AS max_overdue
  FROM public.ca_commerce_notices
 WHERE delivered_at IS NULL AND suppressed_at IS NULL AND due_at <= now()
 GROUP BY 1
 ORDER BY 2 DESC;
```

## 5. Refunds by state, and refund age

Requests (M3, `ca_commerce_refund_requests`, M3:184):

```sql
SELECT state,
       reason_code,
       count(*)                                         AS requests,
       sum(policy_amount)                               AS policy_amount,
       sum(approved_amount)                             AS approved_amount,
       max(now() - created_at) FILTER (WHERE state IN ('requested','approved','owed')) AS oldest_open_age
  FROM public.ca_commerce_refund_requests
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Owed refunds with their reason (M3:643-664):

```sql
SELECT owed_reason, count(*), sum(approved_amount), max(now() - decided_at) AS max_owed_age
  FROM public.ca_commerce_refund_requests
 WHERE state = 'owed'
 GROUP BY 1;
```

Executed refunds. This includes staff service-route refunds made without a request:

```sql
SELECT (q.id IS NOT NULL) AS via_request,
       count(*), sum(r.gross) AS gross, sum(r.debt_settled) AS debt_settled, sum(r.net_increase) AS net_increase,
       count(*) FILTER (WHERE r.revoked_entitlement) AS full_line_returns
  FROM public.ca_commerce_refunds r
  LEFT JOIN public.ca_commerce_refund_requests q ON q.refund_id = r.id   -- before M3, remove this join and the first column
 GROUP BY 1;
```

## 6. Sponsorship utilization

```sql
SELECT s.union_id, s.state, s.total_budget, s.committed,
       round(100.0 * s.committed / NULLIF(s.total_budget, 0), 1) AS pct_committed,
       s.per_club_budget, s.effective_to
  FROM public.ca_commerce_sponsorships s
 ORDER BY pct_committed DESC NULLS LAST;
```

## 7. Admission shadow: decisions and the would-deny rate (M4)

Source: `ca_commerce_admission_decisions` (M4:124), written by `fn_ca_commerce_admit` (M4:259-290).

```sql
SELECT action,
       door,
       reason,
       count(*)                                                AS decisions,
       count(*) FILTER (WHERE would_allow IS FALSE)            AS would_deny,
       count(*) FILTER (WHERE would_allow IS NULL)             AS undecided,   -- reason 'decision_unavailable'
       round(100.0 * count(*) FILTER (WHERE would_allow IS FALSE) / count(*), 1) AS would_deny_pct,
       count(*) FILTER (WHERE enforced AND NOT allowed)        AS refused
  FROM public.ca_commerce_admission_decisions
 WHERE decided_at > now() - interval '7 days'
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;
```

Would-deny by scope, to find the clubs enforcement would affect before it is switched on:

```sql
SELECT scope_kind, scope_id,
       count(*) FILTER (WHERE would_allow IS FALSE) AS would_deny,
       count(*)                                     AS decisions,
       max(decided_at)                              AS last_seen
  FROM public.ca_commerce_admission_decisions
 WHERE decided_at > now() - interval '7 days'
 GROUP BY 1, 2
HAVING count(*) FILTER (WHERE would_allow IS FALSE) > 0
 ORDER BY 3 DESC;
```

A refused decision on the raising cash door is rolled back together with the refusal. RA `s_enforced_refuses_without_side_effect` shows this: "the raising cash door rolls its own decision back with the refusal". Once enforcement is on, `fn_cash_game_create` refusals therefore **do not appear** in this table. Count them from client or engine error reporting instead.

## 8. What R2 line 1301 asks for that no record answers

| Metric                                                                                           | Why no query can answer it today                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payment success versus ambiguity**                                                             | A refused or rolled-back purchase writes nothing. Every write rolls back with the exception (M1:1409-1426). Only committed purchases exist, and an ambiguous client outcome leaves no server row.                                                                                                                                                                                                                                                               |
| **Duplicate-suppressed attempts**                                                                | A replay by request key or quote returns the receipt without writing any row (M2:500-508, M2:519-522). The count is not persisted.                                                                                                                                                                                                                                                                                                                              |
| **Accounting postcondition failures** (`lots_unproved`, `register_unproved`, `journal_unproved`) | These roll back. RM `D33/D34 an incident filed inside the rolled-back transaction is not left behind as false evidence` proves nothing durable remains. They are visible only in these places: <br>- as the `last_result.reason` of a renewal mandate in `needs_attention` (section 4), for consumer-executed renewals only;<br>- in the Engine log line `[CommerceRenewal] ... (reason)` (Engine:180-184);<br>- to the browser that received the JSON refusal. |
| **Pending fulfillment age**                                                                      | No asynchronous fulfillment exists. `ca_commerce_fulfillments` has no writer (`unsupported-offerings.md`).                                                                                                                                                                                                                                                                                                                                                      |
| **Consumer status on `/health`**                                                                 | `commerceRenewalConsumerStatus()` (Engine:147) has no caller outside its module. The heartbeat query in section 4 is the only durable liveness signal, and only after M3 is installed.                                                                                                                                                                                                                                                                          |
| **Excluding controlled fixtures** (D77)                                                          | No flag exists (see "How to run these queries").                                                                                                                                                                                                                                                                                                                                                                                                                |

Closing any of these needs a new durable write outside the rolled-back transaction, for example through the existing application diagnostics path (R2 line 931). No such write exists in M1 to M4.
