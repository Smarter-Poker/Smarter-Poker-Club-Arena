# Fixed-query observation bridge - unqualified source handoff

Base committed controller: 81c60208519c3cf63f8af70118dbe471f4e8b447. These follow-up files are uncommitted permitted staging; the external worktree is preserved. No production or remote publication action occurred.

## Runtime interface

startObservationBridge({db,binding,onFailure}) returns {binding,close}. Runtime supplies a separately connected private pg.Client exclusively owned by the bridge. Binding has exactly version:1, fresh instance_id UUID, control_sha, seeded table_id and spectator_user_id. The final fixed driver input is /inputs/observation-control.json with exactly version:1 and control_sha from verified control HEAD. It is independent of schema source SHA. Public fixture.observation_bridge contains binding plus socket:/run/fixture-observer/observation.sock. Start bridge after schema and seed, before engine/actors. close owns db.end.

Only observation-bridge.mjs belongs in the fixture image. It imports component-observation-protocol.mjs and component-semantic-observations.mjs from the exact mounted trusted controls. No candidate/environment import path is accepted. A second source-only test harness argument provides temporary socket paths/current UID and real helper modules for native workstation tests; runtime must not supply it.

Driver creates fresh /run/fixture-observer tmpfs uid1000,gid1001,mode2750. Bridge never chmods parent; socket must inherit gid1001 and is chmod0660 with strict lstat checks. This uses Linux filesystem access control, not a claimed Node peer-credential check. Runtime must remove oracle PostgreSQL roles/HBA mappings/credentials and keep PostgreSQL socket/data directories private0700. Application ACLs stay unchanged. Root owns that runtime/packaging glue; it is not in this archive.

## Protocol and query boundaries

Three reads only: catalogue, hand_presence, hand_facts. Requests are newline-framed, at most4096bytes, exact-key and exact-binding validated, one per socket, unique request IDs, max256 requests, max4 connections and one active read. Replies are at most65536bytes and contain raw allowlisted facts, not pass flags. Errors expose fixed categories only. First future hand tuple binds permanently across clients and opens one15second persistence deadline. The startup table hand high-water mark rejects historical hands. The oracle derives success from returned counts, monetary values, action/player counts and spectator absence.

Bridge starts repeatable-read read-only transactions, sets pg_catalog search path/row_security off, bounds statements at5seconds and overall reads6seconds (also bounded by remaining persistence time). Base relations are locked then checked for expected pg_catalog types before fixed parameterized hand/seat reads; views/type substitution fail. Catalogue deparse now canonicalizes search_path to pg_catalog and restores caller setting, fixing a producer/bridge digest mismatch found in native testing. Producers must recompute the catalogue with this exact helper.

## Evidence and unresolved verification

Before permissions narrowed:8 Unix-socket tests passed;3of4 native PostgreSQL tests passed (view substitution, read-only query enforcement, backend death). The facts test failed on search-path-dependent catalogue digest. That source fix is included but has NOT passed a new native run.

Under current sandbox: Unix listen fails EPERM and PostgreSQL initdb shmget is prohibited. The attempted native run failed at those environment boundaries. No bypass was attempted. Current source passes5 nonnetwork protocol/source-contract tests,6 driver boundary tests, and JavaScript syntax checks.

Owner must rerun observation-bridge.test.mjs and observation-bridge.native.test.mjs plus component-semantic.native.test.mjs in an authorized environment. Actual Linux distinct UID/GID socket DAC, packaged services, runtime shutdown, browser/engine/schema tuple execution and clean container teardown remain UNVERIFIED. This is source preparation, not a passing qualification or completion claim.
