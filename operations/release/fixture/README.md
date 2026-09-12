# Isolated component fixture image

This is the build and native smoke package for the real fixture services used by
`operations/release/native/qualify-components.py`. It contains PostgreSQL,
GoTrue, PostgREST, Supabase Realtime, and Chromium. API responses are not mocked.
Only synthetic credentials are created at runtime. Candidate frontend, engine,
and schema artifacts are inputs to the separate trusted runtime/controller.

**Status: native service smoke passed; full application qualification remains incomplete.**
[Linux run 34660221728](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34660221728)
at `ef6ab8d71b60fe67af5fc978148b9bacb64f9686` passed PostgreSQL 17.11,
six extensions and a real wal2json slot, the exact Auth migration ledger,
sign-in/TOTP MFA, PostgREST authentication/RLS, authenticated Realtime change
delivery through the gateway, Chromium, and separate-user/peer isolation with
zero retries. Its receipt verifies that the fixture container, peer, network
and image were removed. The tested local image ID was
`sha256:89229ac114d7f158bb71b0c46a805002927eafca4f53bedfadeed3e49105ec9b`;
it was not published. The receipt explicitly records `product_certificate: false`.
The full current application schema/ACL contract, before/intermediate/after
engine and frontend combinations, immutable image publication and controller
admission remain separate requirements.

## Pinned inputs

The Dockerfile pins Linux amd64 platform manifests, verified through the official
Docker Registry API on 2026-09-11. Other architectures deliberately fail closed.

| Input             | Version                | Linux amd64 manifest digest                                               |
| ----------------- | ---------------------- | ------------------------------------------------------------------------- |
| Official Node     | 22.23.2, bookworm-slim | `sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96` |
| Supabase GoTrue   | v2.196.0               | `sha256:7e813221b93fbf54b515036438550e483bfaf057b9db52fe9bc1ce91c47e817e` |
| PostgREST         | v14.5                  | `sha256:bb289d00570b569525e1e22fb77c49cd17c17ca3f41da9ee2b4351a35027551b` |
| Supabase Realtime | v2.134.10              | `sha256:c1d078d929608f3eb4d441e30317bbdccc1bfcc1169efa3d1a26d4252417cc76` |

