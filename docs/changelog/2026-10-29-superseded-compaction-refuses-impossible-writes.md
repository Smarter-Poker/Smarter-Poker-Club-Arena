# Reject impossible physical compaction savings before writing

The existing superseded-action compactor requires the actual stored request
reduction to exceed its certificate tuple plus the existing 4096-byte overhead
reserve. A compressed original request occupying at most 4096 bytes cannot pass
that requirement even if its entire payload could be removed. Previously this
case could pass the raw-actions/semantic qualifier, insert a certificate and
update the request, then roll both writes back when the physical check failed.

The function-only follow-up moves its existing stored-value point read before
the semantic qualifier, while the original row lock remains held, and returns to
the next candidate for this mathematically impossible case. It does not measure
the detoasted PL/pgSQL row value. Larger originals retain the complete original
eligibility and measured net-benefit checks, certificate guard, per-row rollback,
permissions, execution budget and replay/economic preservation. No retention
period, cron, financial authority or user-facing behavior changes.

The existing required PostgreSQL owner qualifies the exact reserved upgrade.
Its compressed eligible fixture uses nontransactional sequence observers: the
original function attempts both certificate and payload writes before rollback;
the upgraded function attempts neither and preserves every source/receipt byte.
The existing positive, replay, permission, concurrency and economic checks run
against the upgraded function. Replay installation and unexpected ACLs refuse.

This reduces avoidable compaction work and write churn. It is not a measured
claim of reclaimed gigabytes, a stopped database growth rate or invoice savings.
Production installation and live readback remain separate from source checks.
Paid Realtime remains enabled and the independent gateway remains inactive.
