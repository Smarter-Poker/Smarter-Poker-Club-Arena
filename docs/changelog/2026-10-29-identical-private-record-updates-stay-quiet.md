# Identical private-record updates stay quiet

The row-level member-record publisher sent private member and roster invalidations
when an UPDATE named a subscribed column even if the complete OLD and NEW rows
were identical. PostgreSQL's UPDATE OF trigger semantics inspect the column list,
not whether its values changed. The existing per-topic transaction dedup prevented
repeated sends within one transaction but did not prevent these redundant commits.

The new migration returns before publication only for an UPDATE with identical
complete OLD and NEW JSONB rows. Every actual field change, INSERT, DELETE,
old membership scope, upline identity refresh, topic ACL and transaction/savepoint
dedup remains on the original path. No column is ignored, including activity
fields, and no horse, staff or inactive-client filter is introduced.

Installation pins the captured production function MD5 and exact owner/ACL/
security-definer/search-path metadata. It advances only that function's existing
transport fingerprint in the same transaction, verifies all other configuration
is unchanged and requires the original source-readiness check to remain true.
Paid Realtime remains enabled and the independent gateway remains inactive.

The existing required MemberRecord PostgreSQL suite reproduces the redundant
send before installation and verifies zero paid messages and zero actual
committed NOTIFY messages after identical updates across all six row-source
owners. It also exercises real wallet and identity changes, membership creation
and removal, same-transaction dedup, rollback/savepoint recovery, source-binding
and privilege drift refusal, and migration replay refusal. These are isolated
native fixtures; production financial records are never used for probes.

No bill saving or message-reduction percentage is claimed without subsequent
production usage measurement. This change removes only provably redundant
signals and does not qualify retirement of paid Realtime.
