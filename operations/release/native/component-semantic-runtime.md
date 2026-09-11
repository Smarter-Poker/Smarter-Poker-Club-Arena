# Component semantic qualification runtime contract

Source status: the provider adapter, owned workflow, archive/image boundary and
actual product oracle are implemented. **The complete isolated fixture runtime
and sanitized full application fixture are not implemented or qualified.** The
workflow deliberately refuses their absence. Native boundary tests are not a
passing candidate qualification or production installation receipt.

The controller installation pins `github.component_runtime_image` to an immutable
OCI digest and `github.component_qualification_workflow_id` to this workflow at
the reviewed `controlRef`/`controlSha`. `compatibility.schema.catalogue_digest`
is the complete fixture catalogue computed by the exact reviewed `schemaCatalogue()` helper; `database_contract_digest` is the separate live engine
door catalogue digest. They must not be substituted for each other.
Column metadata comes directly from `pg_attribute`, `pg_class`, `pg_namespace`,
`pg_type` and `pg_attrdef`, including type/UDT, nullability, default and order.
It does not use the privilege-filtered `information_schema.columns` view.
The digest now also covers normalized effective ACLs and ownership for functions,
schemas, relations, columns and types in every non-system schema; default ACLs,
named role privilege flags and membership options are included. Grantors and
grantees use role names, PUBLIC is explicit, implicit default ACLs are expanded,
and grant order is normalized. Role passwords are never selected. Existing
public/auth definitions, constraints, triggers, indexes and RLS remain included.
Fixture producers must recompute the digest with this same reviewed encoding.

**Table SELECT grants and NOINHERIT do not establish a narrow observer.** PUBLIC
EXECUTE on application SECURITY DEFINER functions remains executable. The donor
also lacks the current application role ACL baseline. No blanket application
ACL revocation or added grants can substitute for qualifying the actual schema.
The existing direct PostgreSQL oracle path is a prototype with an unresolved
isolation dependency; it must not be represented as qualified. A fixed-query
Unix socket bridge is being reviewed separately and is not implemented here.

The missing runtime must provide the fixed `fixture-server` interface below.
These commands accept no candidate script, shell command or production URL.
The driver invokes the fixed `/usr/local/bin/fixture-server` wrapper. That wrapper
executes the packaged `/opt/qualification/runtime/fixture-server.mjs`; related
runtime modules live in the same fixed package, outside candidate artifacts.

1. `capabilities` returns exactly the version, scope, service list, browser and
   synthetic-local-only credential disposition required by `qualify-components.py`.
2. `start --schema=/inputs/schema.zip --web=/inputs/<digest>.zip
--engine=http://engine:8080` restores the exact schema into a fresh PostgreSQL
   database `club_arena_qualification`, seeds the reviewed synthetic fixture,
   starts real auth/PostgREST/realtime services and serves the exact frontend
   archive. No rebuilding, substituted API responses or candidate test execution.
3. `ready` succeeds only after those local services and the fixture are ready.
   This occurs before the candidate engine starts and does not prove that
   engine's readiness.
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

The schema artifact's `fixture.json` requires `source_contract` with exactly
`version:1`, a 40-lowercase-hex `source_sha`,
`current_database_contract_ready:true`, and `exclusions:[]`. The driver refuses
absent/malformed/not-ready/excluded contracts before candidate image loading or
fixture execution; the trusted oracle independently checks the runtime-preserved
contract before opening its database connection or browser. The schema source
revision is **not** required to equal before/intermediate engine revisions.
The reviewed donor currently declares ready=false with tournament lane, mystery
bounty and application-role ACL exclusions, and therefore cannot qualify.

The schema artifact's `fixture.json` also includes `supabase_host`: exactly one
lowercase twenty-character project reference followed by `.supabase.co`.
The current compiled product hostname is `kuklfnapbkmacvwxktbh.supabase.co`.
The driver rejects schemes, ports, paths, credentials, IPs and wildcards, proves
that each exact manifest-verified frontend archive contains that hostname in
its JavaScript/HTML bytes, and adds it as an alias on the internal network.
This declares offline routing; it does not permit external egress. The runtime
must reject every unknown Host/SNI value rather than forwarding it elsewhere.

The fixture writes `/run/club-arena-qualification/fixture.json` containing:
`version:1`, `scope:"isolated-club-arena-fixture"`, `table_id`,
`spectator_user_id`, browser `storage_state`, the unchanged `source_contract`,
`base_url:"https://smarter.poker/hub/club-arena/"` and
`engine_health_url:"https://engine.smarter.poker/health"`. Those names resolve
only inside the native driver's internal Docker network. The TLS proxy must
also route the exact compiled bundle's Supabase and engine hosts to local
services. An unhandled hostname must fail, never escape to production. Browser
TLS verification is disabled solely for that disposable offline fixture.

The image's default OS user is `fixture`, UID/GID 1000, and the driver explicitly
starts its service container as `1000:1000`. Its `/tmp`, `/run` and
`/var/lib/postgresql` tmpfs mounts are owned by UID/GID 1000. `/tmp` uses mode
1777 so the separate oracle user can use its own scratch without sharing a
private service directory. The read-only root filesystem and `cap-drop=ALL`
remain enforced. The engine's own `/tmp` uses the same owner and sticky mode.
Before mounting, the driver gives only the sanitized immutable input directory
mode 0755 and its artifact/plan files mode 0444, so a different host-runner UID
cannot make the read-only `/inputs` mount inaccessible to `fixture`. Runtime
service credentials must never be placed in those public input artifacts.

The runtime includes a separate non-root `qualification` user, UID/GID 1001,
with no shared groups with `fixture`, plus Chromium, `tsx`, `pg` and
`@playwright/test` under `/opt/qualification/node_modules`. The trusted control
checkout is mounted read-only under `/opt/qualification/controls`, so the actual
existing `tests/e2e/support/liveTableRealtime.ts` dependency resolves from the
same pinned checkout. The current prototype uses `qualification_reader` over
`/run/postgresql` and never reads `DATABASE_URL`; this connection is not yet a
qualified security boundary because of inherited PUBLIC function execution.
The oracle's `docker exec` explicitly sets `HOME=/tmp/qualification`,
`TMPDIR=/tmp` and `XDG_CACHE_HOME=/tmp/qualification/cache`. The oracle process
itself, running as UID/GID 1001, creates its home and cache with mode 0700 before
constructing the PostgreSQL client or launching Chromium. The fixture service
UID 1000 must not pre-create or attempt to chown that home. The oracle refuses
symlinks, a different owner/group, or permissive pre-existing directory modes.
The fixture's `net.ipv4.ip_unprivileged_port_start=0` setting permits its local
unprivileged TLS proxy to bind the declared ports without adding capabilities.
Private runtime files/directories remain mode 0700 and owned by `fixture`;
only the public fixture descriptor
`/run/club-arena-qualification/fixture.json` is readable by `qualification`.
The runtime must permit traversal to that public descriptor without granting
the oracle access to private service data or synthetic service keys.
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

Before browser navigation, the trusted oracle separately waits at most 90
seconds for HTTP 200 with the exact expected engine `releaseSha` and
`running:true`. A wrong nonempty `releaseSha` fails immediately, including on a
startup error response. Each request is bounded by the remaining original
deadline; late correct responses cannot extend it. The native receipt records
`engine_readiness.timeout_ms` (90000), elapsed time, observation count, exact
source and running state. This startup allowance consumes the existing
240-second oracle command budget. It is not a browser/test retry and never
replaces or restarts the engine or selects another hand.

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
