# Public discovery checks current home-group privacy

A home group could be cached while public, then remain visible through the two
public materialized views after its owner made it private. The existing refresh
schedules were fifteen and thirty minutes. The production audit found 491 venue
rows and no cached home-group rows; it did not find an existing private-location
leak. An isolated native regression reproduces the transition defect.

The migration moves the unchanged materialized caches and their unique indexes to
`discovery_private`. Public views keep the original names and columns, add
`security_invoker` and `security_barrier`, and check current eligibility against
`commander_home_groups` on every read. Browser roles retain underlying SELECT
for invoker-view execution but have no USAGE or CREATE on the private schema, so
direct private-cache reads fail. Current source RLS still applies, even for a
member or owner who can otherwise read a private group. The venue branch keeps
its existing behavior.

All four existing read RPCs retain their OIDs, exact definitions, signatures,
result shapes, search paths, caller rights and grants. The two existing refresh
RPCs only change their cache qualification; their modes, grants, return shapes,
concurrent refresh indexes and cron commands/schedules remain unchanged. No new
scheduler, engine behavior, client caller or elevated reader is introduced.

## Qualification

`python3 scripts/ci/test-discovery-privacy-postgres.py` runs in the existing
required PostgreSQL 17 accounting job, shard four. It uses a socket-only private
cluster with no inherited provider credentials. The fixture retains exact
production function/view definitions and no production rows. A type-compatible
geography stand-in compiles the unchanged PostGIS expressions; this test does
not claim to qualify spatial-distance math.

The baseline fails when a newly private group remains discoverable without a
refresh. The candidate passes private/inactive/deleted/photo-expired/activity-
expired/location-missing transitions, owner/member and restrictive RLS,
anonymous/authenticated/service permissions, all four RPCs, prepared-plan
invalidation, unchanged columns/function grants/index identity, concurrent
refresh, source-drift refusal, duplicate-install refusal and full DDL rollback.
Two real connections prove the MVCC boundary: an already-open repeatable-read
snapshot remains consistent; a new snapshot hides the committed private group
immediately without refreshing the cache. It does not promise to revoke data
already delivered to a client or change PostgreSQL snapshot semantics.

Installation is a single bounded transaction with source hashes and dependency
checks. Apply once through the existing database route after the current DDL
maintenance guard permits it, then read back history, view security options,
private-schema privileges, refresh definitions, preserved RPC contracts and
public counts. The parent task owns production installation; source merge alone
is not installation evidence. Rollback testing covers an aborted installation;
do not restore the old exposed-cache design after a successful privacy fix.

The signed-in September 26 settings showed only `public` and `graphql_public`
exposed and `public, extensions` in the extra search path. No API setting was
changed. Browser schema privileges also protect direct cache access independently
of those settings.

References: [PostgreSQL view privileges](https://www.postgresql.org/docs/17/rules-privileges.html),
[security-invoker views](https://www.postgresql.org/docs/17/sql-createview.html),
[Supabase custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas).
