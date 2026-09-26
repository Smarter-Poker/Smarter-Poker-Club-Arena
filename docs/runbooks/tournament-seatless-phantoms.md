# TournamentSeatlessPhantoms

Runbook for `TournamentSeatlessPhantoms` in
`infra/monitoring/tournament-rules.yml` (group `tournament-health`). Written
2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-seatless-phantoms`, which has
never served anything.

## What it means

```
poker_tournament_seatless_phantoms > 0   for: 15m   severity: critical
```

An entrant in a RUNNING tournament is `playing` with chips and has no open seat
at any table of that event. They cannot be dealt in and cannot be eliminated,
so the event can never reach one survivor and never pays its champion. On
2026-08-30 this is how 10 of 16 RUNNING MTTs hung, champions unpaid.

## What the expression measures

`fn_tournament_metrics(10, 10, 6)`: `seatless_phantoms` counts
`tournament_players` rows with `status = 'playing'` and `chips > 0` in a
RUNNING tournament where no `table_seats` row with `left_at IS NULL` exists at
a table of that tournament for that user. A restart legitimately produces a
burst while tables rebuild (measured at 47, cleared within three minutes), so
the rule waits fifteen minutes.

**The "seatless-phantom backstop" this alert's description named until
2026-09-26 no longer exists in the engine.** Nothing sweeps these up. A count that stands for fifteen minutes is a
live-path defect in whatever moved or closed that player's seat.

## First checks

1. Who, read-only:
   ```sql
   SELECT tp.tournament_id, t.name, tp.user_id, tp.chips, tp.table_id, tp.seat_number
   FROM tournament_players tp
   JOIN tournaments t ON t.id = tp.tournament_id AND t.status = 'RUNNING'
   WHERE tp.status = 'playing' AND tp.chips > 0
     AND NOT EXISTS (
       SELECT 1 FROM table_seats s JOIN tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = tp.tournament_id AND s.user_id = tp.user_id
         AND s.left_at IS NULL)
   ORDER BY tp.tournament_id;
   ```
2. Where their seat went. The last seat rows for that player in that event:
   ```sql
   SELECT s.table_id, s.seat_number, s.stack, s.joined_at, s.left_at, s.status
   FROM table_seats s JOIN tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = '<tournament_id>' AND s.user_id = '<user_id>'
   ORDER BY s.joined_at DESC LIMIT 5;
   ```
   A seat closed by a table break or rebalance with no seat opened elsewhere
   points at the move; a seat closed at an engine restart points at adoption.
3. The engine log for the event:
   `docker logs --since 2h club-arena-engine 2>&1 | grep <tournament_id> | grep -iE 'move|balance|break|seat' | tail -40`.
4. Check whether it was a restart burst: if the count is falling on its own
   inside a few minutes of a :55 break, it is the rebuild, not a defect.

## Likely causes

- A table break or rebalance that closed the old seat and failed to open the
  new one (the move is `fn_move_tournament_player`; it must be one transaction).
- A seat closed by a cleanup trigger (`trg_release_seats_on_tournament_finish`,
  `trg_clear_seats_on_game_end`) on the wrong condition.
- Re-adoption after a restart that did not restore every seat.

## What not to do

- Do not insert a `table_seats` row by hand to "reseat" a player, and never
  delete one (CLAUDE.md 11.5 rule 3). Seats carry chips.
- Do not eliminate the player to let the event finish. They hold chips; an
  elimination is a result, and a wrong one is money paid to the wrong place.
- Do not bring back a phantom sweep as the fix (10.12). The seat-moving path
  that lost the seat is the fix.
- Horses are players (10.5): a seatless horse is the same defect as a
  seatless human.

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts`, SQL `fn_tournament_metrics`.
- Seat moves and table balancing: `server/src/engine/TableBalancer.ts`,
  `server/src/tournament/TournamentManager.ts`,
  `server/src/tournament/tournamentSeatMoveRpc.ts` (SQL
  `fn_move_tournament_player`).
