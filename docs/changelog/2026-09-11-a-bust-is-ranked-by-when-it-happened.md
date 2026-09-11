# A bust is ranked by when it happened

2026-09-11. `798866ae` (Early Bird Freeroll (NLH)) froze with three players left
and 100.20 in escrow. The investigation (read-only) found four defects. Unblocking
the two stuck players alone would have finished the event and paid about 35.67
of the pool to the wrong people. These fixes are the code half. The migration is
written and proved; a human applies it.

## What was wrong

1. **The door stamped the time it accepted a bust, not the time of the bust.**
   `fn_eliminate_player_legacy_candidate_20260907` (the write half of
   `fn_eliminate_tournament_player_atomic`) set `eliminated_at = now()`.
   `fn_normalize_tournament_final_standings` and
   `fn_prepare_tournament_place_obligations` rank every finishing place from
   `eliminated_at`, and the engine's skip rule assumed the column was the bust
   time. In `798866ae`, 64 of 83 eliminations were recorded more than a minute
   after the bust and 26 more than an hour after, the latest 26h42m. A bust the
   door refused for a while took a better place than everyone who busted after
   it.
2. **The normalizer moved places without moving their prices.** It renumbered
   positions and left `tp.prize` on the player. The place prepare then refused
   the event for ever with `recorded_prize_disagrees_with_structure`.
3. **An orphaned generation blocked a real bust for ever.** The 2026-09-08/09
   rebuy chain bought players back in without resolving the busted knockout
   generation to `rebought`. The door refused each of those players' next real
   bust with `unresolved_knockout_generation_chain`: 356 refusals of `9bb330b7`
   in 39 minutes. At 06:20 UTC four players in two RUNNING events were held
   this way: `798866ae 9bb330b7`, and `7aa16fa7 3a7ad729, f44d72f2, f8058099`.
   Each orphan is followed within seconds by a posted 1.00 `rebuy` leg from
   the player's wallet to the event's prize liability. Separate data repairs
   at 07:04 and 07:23 UTC resolved all four. The door rule below covers the
   next orphan, for example `a5aa6984 dca6c345`, which still holds one.
4. **The engine ordered busts by a different generation than the door
   recorded.** The sweep kept the EARLIEST pending hand per player. The door
   binds the LATEST.

## What changed

- `supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
  replaces three functions with their live bodies plus these changes:
  - **The door stamps the bust hand.** `eliminated_at` is now
    `hand_atomic_commits.committed_at` of the generation the door binds. Players
    busted in the same hand are one microsecond apart per rank: smaller
    hand-start stack first, then user id. A bust whose hand cannot be read is
    refused (`knockout_bust_time_unproven`).
  - **A generation a rebuy paid for is not a live bust.** An older `pending`
    generation is resolved to `rebought` only when a posted `rebuy` leg (player
    wallet to prize liability, same player, same event) was written after that
    generation was captured and before the player's next one. The resolution
    commits with the newer bust and is reported as `rebought_generations`. The
    door refuses anything it cannot prove, exactly as before.
  - **The normalizer re-prices what it moves.** Every moved row gets its new
    place's amount by the place prepare's own rule, in the same write. It
    refuses (`moved_places_cannot_be_repriced_after_money_moved`) once any
    payout or obligation exists for the event. It refuses
    (`moved_places_cannot_be_priced`) when no ladder can be derived. It
    renumbers nothing in either case. Satellites and frozen results are
    unchanged.
- `server/src/tournament/bustOrder.ts`: the sweep orders each bust by the
  player's latest generation, and only when that generation is `pending`.
  Otherwise the order is unknown and the player sorts last.

## Proof

- `scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh` runs eleven
  scenarios against a byte-exact capture of the live bodies. Every FIXED
  scenario must fail there, on a probe assertion. The script then applies the
  migration twice and every scenario must pass. The `accounting_postgres` CI
  job runs it.
- `server/src/tournament/bustOrder.test.ts` covers the engine rule. The old
  earliest-pending rule fails 5 of its 8 tests.
- `tests/a-bust-is-ranked-by-when-it-happened.law.test.ts` pins the migration
  text and the engine source.

## What this does NOT fix

The engine's terminal path is `fn_complete_tournament_terminal` ->
`fn_settle_tournament_places`. It does not rank by `eliminated_at`. It orders
eliminated players by `elimination_sequence`, which a trigger stamps in
RECORDING order, and renumbers positions to that order before it pays. With
this change, `eliminated_at` becomes a true bust time and the prepare/ruling
path uses it. The engine's own finish still pays a late-recorded bust by when it
was recorded. The data repair for `798866ae` has the same limit. It was applied
at 07:04 UTC. Read at 07:23 UTC: the event was RUNNING with one player left,
and 83 of its 85 repaired places disagreed with `elimination_sequence` order.
With no place evidence yet, `fn_settle_tournament_places` would renumber them
back to recording order at the finish: 65f99ae2 to 2nd, 9bb330b7 to 3rd,
9da2d0b7 to 4th. Whether that settlement should rank by the bust time is a
separate decision, and it is urgent for this event.