Realtime's official image supplies its matching Debian trixie runtime and Erlang
release. The [tagged upstream Dockerfile](https://github.com/supabase/realtime/blob/v2.134.10/Dockerfile)
documents that layout. GoTrue is copied as the upstream static Go binary; the
[tagged build](https://github.com/supabase/auth/blob/v2.196.0/Dockerfile)
sets `CGO_ENABLED=0`. The PostgREST amd64 image supplies `/bin/postgrest`, the
[upstream static build](https://github.com/PostgREST/postgrest/blob/v14.5/nix/tools/docker/default.nix).
No Alpine libc or independent Erlang installation is copied into Debian.

PostgreSQL server/client/libpq are **17.11-0+deb13u1**, and pgvector is **0.8.0-1**.
Realtime's logical replication also requires **postgresql-17-wal2json=2.6-2+b1**.
The [Debian amd64 package record](https://packages.debian.org/trixie/amd64/postgresql-17-wal2json/download)
lists SHA-256 `70371bb2072d904ad381d29df2c50f5f2fe8c12583bc0207336b2d5772a0ac36`;
its [file inventory](https://packages.debian.org/trixie/amd64/postgresql-17-wal2json/filelist)
includes `/usr/lib/postgresql/17/lib/wal2json.so`. The build uses the same signed
snapshot and the native smoke must create and drop a real temporary logical
slot using this plugin before exercising Realtime. The earlier image build
passed the file check; run `34660221728` also passed native slot creation and removal.
PostgreSQL 17.11 also checks the explicit
[`output_plugin_libraries` trust list](https://www.postgresql.org/docs/17/runtime-config-replication.html#GUC-OUTPUT-PLUGIN-LIBRARIES),
including for superusers. Both fixture startup paths set it to
`pgoutput,wal2json`: the built-in replication plugin and the pinned Realtime
plugin only. The unused `test_decoding` default is excluded. The native smoke
asserts this exact live setting before creating, inspecting and dropping its
temporary wal2json slot. No privilege increase or plugin-check bypass is used.
Both APT sources are frozen at `20260910T000000Z` in the official
[Debian snapshot archive](https://snapshot.debian.org/). The exact versions were
verified in its `trixie` and `trixie-security` amd64 package indexes. Package
signature verification stays enabled; only the historical Release expiry check
is disabled. PostgreSQL's package supplies the required contrib extensions;
the image build checks for dblink, pg_stat_statements, pg_trgm, pgcrypto,
uuid-ossp, and vector control files, and the native smoke creates all six.

The minimal Realtime base does not provide a working system CA bundle for the
HTTPS package-index fetch. Bootstrap that bundle from the pinned official Node
binary's [bundled Mozilla roots](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsrootcertificates),
then install Debian's signed `ca-certificates` package. TLS peer verification
and APT signature verification stay enabled. Package-index failures terminate
the build immediately instead of appearing later as missing dependencies.

The npm lock pins `@playwright/test` 1.58.0, `pg` 8.20.0, and `tsx` 4.23.13,
including package integrity hashes. The locked Playwright browser revision is
installed at build time; its [Debian 13 dependencies](https://github.com/microsoft/playwright/blob/v1.58.0/packages/playwright-core/src/server/registry/nativeDeps.ts)
come from the same dated APT snapshot. Nothing installs packages at runtime.
The final built image identity must be recorded and admitted by immutable OCI
digest; these base-image pins are not that final image's identity.

## Runtime interface

The image's entrypoint is `tini -s -g --`; the driver supplies the fixed
`fixture-server` command and subcommand. The wrapper invokes the reviewed
`/opt/qualification/runtime/fixture-server.mjs`. The build copies only the
explicit runtime modules, manifests and smoke tool, through an allowlisted tar
context. It does not send the repository, `.env`, schema dump, Git metadata or
candidate artifacts to Docker.

| Purpose                 | Fixed path                                                            |
| ----------------------- | --------------------------------------------------------------------- |
| Node                    | `/usr/local/bin/node`                                                 |
| PostgreSQL 17           | `/usr/lib/postgresql/17/bin/{initdb,postgres,pg_ctl,psql,pg_isready}` |
| GoTrue                  | `/usr/local/bin/auth`                                                 |
| PostgREST               | `/usr/local/bin/postgrest`                                            |
| Realtime                | `/app/bin/{migrate,realtime,server}`                                  |
| Trusted runtime modules | `/opt/qualification/runtime/`                                         |
| tsx and Playwright      | `/opt/qualification/node_modules/.bin/`                               |
| Chromium                | resolved by locked Playwright under `/opt/qualification/browsers`     |
| PostgreSQL socket       | `/run/postgresql`                                                     |

The default OS user is `fixture`, UID/GID **1000**, and the independent oracle is
`qualification`, UID/GID **1001**, with no shared supplementary group. PostgreSQL
runs as fixture and uses database superuser `postgres`. Only fixture maps to
postgres; its socket directory is mode 0700. The observer has no database role,
password or PostgreSQL socket access. Browser/engine roles keep their actual
RLS behavior. Default PUBLIC CONNECT on the other cluster databases is revoked.

The observer connects to `/run/fixture-observer/observation.sock`. This bridge
owns a separate private database connection and accepts only bounded catalogue,
hand-presence and hand-facts requests. The trusted mounted controls define the
queries and independent assertions. Each start binds a fresh instance UUID,
the immutable `/inputs/observation-control.json` control revision, seeded table
and spectator. The first future hand tuple binds subsequent reads to that same
hand and original persistence deadline. No request can supply SQL, identifiers,
credentials, alternate helpers or a product pass verdict. The runtime preserves
schema exclusions; neither this bridge nor a successful service smoke certifies
an incomplete application database contract.

Use read-only root, all capabilities dropped, no-new-privileges, no egress, no
host ports, and no Docker socket. Tmpfs mounts replace image directory ownership:

```text
/tmp:rw,nosuid,mode=1777,uid=1000,gid=1000,size=2g
/run:rw,nosuid,mode=0755,uid=1000,gid=1000,size=2g
/run/fixture-observer:rw,nosuid,noexec,mode=2750,uid=1000,gid=1001,size=1m
/var/lib/postgresql:rw,nosuid,mode=0700,uid=1000,gid=1000,size=4g
```

Set `net.ipv4.ip_unprivileged_port_start=0` explicitly for port 443. The
supervisor creates private mode-0700 service state under `/run`; only the
intended browser fixture state is observer-readable. Oracle `docker exec` uses
`--user qualification --env HOME=/tmp/qualification
--env XDG_CACHE_HOME=/tmp/qualification/cache`. The supervisor uses
`/tmp/fixture`; Realtime temporary configuration and crash output use that
private location. The supervisor creates a fresh `/tmp/fixture/.erlang.cookie`,
owned by fixture with mode 0400, beneath its verified mode-0700 home. OTP reads
that file itself; no cookie value is supplied through `RELEASE_COOKIE` or process
arguments. The image's unused baked cookie stays root/fixture-readable only.
Its pgdelta cache is expanded during build, so invoking the
real Realtime migrations does not try to write beneath read-only `/app`.

The Docker build calls `adaptRealtimeLauncher()` from the trusted runtime
module. It accepts only the entire pinned Elixir 1.19.5 generated launcher
(SHA256 `b35710db4fe3c141340dac83d02fbe9d3c8407ff600eb98915f54feb69e227a9`)
and Realtime v2.134.10 release environment
(`3fbe75e1c0ea82357e01a38af7666f2f54fac8e389c303084a45a48aeb178121`).
Any mismatch fails the build before modification. Its counted replacements
remove the cookie environment fallback and all four cookie argument sites;
an explicit `RELEASE_COOKIE` now fails with a constant error. No compiled
Erlang application or authentication implementation is replaced.

The pinned [Realtime release environment](https://github.com/supabase/realtime/blob/v2.134.10/rel/env.sh.eex)
forces named distribution. The fixture therefore explicitly uses `name`,
preserving that actual upstream behavior instead of claiming `none` took effect.
The [Elixir launcher](https://github.com/elixir-lang/elixir/blob/v1.19.5/lib/mix/lib/mix/tasks/release.init.ex)
otherwise converts its cookie option into readable process arguments. Without
that option, [OTP 28's authentication server](https://github.com/erlang/otp/blob/OTP-28.5.0.4/lib/kernel/src/auth.erl)
loads the private home cookie and preserves genuine node/gen_rpc authentication.
Pinned Realtime `config/runtime.exs`, `config/config.exs` and `config/prod.exs`
do not read `RELEASE_COOKIE` or configure `gen_rpc.secret_cookie`. Its lock pins
[gen_rpc authentication](https://github.com/emqx/gen_rpc/blob/891f90d713e83e3fca049345fb641afd9a1def28/src/gen_rpc_auth.erl#L500),
which defaults to the OTP cookie when no application-level override is set.
The dependency application defaults do not set an override or enable insecure
authentication fallback.

The native smoke must authenticate an actual RPC to the running named node and
require the expected named node, compare both OTP and gen_rpc cookie hashes
with the generated-file hash, and require no cookie override or insecure
authentication fallback. It then keeps all
UID 1001 environment/file/socket/argument denials and additionally denies the
home cookie file. No cookie, authentication environment, or raw service log is
printed. The shell tests use a capture executable only to inspect launcher
arguments; they do not claim native Erlang, database, or browser proof.

The build also calls `adaptRealtimeConfiguration()`. It accepts only the entire
pinned `config/runtime.exs` (SHA256
`6892bee389b9974972ece8e8737d2cdbe8bac50e82f2776037641e786b16d84c`) at the fixed
release path and applies two bounded changes: `{:ip, {127, 0, 0, 1}}` in its
HTTP socket options and `channel_name: "fixture_realtime_cluster"` in its
PostgreSQL discovery strategy.
The default upstream listener otherwise exposes port4000 to peer containers;
the genuine tenant-administration JWT verifier accepts the synthetic service
JWT used by the engine. Binding loopback makes the existing gateway's tenant
administration refusal the peer-container boundary without changing player,
service or tenant JWT authority. No undocumented bind-address environment
variable or replacement service is used.

The pinned discovery strategy otherwise derives its PostgreSQL LISTEN channel
from the OTP cookie. The fixture's 96-character private cookie exceeds the
pinned Postgrex driver's 63-byte channel-name limit, causing repeated cluster
strategy failures and eventual listener shutdown. The fixed discovery channel
keeps that cookie private and unchanged. The native cookie RPC separately
asserts that the configured discovery channel equals the fixed value, without
printing either cookie or configuration values. Run `34660221728` verified
the real listener and subsequent causal event after this correction.

Both full runtime and native smoke inspect the actual Linux `/proc/net/tcp` and
`tcp6` tables after service readiness, requiring exactly one port4000 listener
at IPv4 127.0.0.1 and no IPv6 listener. Native smoke uses the actual gateway for
the genuine authenticated Realtime subscription and causal database change;
it separately requires administration refusal with service and player tokens.
A separate same-image UID1000 container proves gateway reachability, requires
direct port4000 `ECONNREFUSED` (DNS failures/timeouts do not count), and requires
gateway tenant-administration refusal. This peer receives no service secrets,
fixture mounts or oracle descriptor. Same-container loopback access remains
intentional and is not described as denied.

Listener inspection failures retain only a fixed reason (`header`, `row-shape`,
`address-shape` or `listener-set`) and bounded counts for expected IPv4 loopback,
other IPv4 and IPv6 listeners. Neither socket addresses nor raw namespace tables
enter the failure receipt. The one-loopback-listener requirement stays enforced.

## Genuine service bootstrap

1. Initialize a new PG17 database `club_arena_qualification`, local roles and
   required extensions. Enable logical WAL and adequate replication slots;
   preload pg_stat_statements. Create `auth` owned by supabase_auth_admin.
   Set that role's search path to `auth`, matching the
   [upstream Auth role setup](https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000001-auth-schema.sql).
   The pinned GoTrue/Pop migrator uses an unqualified migration-ledger name;
   its template namespace setting does not change the connection search path.
   The native check verifies the actual Auth login targets `auth` and has no
   CREATE permission on `public` before running the unchanged migration command.
2. With synthetic `GOTRUE_DB_DATABASE_URL` and local auth configuration, run
   `/usr/local/bin/auth migrate`. This runs the
   [upstream embedded migrations](https://github.com/supabase/auth/blob/v2.196.0/cmd/migrate_cmd.go).
   Apply the reviewed app schema only after those succeed; do not replace the
   GoTrue-owned schema with an old dump lacking its migration ledger. Start
   `/usr/local/bin/auth serve`, then create users and MFA through its real API.
   Both paths require the exact 70-version migration ledger from v2.196.0,
   including `00`; partial, replaced or fabricated extra versions fail.
   TOTP enrollment returns an SVG QR image from the pinned Auth API. Read that
   response through a 1 MiB streaming byte limit; all other Auth responses keep
   a 128 KiB limit. Oversized streams are cancelled before their full body is
   buffered. No QR secret, response body, token or factor identifier is logged.
3. Start `/usr/local/bin/postgrest` with synthetic local DB/JWT configuration.
4. Run `/app/bin/migrate`, then `/app/bin/realtime eval
'Realtime.Release.seeds(Realtime.Repo)'`, then `/app/bin/server`. These are
   [upstream release commands](https://github.com/supabase/realtime/blob/v2.134.10/run.sh),
   called directly without sudo, the image's upstream launcher, or its cloud
   secret hooks. Set `SELF_HOST_TENANT_NAME=realtime-dev`, matching the gateway's
   fixed `realtime-dev.supabase-realtime` host. Supply only runtime-generated
   DB/JWT/encryption/metrics secrets. Seed exit zero alone is insufficient:
   the upstream seed logs some tenant failures, so validate the tenant, health,
   real authenticated subscription, and actual database change.

The root-owned runtime and schema provenance remain authoritative for complete
fixture bootstrapping. This package's tiny native SQL table checks protocols and
binaries; it does not claim equivalence to the application schema.

Both bootstrap paths attach database error ownership before connecting. An idle
driver failure retires full-runtime readiness and aborts an in-flight service
command without exposing driver messages. Shutdown collects owned children and
joins all database connection closes within the fixed database deadline. The
native wire regression exercises the pinned pg driver and an actual child in
both paths; it is failure-handling evidence, not an application database pass.

Full-runtime shutdown attempts readiness removal, actor, gateway, bridge and
supervisor closure independently. An earlier synchronous or asynchronous close
failure cannot skip later owned cleanup. A 25-second aggregate deadline exceeds
the supervisor's child and database deadlines; any failure or unobserved close
refuses completion. The outer driver still removes the exact owned containers
and verifies absence. Native-child regressions exercise failed and hung closes.

## Credential-free Linux CI path

Install dependencies and build the Linux image in CI. Do not run `npm ci`,
install full dependency trees, or copy `node_modules` into Mac agent worktrees.
Local source checks may reuse an existing shared installation without changing
its packages; preserve the repository's normal commit and push hooks.

After the normal draft PR includes the complete reviewed runtime files, use a
native Linux amd64 Docker runner with repository read permission and no secrets.
Do not use a privileged production runner or a workflow-dispatch workaround.

```bash
bash operations/release/fixture/build-image.sh club-arena-component-fixture:ci
bash operations/release/fixture/smoke-image.sh club-arena-component-fixture:ci
```

The build refuses untracked/missing runtime sources and a dirty fixture tree.
It labels the image with the exact checked-out commit and never pushes. The
smoke uses the local immutable image ID and a fresh internal Docker network
with no egress or published ports. Only the fixture and its separate refusal
probe peer join that network. It checks six real extensions,
GoTrue migrations/users/TOTP to AAL2, PostgREST authentication/RLS, a causal
Realtime database event, separate-user credential denial and read-only SQL,
and Chromium fetching the authenticated native endpoint. It creates no trace,
video, external fixture or credentials artifact. Output is bounded status,
version/count facts; raw logs and session values stay in disposable memory.
Readiness is bounded; failed services, browsers and assertions are never retried.
The enclosing script removes both exact containers and their network, then
verifies absence even on failure. No success statement is printed until that
cleanup succeeds. The outer runner also records and checks all three absences.

For a runner-owned timeout cleanup, set `FIXTURE_SMOKE_CONTAINER` to exactly
`ca-fixture-smoke-` followed by 32 lowercase hexadecimal characters. Without the
override the script generates a UUID hex suffix. The peer/network names append
`-peer`/`-network`. Occupied names are refused before cleanup is armed, so the
script cannot remove a pre-existing resource.
Image labels `com.smarter-poker.control-revision` and
`com.smarter-poker.source-revision` both bind the reviewed checkout revision.

Only after native smoke succeeds may the independent full semantic driver run
the before/intermediate/after artifact combinations and prove their cleanup.
Image publication and controller admission are separate root-owned decisions;
this package does not perform them.

## Synthetic actors

The real Auth API creates the three fixture users under the existing
`@smarter-poker.invalid` certification domain. Their distinct `poker_alias`
values fit the signup trigger's 15-character limit; the generic `username`
metadata field is not that trigger's alias input. The spectator enrolls MFA
before setup. Verified Auth JWTs supply each user's session identity; the seed
requires the corresponding live `auth.sessions` row and AAL before using it.

`seed-fixture.mjs` uses `fn_create_club_atomic`, `fn_join_club`,
`fn_club_bank_send`, `fn_cash_game_create` and `atomic_table_buyin` with each
actual user's authenticated session context. It preserves and reconciles the
canonical 100,000-chip opening grant, funds each actor with 2,000 chips, and buys
each seat in for 200. It does not insert club memberships or mint a second
opening supply. Each operation has its own serializable transaction so local
ledger/authorization settings cannot leak between RPCs. A session advisory lock
owns setup, and all constraints are forced before every commit. Previously
committed synthetic setup is removed with the owned fixture if a later step
fails; no partially initialized identity becomes ready. A nonempty database
cannot be seeded again. Source/SQL-layer checks do not qualify full Auth,
application-schema parity or an engine hand.

After the three-player seed, the real Auth admin API creates one additional
disabled identity at the ledger writer's source-defined attribution UUID.
`chip_ledger.performed_by` references `auth.users`; a legacy `public.users` row
alone cannot satisfy that constraint. This synthetic identity has a distinct
fixture alias and a 100-year ban. GoTrue generates an unknown password when
none is supplied. The fixture requires GoTrue's exact `user_banned` response,
then verifies the persisted ban, zero sessions and zero refresh tokens. The
full runtime also checks that this signup added no club membership, seat or
chip supply. Canonical signup triggers remain enabled; the service JWT retains
no subject and ledger functions are unchanged. The native service smoke covers
the real Auth API behavior; full-schema cashout qualification is separate.

`actors.mjs` exports async `startFixtureActors({tableId, users, onFailure})`,
returning `{close()}` after both authenticated subscriptions and initial native
snapshots arrive. Supply exactly two real GoTrue sessions after the engine is
ready. The only production endpoints are `ws://engine:8080/ws/multi?v=0` and
`http://engine:8080/action`. A separate optional testEndpoints argument rejects
anything except matching explicit `127.0.0.1` HTTP/WS ports.

The runner consumes the engine's public SNAPSHOT/DELTA sequence and opaque
`action_context`; EVENT/USER_EVENT never substitutes for that state. It checks
when no chips are due, calls a covered amount, and otherwise folds. It posts
one UUID per observed decision, waits at least 350 ms before submission to
respect the native 250 ms rate limit, and re-reads the decision after waiting.
There is no retry, reconnect, action fallback, seat write or SQL action. A
broken/silent socket, malformed/gapped state, unknown frame or rejected action
closes both actors and reports a fixed sanitized failure code. Startup is
bounded to 20 seconds, silence to 45 seconds, and total life to 240 seconds.
The driver removes the exact fixture container when the independent product
oracle finishes; the supervisor closes actors on its own termination path.

`actors.test.mjs` uses real loopback HTTP/WebSocket transport with small protocol
fixtures and the repository's `ws` dependency. Its passing result is a boundary
check, never proof that a candidate engine completed a real hand. The native
Linux semantic matrix supplies that proof.
