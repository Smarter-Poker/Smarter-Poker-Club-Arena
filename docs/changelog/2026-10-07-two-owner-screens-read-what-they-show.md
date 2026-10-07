# Two owner screens read what they show (2026-10-07)

Migration `20261007041535_two_owner_screens_read_what_they_show`.
Law: `tests/two-owner-screens-read-what-they-show.law.test.ts`.

Dan's 2026-09-30 list said two screens time out for the busiest club: the
Cashier Statements totals and the Club Data game list. #5667 and #5686 fixed the
first causes. This measures them again for the busiest club by the measure each
screen scales with, as that club's owner (role `authenticated` with the owner's
claims, every probe rolled back), against the limit that applies: the
`authenticated` role's 8 s `statement_timeout` (the Cashier totals call has no
client timeout; the Club Data page gives each attempt 12 s).

## The Club Data game list

Busiest club by games in the default 14-day window: Shark Club, 158,820 games
(1,362 cash tables, the rest tournaments; Midway Union 135,715, Deep Stack
Society 95,342).

The first paint uses `ca_club_data_snapshot` (384 ms, healthy). Every other
part of the list uses `ca_club_game_page` and its core: the fee, winnings and
hands orders, every Load More, and the prefetch of the second Recent page that
runs after every first paint.

| measured                                | value                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| one page, fee / winnings / hands (warm) | 2,787 / 1,615 / 1,582 ms                                                  |
| one page, the first call of a rehearsal | 18,448 ms                                                                 |
| EXPLAIN (ANALYZE, BUFFERS), fee         | 2,220 ms, 363,334 buffers                                                 |
| production, last 24 h                   | 27 statement timeouts (45 and 34 on the two days before), edge max 12.8 s |

Where the 2.2 s went, to show 200 rows:

- the ranking joined the club's 157,476 tournaments to `tournaments` for a type
  and a start time, and the planner read the whole 1.1 GB heap to do it (Seq
  Scan, 143,527 pages, ~900 ms with the hash);
- it counted players for every tournament the club ever had a row for:
  `ca_club_tournament_player_daily` is keyed `(club_id, tournament_id, user_id,
stat_date)`, so the window cannot bound the scan (425,352 entries, 203,737
  heap visits, 488 ms);
- it sorted all 157,476 facts a second time to join them back to 200 rows.

Now the ranking reads only a tournament's id, type and start time, which the
new covering index `idx_tournaments_game_page_keys (id) INCLUDE
(tournament_type, start_time)` holds; it reads a name only when the owner
searches by name. Fee, winnings and players are read by key for the visible
rows alone. The ranking, its order, the cursor and every field are unchanged.

## The Cashier Statements totals

Busiest club by statement entries in the default 7-day range: Deep Stack
Society, 311,089 entries (Club JAQK 290,580, Shark Club 271,690).

| club       | cold call                             | warm call |
| ---------- | ------------------------------------- | --------- |
| Deep Stack | 4,170 ms; 7,634 ms in a rehearsal     | 201 ms    |
| Club JAQK  | 4,240 ms (7,631 pages read); 6,030 ms | 196 ms    |
| Shark Club | 8,486 ms (6,048 pages read); 3,915 ms | 182 ms    |

Production in the last 24 h: 20 calls, median 3.75 s, max 6.76 s, no timeout -
but a cold call for a top club can cross 8 s, and the volume tripled in a week.

The time is reading two covering-index ranges from disk one page at a time.
The movement branch excludes movements that a receipt already shows, and that
set was a materialized common table expression in the same statement; a CTE
scan is parallel-restricted, so the whole aggregate ran serial. The set is now
read first (the same two arms, the same snapshot, the function is STABLE) and
passed in as `$19`. Production, with the new statement: Gather Merge, 2
workers launched, Parallel Index Only Scan on both covering indexes.

## Proof that nothing else changed

Both bodies are production's live text with counted substitutions (each must
occur exactly once and each must reverse to the exact preimage), pinned by md5
before (`8d5df5bb...`, `49e310be...`) and after (`871a9d6e...`, `72d29ab4...`).
Owner, `SECURITY DEFINER` and grants (`{postgres=X/postgres}`, no browser role)
are asserted after the replacement.

Rehearsed on production in two rolled-back `REPEATABLE READ` transactions with
the swarm rehearsal tool, outside the break window. Each captured results
through the live functions, replaced the bodies, captured again and compared:

- 9 game pages for Shark Club and Club JAQK: fee, hands and recent orders and
  their second pages by cursor, a name search ("Spin"), an MTT filter -
  byte-identical JSON;
- 6 totals: four clubs over 7 days, Shark Club over 30 days, and a direction
  filter - byte-identical JSON.

Timings inside the rehearsal (after = same transaction, so warm): game pages
1.5-18.4 s before, 1.0 s after without the new index yet; totals 2.2-7.6 s cold
before, 88-163 ms after.

## Not changed

Any table or money row, `statement_timeout`, the client, the statement
page/export path, `ca_club_data_snapshot`, any grant.
