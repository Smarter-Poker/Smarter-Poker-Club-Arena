# Hand index writers use one order

The September 13 stats alert beginning at 04:25:07 UTC followed a real index
deadlock. At 04:15:05, PostgreSQL recorded the background
`ca_refresh_hand_player_index` transaction and a live hand projector waiting
on each other's `ca_hand_player_idx` inserts. The same conflict occurred at
03:45. `DISTINCT` removes duplicate rows but does not establish write order.

Migration `20260914194928_hand_index_writers_share_a_canonical_order.sql`
orders the primary-key pairs consistently in all four existing writers. The
two bulk indexers share a nonblocking transaction lock because their forward
and historical windows can overlap in different orders. The single-hand
projectors continue to run concurrently. A busy bulk caller retains its
existing deferred return behavior and advances no cursor.

The migration checks all four complete function hashes, owners and grants
before changing any definition, verifies each resulting hash, and accepts an
exact repeated application. An unexpected function body or grant aborts the
whole migration. It changes no UUID predicate, cursor coverage, index key,
financial arithmetic, hand receipt, outbox claim or permission.

The committed native runner reproduced the original unique-index deadlock
using the captured production function bodies. Its 48 checks cover both
execution orders against each bulk writer, the legacy trigger, competing
bulk calls, rollback, forward and backward coverage, duplicate and malformed
identities, permissions, repeat application and rejected source/grant drift.
Root TypeScript checking also passed. Tests used the existing PostgreSQL
17.11 installation on macOS arm64, without production connections.

This is bounded index-concurrency evidence. The private fixture chooses a
legal hash-aggregation plan, uses the projector's Diamond branch to avoid
unrelated aggregates, and supplies an empty per-hand-facts relation. It does
not qualify the complete financial projection chain, Linux runtime, rollout
or production behavior. The separately observed `ca_hand_player_stat`
rollup deadlock and `player_stats` settlement conflict remain separate work.

Current delivery uses the companion probe in the existing GitHub-hosted
accounting_postgres job, qualifies the wider projection dependencies and installs
through the existing root-controlled migration path. Verify function hashes and
natural index progress separately. This historical local result is not hosted
qualification or production incident closure; no retired local pipeline is used.
