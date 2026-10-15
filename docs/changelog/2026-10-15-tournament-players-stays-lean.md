# Tournament Players Stays Lean (2026-10-15)

Phase 8 of the tournament hardening.

## Measured On Production

`tournament_players` is updated on every tournament hand: chips, status, table and seat.

| Reading    | Value                                               |
| ---------- | --------------------------------------------------- |
| Live rows  | 1,938,588                                           |
| Dead rows  | 351,830 (18.1%)                                     |
| Heap       | 508 MB                                              |
| Indexes    | 1.4 GB (15 indexes)                                 |
| Updates    | 66.1 M, 51.5% HOT                                   |
| Reloptions | none (autovacuum waits for about 390,000 dead rows) |

## Causes

1. **No room for HOT updates.** Pages are filled to 100% on insert, so an update rarely finds room on its own page. A non-HOT update writes a new entry into all 15 indexes, which is where the index bloat came from.
2. **Vacuum waits too long.** It waits for a fifth of the table to be dead.

## Fix

Migration `20261015103046_tournament_players_stays_lean.sql`:

- `fillfactor = 85`, so each new page keeps room for its rows' next versions.
- Vacuum and analyze after 2% plus 1,000 changed rows, with the faster cost settings `tournaments` and `table_seats` already use.
- The six largest plain indexes are rebuilt `CONCURRENTLY` under a temporary `_rebuilt` name, in the installer's admitted preamble, which never blocks a writer:
  - `idx_tournament_players_basis` (360 MB)
  - `idx_tournament_players_registered_at` (239 MB)
  - `idx_tournament_players_chips` (130 MB)
  - `idx_tournament_players_club` (99 MB)
  - `idx_tournament_players_status` (98 MB)
  - `idx_tourn_players_tourn` (71 MB)

  Each is swapped in by name only when it is valid, has exactly the old definition and backs no constraint. The swap runs under a 2 s lock timeout, so it completes at once or refuses whole.

- The unique and constraint indexes are untouched. No row is read or written.

Pinned by `tests/tournament-players-stays-lean.law.test.ts`.
