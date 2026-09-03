# Biggest Hits was showing the same spin three times

2026-08-31, spins audit part 6.

## What a player was reading

`fn_spin_leaderboards` builds `biggest_hits` from the `spins` CTE — which is
one row per **paid seat**, not one row per spin. A Spin at 10x and above pays
more than first place (0.80/0.20 at 10x, 0.80/0.12/0.08 from 25x up), so one
100x contributes three rows, and the tie-break was `ended_at`, which is
identical for all three.

The live board, before:

| prize  | buy-in | multiplier |                                          |
| ------ | ------ | ---------- | ---------------------------------------- |
| 24.00  | 2.00   | 100x       | second place — **top of "Biggest Hits"** |
| 160.00 | 2.00   | 100x       | the actual winner, listed below it       |
| 16.00  | 2.00   | 100x       | third place                              |
| 24.00  | 3.00   | 100x       |                                          |
| 240.00 | 3.00   | 100x       |                                          |
| 36.00  | 3.00   | 100x       |                                          |
| 60.00  | 10.00  | 50x        |                                          |
| 400.00 | 10.00  | 50x        | a 400 win, seventh                       |

**Ten rows, four tournaments.** Headlined by a second-place 24.00 with the
winner underneath it, and a third-place 16.00 ranked above a 400.00.

It also buried real wins. **A 1,000.00 on a 50-chip 25x was off the board
entirely** — three 100x games had eaten six of the ten slots with their 16s
and 24s.

## The fix

One row per spin, and it is the one who won it:

```sql
winner_seat as (
  select distinct on (s.tournament_id)
         s.tournament_id, s.username, s.multiplier, s.buy_in, s.prize, s.ended_at
    from spins s
   where s.prize > 0
   order by s.tournament_id, s.prize desc
)
```

then ordered by multiplier — the story a Spin tells — and by prize within it,
so a bigger win is never under a smaller one.

The board immediately after applying: **10 rows, 10 distinct tournaments,
every one a winner**, and the 1,000.00 back on it at sixth.

## What was NOT changed

`most_spins` and `best_net` still count seats, because a seat is exactly the
unit they mean — one entry per spin played, per player. Only `biggest_hits`
was asking a per-tournament question of a per-seat table.

The response shape is unchanged — `username`, `multiplier`, `buy_in`,
`prize`, `ended_at` — so no client moves. `tournament_id` stays inside the
query as a join key and never reaches the payload.

No `is_horse` filter, in either direction (CLAUDE.md 10.5), exactly as
`20260830064500` established. The pin that enforces it now covers this
migration too.

## Verification

- the migration asserts it at apply time rather than trusting the shape: it
  counts its own rows against DISTINCT games and raises if any spin appears
  twice
- `tests/unit/spinLeaderboards.test.ts` — 24 tests, six of them new
- `check-migrations-applied` and `check-definer-authorization`: OK
