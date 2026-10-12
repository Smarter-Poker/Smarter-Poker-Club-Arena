# Unqualified Real Authorization Transport Draft

Maintained Qualification Candidate, Not A Runtime Or Production Certificate. The adjacent `.mjs`
contains a finite real GoTrue signup/password-login/refresh and PostgREST
setup read/save authority matrix, with anonymous, tampered and actually expired
issued-token refusal. It never accepts a configurable remote endpoint.

## Prerequisites And Exact Execution Boundary

1. Finish the existing faithful schema-only restore/catalog preflight first.
   Use a fresh disposable empty database, never the production source connection.
   No production data, passwords, API keys, sessions or signing keys are copied.
2. Select immutable official `supabase/gotrue@sha256:...` and
   `postgrest/postgrest@sha256:...` images. Production Auth health identifies
   v2.197.0; live REST connection self-identification is 14.5. Neither observation
   establishes production OCI digest or configuration parity.
   Inspect the selected tag's command source, not merely current master.
   Current official Auth source distinguishes bare root startup (migrate then
   serve) from explicit `gotrue serve` (serve only). Override the image command
   to explicit serve only after verifying that exact candidate implementation.
   Do not depend on `GOTRUE_DB_AUTOMIGRATE=false` without source proof.
3. The metadata-only inventory is retained in the task's
   `auth-schema-version-inventory-20261006.json` evidence archive. Freshly
   compare all 82 version-only `auth.schema_migrations.version` values through
   the authorized metadata-only preflight, ordered identically; latest is
   `20260831180000`, recorded fingerprint `a39a6625824a961c445673001a211a1d`.
   Count/latest/hash alone cannot qualify candidate compatibility. Exact 82-row
   restored database readback must equal that inventory before/after startup
   and testing. Separately inspect the pinned image's actual migration files;
   every file version must already exist in the 82-row database ledger, with
   zero pending image migrations. Binary files and retained historical ledger
   rows are distinct inventories; never pretend their lengths are equal.
   Do not copy migration business data or silently apply missing migrations.
4. Keep original schema ownership, grants, functions and triggers. Do not
   redesign an Auth role to make startup succeed. Re-run the complete catalog
   comparison after startup and after the matrix; any drift is failure.
5. Start only inside an owned Docker `--internal` network: PostgreSQL, Auth,
   REST and test driver have no public port or host-network attachment. Fixed
   aliases are `leaderboard-auth:9999`, `leaderboard-rest:3000`. Auth/REST DB
   connections point only to the owned isolated PostgreSQL alias/socket.
   Retain the existing no-job/external-egress guards. No provider calls.
6. Generate ephemeral local-only signing secret and DB credentials; keep them
   in the owned SSD/runtime private input and never print logs/config/environment
   values. Configure email signup/password auth and synthetic local autoconfirm,
   no external SMTP/OAuth/webhooks. This config is local, not production parity.
7. Invoke signup mode with five generated >=20-character passwords and emails
   `lb-real-auth-1@smarter-poker.invalid` through `lb-real-auth-5@smarter-poker.invalid`.
   Signup triggers must genuinely create profiles; read back five users/profiles,
   no signup errors, and no unexpected fixture accounts. Issued UUIDs are emitted
   without credentials; preserve the same ephemeral passwords for matrix mode.
8. Adapt only a new isolated fixture from the authorization draft to the five
   actual signup UUIDs: union owner, standalone owner, affiliate owner, member,
   nonmember. Do not insert replacement auth.users/password hashes. Use real
   join/mint-retirement/union association paths, retain all guards. Start with
   no published program so authorized saves independently produce version one.
   Unlike single-connection SQL tests, HTTP fixtures require isolated committed
   synthetic state; destroy the owned entire runtime afterward, no receipt deletes.
9. Obtain an additional real GoTrue-issued actor-one token with short local
   lifetime, keep it in ephemeral input and wait beyond actual exp plus verifier
   skew. Matrix mode requires that unchanged signed token. Do not hand-sign a
   token or edit its claims to claim actual expiration behavior.
10. Run matrix mode through stdin with five accounts, signup UUIDs,
    expiredIssuedToken, exact immutable image identities and preflight evidence.
    Evidence input is orchestration data, not self-certification: independently
    verify every prerequisite before supplying it. The draft reads no environment
    credentials and writes no file; only sanitized verdict or synthetic IDs print.
