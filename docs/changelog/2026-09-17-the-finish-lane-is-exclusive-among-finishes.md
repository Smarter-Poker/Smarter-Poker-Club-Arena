# The finish lane is exclusive among finishes and shared with everyone else

Date: 2026-09-17. One migration, `20260917113717_the_finish_lane_is_exclusive_among_finishes.sql`,
applied through the Supabase MCP at 11:37:17 UTC and recorded in
`supabase_migrations.schema_migrations` under that version (reserved as
20260917082500, renamed to the recorded version). Rollback, byte for byte:
`2026-09-17-the-finish-lane-is-exclusive-among-finishes.rollback.sql`.
Plan and evidence: `docs/terminal-settlement-lane-per-tournament-plan-2026-09-17.md`.

## What was wrong

Every tournament finish (`fn_complete_tournament_terminal`) took the
platform-wide settlement lane exclusively, G and B, held to commit. Every
hand settlement, blind publication, horse seating and rolling authority holds
G shared, so all of them queued behind each finish and the PostgREST pool
(71) filled with waiters. In the three hours before the change the Postgres
log counted 5,000 to 5,900 waits on G over 1 s an hour, 226 to 263 hand
settlements an hour cancelled at the 8 s statement timeout, and 60,000 to
90,000 `F06_RETRY_CANONICAL_LANE` refusals an hour (the F06 source guard's
try-lock on G fails while a finish holds it or waits for it).

## What changed

| path                                             | G (platform) | F (finishes) | B (hands) | T(id)     | was            |
| ------------------------------------------------ | ------------ | ------------ | --------- | --------- | -------------- |
| non-satellite finish                             | shared       | exclusive    | -         | exclusive | G, B exclusive |
| terminal outcome resolver (read-only)            | shared       | -            | -         | exclusive | G, B exclusive |
| satellite finish, cancellation, rare authorities | exclusive    | -            | exclusive | -         | unchanged      |
| rolling authority                                | shared       | -            | -         | exclusive | unchanged      |
| hand settlement                                  | shared       | -            | shared    | shared    | unchanged      |

- `fn_ca_lock_settlement_lane_for_finish(p_tournament_id)`: satellite or
  unknown tournament, the global lane as before; otherwise G shared, F
  (`ca:tournament-finish-lane:v1`) exclusive, T(id) exclusive, and a
  transaction-local `ca.finish_lane_tournament` naming the lane held.
- `fn_complete_tournament_terminal` takes the finish lane; nothing else in
  it changed.
- `fn_ca_lock_settlement_lane_global` re-enters a held finish lane instead
  of upgrading G shared to exclusive, so the 40 KB finish body,
  `fn_settle_tournament_places` and `fn_settle_tournament_rake`, which call
  it again inside the finish, stayed byte-identical.
- `fn_resolve_tournament_terminal_outcome` takes the rolling lane.
- Grants restated: `{postgres, service_role}` on all three, the same as the
  other lane helpers.

The migration refused to run unless every replaced body matched its
reviewed md5, the set of functions naming G was the reviewed set, the three
proof-of-authority guards and the F06 guard accepted T, and no finish lane
existed; after the change it re-proved on the live catalog that only the two
lane helpers take G exclusively, that only the finish lane names F, that no
rolling authority reaches the global lane, and that the non-satellite finish
reaches the global helper only through its six reviewed per-tournament
callees. The whole file was dry-run on production inside a rolled-back
transaction first, with lock probes.

## Verified on production, 11:39 to 11:53 UTC (200 ms pg_locks samples)

- G held exclusively only by `fn_settle_satellite_tournament` (two satellite
  finishes); `fn_complete_tournament_terminal` never appears as a
  G-exclusive holder. F held by one finish at a time, up to 7.9 s for the
  longest.
- 61 tournaments finished in the first 3.7 minutes, 16 a minute, through
  the new lane; no guard refusal, no `finish lane is held` refusal.
- Postgres log per minute, before (11:20 to 11:37) and after (11:38 to
  11:53): waits on G over 1 s, 4 to 205 a minute, then 0 in every minute but
  one (68 at 11:52, below); statement timeouts, 62 in the minute before the
  apply, then 0; hand settlement timeouts 50 then 0; `F06_RETRY_CANONICAL_LANE`
  525 to 2,604 a minute, then 0 to 354, mostly 0.
- Hand settlements waiting on G across the whole window: p50 2.2 s, p90
  4.9 s, max 7.2 s, all of it inside two convoys that are not the finish's:
  at 11:44 a satellite finish (33 waiters, global lane, as designed) and at
  11:52 `fn_spin_expire_unfilled` requesting G exclusively and waiting six
  seconds for the drain while 68 backends queued behind the request. Every
  other minute the queue peaked at 1 to 12.

## What the change exposed: three deadlocks in fifteen minutes

Before: 17 `deadlock detected` in 24 hours, 0 to 5 an hour. After: 3 in 15
minutes, every one with the finish in the cycle, every one on a shared
money row, every one detected in 1 s and retried by its caller (one
`post_commit_obligations_pending` and one `opening_seat_rpc_failed` in the
engine log, both re-driven):

- 11:46:07, `vip_points_carry`: the finish's VIP credit against two hands'
  `fn_ca_process_hand_post_commit_obligations`.
- 11:46:10, `club_wallets`: the finish's rake against a hand's post-commit
  obligations.
- 11:52:59, `club_members`: the finish crediting a winner against
  `fn_seat_horse_in_seat_first_game` debiting the same horse for its next
  Spin.

Hand post-commit obligations take no settlement lane (only a per-table
mutex), so they were never excluded by the finish; they simply rarely
overlapped it while the finish held G exclusively and every hand upstream of
them was queued. Now hands settle during finishes, so their obligations
run during finishes, and the two lock the club wallet, the players' wallets
and the VIP rows in different orders. The finish's own body said this:
"cross-event cycles on shared club, union and recipient wallets" are what
the global lane was for. The next thing (below) is the durable answer; this
change stands because the trade is 3 retried deadlocks in a quarter hour
against 250 cancelled hand settlements an hour and a platform that stalled
40% of the time.

## The next thing

1. One lock order for shared money rows, so the cycles cannot form: the
   club wallet first, then players' `club_members` and `wallets` in
   `user_id` order, then VIP rows, in the finish (`fn_settle_tournament_places`,
   `fn_settle_tournament_rake`, `fn_award_vip_credit`), in hand post-commit
   obligations (`atomic_distribute_rake` and its VIP credit) and in the seat
   purchase (`atomic_deduct_wallet_and_log`). The deadlock detail lines in
   the Postgres log name the exact pairs.
2. `fn_spin_expire_unfilled` cancels unfilled Spins in a loop that takes the
   global lane per Spin. Each call drains the platform once (6 s and 68
   waiters at 11:52). The bounty sweep's 2026-09-10 shape applies: one Spin
   per call under that Spin's finish lane, the engine's loop calling again
   while there is work. Satellite finishes keep the global lane; they are
   two an hour.
3. The longest finishes hold F, and G shared, for up to 8 s; a queued global
   request waits that long and everything queues behind it. Profiling the
   finish body's time (receipt, table closure, `fn_sync_seat_first_player_count`)
   is the other lever.
