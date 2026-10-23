# Club Data and Union Data read each window once (2026-10-22)

Migration `20261022165130_club_data_and_union_data_read_each_window_once.sql`.

## What was slow, measured on production (read-only, every probe a DO block ended by RAISE)

- `ca_club_data_snapshot_v2` (Club Data): 414 calls, mean 4.7 s, and the top
  lock holder on the hot tables (96 of 150 `pg_locks` samples, up to 5.6 s).
  - `ca_club_game_page_core_20261006` picked the newest 100 games by ranking
    every game of the window (208,000 for The Felt Society's fortnight)
    through `tournaments`: 4.5 to 5.9 s.
  - `ca_club_data_screen`, called twice for the summary: 1.1 + 0.8 s, because
    the MTT split joined 200,000 per-player tournament fact rows to
    `tournaments`.
  - `fn_ca_club_data_hand_count` for a union timed out: as `LANGUAGE sql` it
    was planned with unknown parameters, a bitmap of every raked hand in the
    window once per eligible table.
- `ca_rake_snapshot_v2`, Midway Union, month to date: 12 to 31 s.
  - `fn_ca_rake_by_club_v2` read the whole window once per club: 13.5 to 19.3 s.
  - `fn_ca_rake_window_v2` (current and previous period): 4.9 s and 2.3 s, its
    `GROUP BY (kind, game)` spilling to disk at the default `work_mem`.
  - `fn_ca_rake_series_v2` summed every per-player fact row: 4.0 s.

## What changed

1. `fn_ca_rake_windows_v3` reads a window's per-game rows once: sums per club,
   the union's distinct games and every club's distinct games from one pass
   (each game carries its clubs as bits; above 62 clubs it groups by club
   instead), MTTs found from `tournaments` by key. `fn_ca_rake_window_v2` is
   its `all`; `fn_ca_rake_by_club_v2` lists its `clubs` through
   `fn_ca_rake_by_club_from`, the old listing verbatim; `ca_rake_snapshot_v2`
   computes the union window and every club window once.
2. `fn_ca_rake_series_v2` sums `ca_club_data_game_ct`, the per-player facts
   summed per game by the same statement (equal per club and day to the digit
   on production for 138 club-days).
3. `fn_ca_club_data_hand_count` is the same query, now planned with its values
   (`plpgsql`, `force_custom_plan`).
4. `ca_club_data_screen`'s unfiltered totals and MTT split read the per-game
   rows when no downline filter applies (equal on production for all
   1,066,121 club, day, game and kind keys, `last_at` included). With a
   downline filter it runs the original code.
5. `ca_club_data_snapshot_v2`'s rows come from `fn_ca_club_game_recent_rows`
   when the filters are ALL and there is no search: the newest tournaments
   walked down `idx_tournaments_start_time`, kept when the club played them,
   merged with every cash table and described by the page core's own detail
   query. It returns NULL unless it can prove its rows are the page core's (it
   filled the page and its oldest tournament is newer than the 20,000th newest
   start), and the page core is then read exactly as before.

Unchanged: the Chicago day basis, the finished/running MTT split, scope and
authorization (the three new readers are callable by no client), every response
shape and the older endpoints. No table, index, trigger or money row is
touched. Horses count as every other player; nothing filters them.

## Proof

- Every replaced function is pinned by md5 to its production text, and the
  two it calls (`fn_ca_rake_felt_v2`, `fn_ca_club_data_clubs`) too.
- `scripts/ci/test-club-data-reads-each-window-once.py` installs every Club
  Data migration in order on a throwaway cluster, proves those pins, records
  every reader's output (windows, by-club sorts and searches, series buckets,
  hand counts, union and club snapshots, the screen, `snapshot_v2` at page
  sizes 1, 2, 3, 5, 100 and 300), installs this migration and requires every
  output identical. It drives the walk to both outcomes: proved rows equal to
  the page core, and 20,001 future tournaments forcing a refusal that falls
  back to the page core. Runs in `.github/workflows/club-data-reads-each-window-once.yml`.
- On production, read-only, the one-pass reader returned exactly the old
  per-club and union figures (Midway Union month to date: 3.48 s against 13.46 s),
  and the walk returned exactly the page core's rows for The Felt Society,
  Deep Stack and the union.
- `tests/club-data-reads-each-window-once.law.test.ts` pins the shapes;
  `tests/club-data-counts-chicago-days.law.test.ts` now follows the MTT split
  into `fn_ca_rake_windows_v3`, where the window logic lives.

Live timings after install are recorded in the pull request.

## Installed on top of 20261022200354

The first install (run 39888141557, 2026-10-23 02:21 UTC) was refused by this
migration's own guard: `ca_club_data_screen` and `ca_club_data_snapshot_v2` had been
replaced on production at 20:03 UTC by `20261022200354_club_data_snapshot_reads_by_day_not_by_every_row`
(PR #7725, not yet on main). That migration only probes facts by date range instead
of a date list and reads `data_updated_at` from each club's latest day. Reverting
exactly those edits on production gives this migration's original pins, so the
guard now accepts either pair, and the new bodies keep both edits: the screen's four
fact probes use `BETWEEN v_start AND v_end`, and the snapshot reads its
`data_updated_at` by latest day. Figures are unchanged.