11. Independently read persisted two disabled version-one programs, exact
    funding-owner identities/hash, no versions/operations from refused calls,
    no money movement, and complete post-run catalog/migration equivalence.
    The draft's transport result alone does not certify database readback/cleanup.
    Stop/delete only the owned disposable containers/network/volumes. No global
    signout or provider account mutation is needed.

## Integration Boundary

The maintained preflight verifies the restored catalog and then immediately destroys
its database container, private network and scratch directory. This launcher
cannot run after that unchanged preflight returns. A separately reviewed
qualification harness invokes it after the exact catalog comparison and
before the owning cleanup. The main-only, explicitly dispatched
`leaderboard-isolated-auth-qualification.yml` executes that coupled harness;
its full catalog gate cannot be omitted. Source delivery is not runtime proof.

Pass JSON containing the owned `container`, private `scratch`,
`sourceCatalog` path to `source-before.json`, and `authVersions` containing the
freshly captured exact 82-entry metadata inventory. Unset `DATABASE_URL`,
`PGDATABASE`, `PGOPTIONS`, `PGHOST`, `PGUSER` and `PGPASSWORD` before invocation. The launcher
cleans only its Auth/REST/client containers and synthetic secret files; the
owning harness must still remove and verify absence of the database container,
network and scratch, preserving the original failure if cleanup also fails.

## Remaining Runtime Qualification

The exact 82-version metadata inventory and selected immutable official image
digests are now discovered, not runtime-qualified. The adjacent launcher draft
selects Auth v2.197.0 and REST v14.5, explicit Auth `serve`, private networking,
fresh synthetic credentials and the signup fixture adapter. Faithful restore,
actual image/runtime compatibility, final database/catalog readback and complete
owned-runtime cleanup remain unexecuted.
It is executable transport code, not an autonomous launch harness or a certificate.
Production OCI/build/configuration parity remains unknown even if the isolated matrix passes.

## Candidate Metadata And Serve Contract

Auth v2.197.0 index digest:
`sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b`.
REST v14.5 index digest:
`sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9`.
Its Linux/amd64 manifest is
`sha256:bb289d00570b569525e1e22fb77c49cd17c17ca3f41da9ee2b4351a35027551b`.
These were read from official Docker Hub/OCI metadata, not a production key.
PostgREST v14.5 [connection configuration](https://github.com/PostgREST/postgrest/blob/v14.5/src/PostgREST/Config.hs#L547)
sets fallback application-name from `prettyVersion`, which reports only the first
two version components. An explicit application-name can override that fallback.
The observed live 14.5 is version-line self-identification, not proof of the exact
production image, build or configuration. The isolated expiry oracle remains
HTTP 401, `PGRST303`, and `JWT expired` as defined in
[v14.5 error source](https://github.com/PostgREST/postgrest/blob/v14.5/src/PostgREST/Error.hs#L673).
Auth source v2.197.0 contains 75 migration-file versions ending `20260831180000`.
Every version occurs in the retained 82-entry ledger. Seven additional retained
legacy entries are `20171026211738`, `20171026211808`, `20171026211834`,
`20180103212743`, `20180108183307`, `20180119214651`, `20180125194653`.
Their absence from current image files is not permission to delete ledger rows.

[Pinned root command](https://github.com/supabase/auth/blob/v2.197.0/cmd/root_cmd.go)
calls migrate then serve for bare startup.
[Pinned serve command](https://github.com/supabase/auth/blob/v2.197.0/cmd/serve_cmd.go)
calls serve directly without migrate.
[Pinned migrate command](https://github.com/supabase/auth/blob/v2.197.0/cmd/migrate_cmd.go)
constructs an embedded migration box and calls `UpTo(0)`; this launcher never
invokes that command.
[Pinned migration files](https://github.com/supabase/auth/tree/v2.197.0/migrations)
are separate from database history. v2.196.0 omits five applied modern entries;
latest inspected RC v2.198.0-rc.21 includes pending `20260911120000`; neither was
selected. Image migration inventory does not establish production OCI/build identity.

Official source inspected October 6, 2026:
[root command](https://github.com/supabase/auth/blob/master/cmd/root_cmd.go),
[serve command](https://github.com/supabase/auth/blob/master/cmd/serve_cmd.go),
[Dockerfile](https://github.com/supabase/auth/blob/master/Dockerfile).
