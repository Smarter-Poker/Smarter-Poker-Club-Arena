# Lightning 2.0 Phase 1: cash session / cluster integration

2026-09-20. Migration `20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster`.
Branch `agent/claude-lightning-p1/lightning/phase1-cluster-session`.

Phase 1 of the Lightning 2.0 build. The assignment is one sentence: "Wire
Lightning-compatible Cluster/session state into the existing cash foundation.
No matcher yet."

## What was actually missing

Phase 0 reconnaissance (2026-09-17) found that the Lightning specification's
economic boundary, the Cluster, does not exist in the data yet. The
specification's second non-negotiable principle is "one player has one
continuous cash identity per Cluster", and its sixth is "movement within the
same Cluster is not a leave". Today a `cash_player_session` row knows only a
table: `scope_type` is always `'table'`, `scope_id` and `table_id` are both the
table, and a seat move re-points all of them to the destination chair. The row
travels with the chair. Nothing above the chair exists.

`cash_player_session` has carried `CHECK (scope_type IN ('table','cluster'))`
since 20260904120000, with a comment promising a "Slice 6 cutover" to cluster
scope. That cutover never happened. At the time of this change production held
**0** rows with `scope_type='cluster'` and **194** open `'table'` rows.

## What this changes

**`cash_games` gains the Cluster state machine.**

| column              | type    | default       |
| ------------------- | ------- | ------------- |
| `cluster_mode`      | text    | `'must_move'` |
| `lightning_enabled` | boolean | `false`       |
| `cluster_epoch`     | integer | `0`           |

`cash_games_cluster_mode_check` admits the ten states of the specification's
Cluster machine: `created`, `opening`, `must_move`, `pending_on`, `lightning`,
`pending_off`, `draining`, `paused`, `frozen`, `dead`.
`cash_games_cluster_epoch_nonneg` keeps the epoch monotonic-friendly.

**`cash_player_session` gains `cluster_id uuid`,** nullable, backfilled from
`tables.cluster_id`, with the partial index
`cash_player_session_open_by_cluster`. `fn_cash_session_open` now writes it;
its body, its three-argument signature and its `ON CONFLICT DO NOTHING` are
otherwise untouched.

**`fn_cash_cluster_lightning_state(uuid)`** is the single authoritative reader,
so later phases do not each grow a slightly different idea of what mode a
Cluster is in.

## Two decisions worth the reader's time

**The mode is not `cash_games.state`.** That column is derived, not configured.
`fn_cash_cluster_tick` section 7 recomputes it on every five-second pass from
occupancy and writes it back unconditionally, so a Lightning mode parked there
would be destroyed within five seconds. The specification requires the
opposite: "the authoritative mode must always be derivable from persistent
state." Hence a column of its own, beside `must_move` and `enabled`.

**The session was not flipped to `scope_type='cluster'`.** Every reader and
writer of a session filters `scope_type = 'table'`: `fn_cash_session_evaluate`,
`fn_cash_session_add_baseline`, `fn_cash_leave_check`, `fn_cash_session_close`,
the `ON CONFLICT` inference target, both close triggers, and the move and swap
re-points. A cluster-scoped row is invisible to all of them, so its stay clock
would never settle, `leave_locked` would never compute, the rejoin floor and
VPIP bar would never be written, and neither close trigger could reach it: it
would stay open forever. That is the leak 20260910011838 and 20260910012522
were written to close, and it would break
`docs/laws.d/a-session-cannot-outlive-its-seat.md`. Phase 0 also recorded why
the cutover cannot happen yet: "`cash_player_session.table_id` is currently
required. Removing a physical seat before a safe detached-stack owner exists
risks losing the authoritative location of chips." That owner is Phase 5.

So the existing row gains a pointer. Same id, same baseline, same stay clock,
same rejoin window, same closure path. The chair still holds the chips.

## Nothing changes at runtime

Every default is what every existing cluster already is. No threshold is
evaluated (Phase 4), no conversion runs (Phase 5), no matcher exists (Phase 6),
and creation still opens Main 1 (Phase 3). `fn_cash_cluster_tick`,
`fn_cash_clusters_tick_all`, `fn_cash_clusters_to_tick` and
`fn_cash_cluster_open_table` are not edited, so the hot five-second pass is
byte-identical. No TypeScript changed.

## An obligation this hands forward

The backfill is one-shot. `fn_cash_session_open` writes `cluster_id` on INSERT
only, and its `ON CONFLICT DO NOTHING` fallback returns the existing row
untouched. A table adopted into a cluster while somebody is already seated
would therefore leave that open session's `cluster_id` NULL. This was measured,
not assumed: it is not reachable today, because the only NULL-to-cluster
adoption of a seated table was the one-shot `DO` block in 20260905034937, which
has already run, and the move and swap re-points are confined to one game by
`cash_seat_moves.game_id`. **It becomes reachable in Phase 3 (feeder-first
creation) and Phase 5 (conversion), which re-parent tables. Whichever of those
re-parents a table with live sessions owns re-binding them.** The fourth
`@live-proof` is written as a corruption check, not a completeness check, so it
stays honest in the meantime: an unbound session is a gap for a later phase, a
session bound to the _wrong_ cluster is corruption and is refused.

## Qualification

- `scripts/dev/test-lightning-phase1-cluster-session.sh` - real PostgreSQL 17
  via `initdb`, unix socket only. Ten checks: backfill; continuity of `id`,
  `baseline`, `opened_at`, both clocks, rejoin window and `closed_at`; the new
  open path carrying `cluster_id`; an unclustered table still opening a normal
  session; the three defaults; both named CHECKs refusing; all ten modes
  accepted; the reader exact; and idempotent re-apply.
  Each check was verified non-vacuous by mutating a **copy** of the migration -
  deleting the backfill, perturbing `baseline`, dropping `cluster_id` from the
  INSERT, and widening the mode CHECK each produced the expected failure.
- `tests/lightning-phase-1-cluster-session.test.ts` - 24 source-level pins,
  including that the mode did not land in `cash_games.state`, that no session
  is flipped to cluster scope, that the tick path is untouched, and that no
  matcher, threshold or conversion arrived early.
- `scripts/ci/schema-manifest.d/lightning-phase1-cluster-session.json` declares
  the four new columns and the new function.

## Rollback

The three `cash_games` columns and `cash_player_session.cluster_id` are
additive and defaulted; dropping them restores the prior shape exactly.
`fn_cash_session_open` reverts by re-applying the body in
`20260904160500_cash_games_slice_1.sql`. No money moved, so there is no
financial state to reverse.
