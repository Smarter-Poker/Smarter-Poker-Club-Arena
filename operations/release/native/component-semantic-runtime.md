# Component semantic qualification runtime contract

Source status: the provider adapter, owned workflow, archive/image boundary and
actual product oracle are implemented. **The complete isolated fixture runtime
and sanitized full application fixture are not implemented or qualified.** The
workflow deliberately refuses their absence. Native boundary tests are not a
passing candidate qualification or production installation receipt.

The controller installation pins `github.component_runtime_image` to an immutable
OCI digest and `github.component_qualification_workflow_id` to this workflow at
the reviewed `controlRef`/`controlSha`. `compatibility.schema.catalogue_digest`
is the complete fixture catalogue computed by `schemaCatalogue()` as
`qualification_reader`; `database_contract_digest` is the separate live engine
door catalogue digest. They must not be substituted for each other.

The missing runtime must provide the fixed `fixture-server` interface below.
These commands accept no candidate script, shell command or production URL.

1. `capabilities` returns exactly the version, scope, service list, browser and
   synthetic-local-only credential disposition required by `qualify-components.py`.
2. `start --schema=/inputs/schema.zip --web=/inputs/<digest>.zip
--engine=http://engine:8080` restores the exact schema into a fresh PostgreSQL
   database `club_arena_qualification`, seeds the reviewed synthetic fixture,
   starts real auth/PostgREST/realtime services and serves the exact frontend
   archive. No rebuilding, substituted API responses or candidate test execution.
3. `ready` succeeds only after those local services and the fixture are ready.
4. `engine-environment` returns exactly the four allowed keys in the native
   driver. The service key must authenticate only the disposable local fixture.
   It must never originate from an Actions/controller/production credential.
   `NODE_ENV` remains `production`, so qualification cannot bypass production
   startup or game behavior by switching the actual candidate into test mode.

The exact schema artifact must contain `schema.sql` and `fixture.json`, have an
original GitHub run/artifact/archive digest, and supply all required current
extensions, auth schema, functions, RLS, leases, table and hand persistence
contracts. The fixture must include a synthetic club/table with at least two
actors capable of playing continuously and an authenticated spectator. Existing
partial SQL test bootstraps and production seeds do not establish this fixture.
No production data dump, copied credential or new production account is implied.

The schema artifact's `fixture.json` includes `supabase_host`: exactly one
lowercase twenty-character project reference followed by `.supabase.co`.
The current compiled product hostname is `kuklfnapbkmacvwxktbh.supabase.co`.
The driver rejects schemes, ports, paths, credentials, IPs and wildcards, proves
that each exact manifest-verified frontend archive contains that hostname in
its JavaScript/HTML bytes, and adds it as an alias on the internal network.
This declares offline routing; it does not permit external egress. The runtime
must reject every unknown Host/SNI value rather than forwarding it elsewhere.

The fixture writes `/run/club-arena-qualification/fixture.json` containing:
`version:1`, `scope:"isolated-club-arena-fixture"`, `table_id`,
`spectator_user_id`, browser `storage_state`,
`base_url:"https://smarter.poker/hub/club-arena/"` and
`engine_health_url:"https://engine.smarter.poker/health"`. Those names resolve
only inside the native driver's internal Docker network. The TLS proxy must
also route the exact compiled bundle's Supabase and engine hosts to local
services. An unhandled hostname must fail, never escape to production. Browser
TLS verification is disabled solely for that disposable offline fixture.

The runtime includes a non-root `qualification` user, Chromium, `tsx`, `pg` and
`@playwright/test` under `/opt/qualification/node_modules`. The trusted control
checkout is mounted read-only under `/opt/qualification/controls`, so the actual
existing `tests/e2e/support/liveTableRealtime.ts` dependency resolves from the
same pinned checkout. `qualification_reader` can read only this disposable
database over `/run/postgresql`; the suite never reads `DATABASE_URL`.
Its reads must expose all fixture rows. The SQL oracle sets `row_security=off`,
which makes PostgreSQL error if the observer would otherwise receive filtered
rows; it does not grant RLS bypass or modify the browser/engine connections.

The driver checks native Docker image identity and source label, every static
file against the exact manifest and archive digest, schema bytes, internal
network isolation and cleanup. The pinned product oracle then requires actual
browser subscription, authoritative engine snapshot, a completed hand followed
by the next hand, and one matching PostgreSQL hand record with actions/players.
It also proves that the spectator did not acquire a seat. Every combination is
tested from a fresh fixture. A failed/absent/skipped/retried case or incomplete
cleanup cannot produce a successful receipt.

A hard workflow termination may prevent Python cleanup from executing. Such a
run has no successful semantic/cleanup receipt and cannot qualify. Its failed
owned operation must be reconciled; a timeout is never evidence that fixtures
were removed. Normal exceptions run cleanup and prove absence by successful
native container/network/image inventories.
The workflow preserves a separate `release-compatibility-cleanup-<operation>`
artifact on success or failure. Its initial state is incomplete, each attempted
tuple is recorded before creation, and completion requires both native fixture
absence and removal of loaded candidate images. A test may fail while cleanup
is proved complete; that never changes the semantic failure into success.
The artifact contains one `receipt.json`, written by the driver under
`evidence/cleanup/receipt.json`. A failed provider run remains unresolved until
the verifier proves this exact operation/run/request's completed cleanup; a
missing or incomplete cleanup artifact remains an unknown external outcome.

Remaining completion work is the actual runtime/service bootstrap source,
sanitized fixture generation and execution under the pinned before/intermediate/
after artifacts in credential-free Linux CI. No production activation is granted.
