# A new view must not inherit write grants

2026-08-28

## What happened

CHECK 10 of the Build Safety Gate (`no_client_writable_views`) went red and
blocked **every** pull request in the estate, mine included. The check reads the
live catalog rather than the diff, so it fails on whatever the database looks
like at that moment, not on what the pull request changed. Mine was simply the
next one through the door.

The two views it named:

```
v_insurance_activity    anon, authenticated    DELETE, INSERT, UPDATE
v_insurance_pnl         anon, authenticated    DELETE, INSERT, UPDATE
```

Both created that morning by
`20260828120500_insurance_reconciliation_and_views.sql`.

## The migration that created them contains no GRANT

That is the whole point. Nobody wrote those grants. The default ACL on schema
`public` did:

```
pg_default_acl, objtype r
  anon=arwdxtm/postgres
  authenticated=arwdxtm/postgres
```

`a`, `w`, `d` are INSERT, UPDATE, DELETE. Postgres applies the relation default
ACL to **views** as well as tables, so every view created in `public` is born
holding client write grants. Any agent creating a view is walking into this,
and the failure surfaces on somebody else's pull request hours later.

**This was the second occurrence in 24 hours.**
`20260827010000_revoke_client_write_grants_on_club_hand_daily` is the identical
failure on `club_hand_daily`, one day earlier. That migration revoked the
grants on the one view it knew about and left the mechanism in place, so the
estate paid for it again the next morning. Hand-patching each new view is not a
fix, it is a subscription.

## Were we exposed

No, and the distinction matters. Both insurance views aggregate (`GROUP BY`),
so `information_schema.views` reports `is_insertable_into = NO` and
`is_updatable = NO`. Postgres refuses a write through either one before it ever
consults privileges. The grants were inert.

The invariant is still right to fail closed, because it is not testing these
two views, it is testing a class. A **simple one-table** view carrying the same
inherited grants is a genuine RLS bypass: the write lands on the base table
under the view's rules rather than the table's. The correct response is to stop
minting the grants, not to widen the exemption list.

## The fix

Two parts, because one without the other is what happened yesterday.

1. **The instance.** Revoke `insert, update, delete, truncate` from `anon` and
   `authenticated` on both views. `SELECT` is deliberately left alone: both are
   `security_invoker=true`, so readers still see only what the underlying RLS
   policies allow, and taking SELECT would silently break both insurance
   dashboards — the exact kind of collateral damage this file argues against.

2. **The mechanism.** An event trigger on `ddl_command_end` for `CREATE VIEW`
   and `CREATE MATERIALIZED VIEW` that revokes those four privileges the moment
   a view in `public` is created.

The default ACL itself is deliberately **not** changed. It is shared with
tables, and clients legitimately write to tables here — those are protected by
RLS, not by the absence of a grant. Revoking `arwd` by default would silently
break the next ordinary table instead. The fix narrows to views only.

## How this was proved, not assumed

`economy_invariants()` read back all 12 checks green, including
`no_client_writable_views`.

Then the guard was proved to actually **fire**, using the probe-and-rollback
pattern from `CLAUDE.md` 11.5 — a `DO` block that creates a view of the
genuinely-updatable shape (single table, no aggregate), reads its ACL, and
raises to abort so nothing is left behind:

```
ERROR: PROBE RESULT: client write grants on a brand new view = (none)
```

Before this migration that read `DELETE,INSERT,UPDATE`. The probe rolled back;
no `zz_probe` object survives, and no helper function was left in `public`.

## Not my change, fixed anyway

The insurance views are another agent's work. `CLAUDE.md` section 4 is
fix-first, and the playbook's RULE 7 is fix your own build: a red `main` blocks
me whether or not I caused it, so repairing it came before my own work rather
than after it.
