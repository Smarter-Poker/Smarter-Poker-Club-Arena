# Atomic nightly tuner updates

The existing nightly tuner read profiles before its study, then updated each
profile and wrote its audit in separate requests. A newer profile edit could
be overwritten by that old copy. If audit insertion failed after the update,
the changed dials had no matching audit record. Both failures are reproduced
in the private PostgreSQL verification fixture.

The tuner now captures the original profile and sends one bounded request
containing that expected value, the proposed profile and the existing audit.
A service-only transaction compares the current horse profile under its row
lock, preserves authored fields, validates the audit's before/after modifiers,
and commits the profile, audit and immutable request receipt together. An
unchanged study records its audit without rewriting the profile. A stale
profile, conflicting study for the same horse/day, or legacy unbound audit
refuses the update. No fallback performs separate writes.

An exact replay returns the stored receipt without writing or counting a new
tune, even if the profile changed later. A lost response remains unknown;
it does not prove rollback. The request is limited to64KiB, one writer per
horse uses a nonwaiting advisory lock, profile lock waits are capped at two
seconds and the client request at five seconds. Client roles cannot mutate
receipts directly. App roles cannot call the writer.

The real nightly study is exercised with mutable input: the original profile
and proposed profile must both retain the study generation, while an unknown
or replayed write never increments newly tuned counts. This caught and fixed
a shallow-copy alias in the first implementation. Eleven native PostgreSQL
groups cover the original failures, stale profile refusal, transaction rollback,
lost-response replay, writer contention, unchanged studies, legacy string styles,
old audit refusal, modifier/persona checks and role permissions. Private database
cleanup is verified. Compilation and62focused tests pass; full regression and
release receipts are tracked separately.

The existing diagnosis formulas, sample floors, modifier bounds, scheduling
and legacy leak inputs remain in use. This fixes their write boundary; it
does not establish causal benefit or activate the new Phase14 learner. Durable
discovery, causal proposals, independent holdout/shadow evaluation, activation
and rollback remain unfinished.
