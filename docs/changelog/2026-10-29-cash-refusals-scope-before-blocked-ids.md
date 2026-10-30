# Cash refusal reads apply scope and clock bounds before blocked receipt IDs

The original weekly preparation read all 35,994 blocked receipt identities before
checking club/union and the earned week. The isolated original production query
returned no DSS refusals in 13,639.801 ms; its receipt index-only walk consumed
31,737 page reads. The existing blocked-work indexes already cover the queue.

The new bounded expression index keys `unknown`, or an exact 36-octet club/union
UUID scope, followed by earned time and receipt ID. Its text key is at most 42
bytes. Other legal JSON values remain admitted. No raw JSON is included in the
index and no eligibility or stored business row changes.

The original refusal owner retains its argument validation, security, ACL,
late detail fetch, ordered JSON aggregation and return contract. Only its CTEs
change: blocked-work duplicates join receipts directly; disjoint finite-range
and exact-infinity branches expose scope/time index conditions. Native ICU
fixtures preserve complete results and errors and choose natural bounded index
or bitmap paths. Index-only access is not claimed.

The CCI, separate bounded three-column ANALYZE and refusal migrations pin the actual two-table schemas, old six indexes, ten raw
triggers, five trigger owners, current tournament authority and genuine source
generation. Installation requires protected source and exact history/readback.
The TQ migration additionally requires these installed causal dependencies and real collected expression statistics.
Production capacity and book closure remain separate acceptance steps.

TypeScript and final affected native/provider results are recorded in the task
checkpoint. No production installation or payout completion is asserted here.

The normal pre-push authorization scan refused the replacement because it cannot infer prior operator-only ACLs. Both replaced SECURITY DEFINER owners now explicitly revoke PUBLIC, anon, authenticated and service_role in the same migration, preserving their already verified postgres-only ACL. This changes no economic query, function body or existing permission. Exact native full-metadata/atomic/history/readback checks are rerun for the changed migration bytes.
