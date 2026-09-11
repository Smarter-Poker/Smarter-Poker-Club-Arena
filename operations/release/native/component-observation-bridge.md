# Fixed-query observation bridge — native qualification pending

The bridge and runtime integration are implemented source. A passing native
service smoke and the complete schema/web/engine matrix remain required. The
schema contract's exclusions must not be closed by bridge or transport tests.

## Runtime interface

`startObservationBridge({db,binding,onFailure})` returns `{binding,close}`. The
trusted runtime supplies a separately connected private `pg.Client` exclusively
owned by the bridge. Binding contains exactly version1, a fresh instance UUID,
control SHA, seeded table ID and spectator ID. `/inputs/observation-control.json`
comes from verified control HEAD, independently of the schema source revision.
The public fixture descriptor includes that binding and the fixed socket path
`/run/fixture-observer/observation.sock`. The bridge starts after schema and seed,
before the engine/actors; `close()` owns database connection shutdown.

Only the bridge implementation belongs in the fixture image. Its protocol and
query helpers load from exact read-only mounted controls. No candidate or
environment input selects an import path. A separate source-only test harness
can supply temporary paths/current IDs and real helpers; production supplies
no harness argument.

## Process and filesystem boundary

The fixture service container runs as UID1000. The trusted oracle runs as
UID/GID1001 without supplementary group1000. The **candidate engine runs in a
separate container**, with its own mount and PID namespaces and no shared
fixture mounts. Its numeric UID1000 does not make it a fixture process.

The driver creates `/run/fixture-observer` as tmpfs UID1000/GID1001/mode2750.
The bridge validates that parent, creates a socket inheriting GID1001 and sets
mode0660. Both ends check ownership, mode, type and absence of symlinks. These
are Linux filesystem checks, not a claimed Node peer-credential API. The oracle
cannot create/unlink the socket. It has no PostgreSQL role, password or socket
access. PostgreSQL's socket/data and runtime secrets remain private; application
ACLs are preserved. The candidate receives only its synthetic application key.

## Protocol and query boundaries

Three reads exist: `catalogue`, `hand_presence`, `hand_facts`. Requests are
newline-framed, at most4096bytes, with exact keys/binding, unique request IDs,
one request per socket, max256 requests, max4 connections and one active read.
Replies are at most65536bytes and contain allowlisted facts, never pass flags.
The startup hand high-water mark rejects historical hands. The first future
hand tuple binds all subsequent reads and their original15second deadline.

Queries run in repeatable-read, read-only transactions with pg_catalog search
path, row_security off, statements bounded to5seconds and overall reads6seconds
(also bounded by remaining persistence time). Base relations are locked then
checked for expected pg_catalog types before parameterized hand/seat queries;
views or substituted types fail. Catalogue deparsing uses a canonical search
path. Producers must use the same exact helper for their expected digest.

The oracle derives success from actual returned row counts, monetary values,
action/player counts and spectator absence. It also checks the catalogue before
and after application execution. This is a compatibility/correctness oracle;
it is not a claim to validate complete poker accounting or every malicious
engine's fabricated-but-accepted application data.

## Required native evidence

The service smoke checks UID1001 file/environment/argument/socket denials and
the real bridge with explicitly synthetic protocol rows. It emits only a
`native-service-smoke` receipt, never a product certificate. It also proves the
Realtime listener is loopback-only and a separate engine-shaped peer cannot
bypass gateway tenant-administration denial. Same-container loopback access is
intentional. Passing local source/transport tests are not native Linux proof.

The full product driver must subsequently restore a qualified exact schema and
run every pinned before/intermediate/after combination, with genuine gameplay,
browser observations, matching persisted hands and verified container/network/
image cleanup. No production activation follows from this source preparation.
