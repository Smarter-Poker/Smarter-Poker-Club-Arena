# Tournament finish refusals keep their own incident identity

Different tournaments reporting the same terminal refusal were grouped by normalized error text. Normalization removed the tournament UUID, while each recurrence replaced the incident's metadata and kept its original tournament column. One live incident accumulated nine different tournaments, and resolving its latest financial alert could close an incident still attributed to another event.

The financial alert trigger now includes the tournament ID in the key for `Tournament.atomic_finish_refused`, alongside the existing error shape. Repeated refusals for the same event still share an incident. Missing identities retain the original alert ID instead of grouping separate unknowns. Existing prize-credit grouping, severity rules and source exclusions are preserved. Historical rows remain intact for individual reconciliation.

Required accounting CI runs a native PostgreSQL 17 proof with the actual incident trigger, raiser, source writer, scope resolver, normalizers, resolution propagation and zero-discrepancy notification branch. Actual table columns and constraints are captured in isolated fixtures. The test reproduces cross-event metadata replacement and resolution, then verifies separate tournaments, repeated causes, concurrent reports, case-normalized IDs, missing identities, original alert retention and drift-safe installation.

This change fixes incident attribution. It does not settle a tournament, infer a missing elimination sequence, move chips or certify historical payout correctness. The existing storm cap remains; original financial alerts are still retained individually.

The migration records its guard redefinition in the same transaction. Native tests use the actual declaration function and watchlist to verify the stored hash, exact definition history, replay behavior and unchanged baseline after a refused drifted installation.
