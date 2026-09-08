# Lease heartbeat locks delayed unrelated tables

## Production evidence, 2026-09-08 22:03-22:08 UTC

The running engine was `54ed5bc1`. After the normal 22:00 thaw, 1,819 observed
next-hand gaps had a median of 7,970ms and p90 of 15,473ms. The largest measured
phase medians were post-commit obligations (4,707ms), post-hand tasks (2,901ms),
next-hand inputs (1,606ms), and seat-move announcements (1,209ms). These phases
are sampled independently; their medians must not be added as one hand.

A database activity sample found 33 transactions waiting on transaction-ID
locks. A second sample resolved the blockers: cash and tournament fleet
heartbeats waited on `fn_ca_commit_hand_settlement`, while additional hand
commits and tournament request hooks waited behind those heartbeats. The
heartbeat's single UPDATE locked many lease rows until the entire batch
committed. A settlement at one table could therefore queue unrelated tables
and managers behind the heartbeat. This is a measured delay mechanism, not a
claim that every slow hand had the same cause.

## Change

`heartbeat_table_leases_v4` and `heartbeat_tournament_leases_v4` first select
eligible exact generations with `FOR NO KEY UPDATE SKIP LOCKED`, then renew
only those rows in the same transaction. A locked row returns `busy` without
changing its heartbeat. Missing, stale, foreign, malformed and duplicate
claims retain the existing refusal behavior. The 30-second takeover boundary
and every settlement/request shared lock remain in force.

Both engine lease clients recognize an exact `busy` response as uncertainty:
no renewal proof, no new deadline. GameServer already rechecks the old
monotonic deadline after every response and the existing expiry timers remain
armed. An incorrect generation in a busy response still fails closed.

The new RPC version prevents an intermediate deployment from breaking the
running v3 client. The additive migration can be installed first. Only an
engine build containing the new client adopts v4 at the ordinary scheduled
cutover. v3 and its grants are untouched. No balance, seat, settlement payload,
player reconnect allowance, or lifecycle takeover permission changes.

PostgreSQL 17 references reviewed:

- https://www.postgresql.org/docs/17/explicit-locking.html
- https://www.postgresql.org/docs/17/sql-select.html

## Verification

The CI-integrated PostgreSQL probe applies the actual new migration beside
the actual v3 functions in an isolated schema. Two concurrent sessions hold
a settlement-style shared lease lock and attempt heartbeats. The v3 call
reproduces SQLSTATE 55P03 under a 250ms lock budget; v4 returns busy for that
row and renews the free row. The busy timestamp is unchanged. A concurrent
generation update is still blocked, and retry renews after the lock releases.
The probe also checks stale generations, foreign owners, wrong generations,
missing rows, malformed/duplicate claims, stale-window overrides and grants.
All 40 assertions passed on isolated PostgreSQL 17.

Six focused engine suites passed all 115 tests, including ten new cases for
mixed busy/kept replies, repeated busy replies beyond the old deadline, and
invalid busy generations. Existing real-engine proof-expiry tests pass.
Server TypeScript compilation passed. No production gameplay mutation was
used as a test.

## Release and remaining acceptance

At this checkpoint the fix is tested locally; production adoption is not yet
claimed. Confirm the additive RPC definitions and grants after migration,
the PR and publisher results, and the actual running engine SHA after the
next scheduled cutover. Then sample hand gaps and heartbeat lock waits again.
A lower database wait does not verify iPad Home Screen entry, WebSocket
restoration, Rabbit Hunt interaction, or a paid seat purchase. Browser CDP
verification remained unavailable at 21:58 UTC; those end-to-end claims remain
open.

## Database installation, 22:20 UTC

Migration catalog version `20260908222053`, name
`lease_heartbeats_skip_busy_generations`, applied successfully. Both deployed
v4 function bodies match the reviewed file exactly. Source MD5:

- Cash: `49e7702d7cace6b55a995af41b83f849`.
- Tournament: `5e6c99545e07c21efcb50e5cb3441c14`.

Both remain SECURITY DEFINER, executable by service_role, with anon and
authenticated execution denied. The existing v3 source hashes are unchanged:
`9bc1e3f3130dad8d809091412423e497` and
`1ee7667403da21d5b449c3f0f3880d7b`. Installing these functions alone does not
change the running engine's heartbeat calls.
