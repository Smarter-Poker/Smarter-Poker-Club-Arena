# The Club Data Report reads what the club played (2026-10-17)

Dan, after the Club Data screen moved onto the money (20261017160125):
"FINISH THESE UP NOW" - the advanced Report's past days, super agents seeing
the whole club, and the four-second fourteen-day view.

## What production said (20:30 UTC)

- The Report, its game and player pages, its rake panel and its exports read
  `club_table_daily`, `ca_club_table_player_daily`, `ca_club_player_daily`,
  `ca_club_tournament_daily` and `ca_club_tournament_player_daily`. Every
  writer of them still chose the earliest-joined union club, and the
  tournament writers chose EVERY club the player belonged to
  (`ca_reporting_tournament_clubs_for_user`: one per union plus every
  standalone club), counting one prize once per club.
- `fn_club_rake_rollup_catchup` (hourly, :25) rebuilds yesterday's
  `club_table_daily` through `fn_club_table_daily_refresh_day`, with the
  guess, every hour.
- `ca_club_rake_daily` (club rake totals behind the dashboard, revenue and the
  union rake views) used the same guess in `fn_ca_club_rake_daily_compute`.
- Eight Report reads and the rake panel admitted super agents
  (`ca_can_view_club_finances` / `ca_can_read_club_production`).
- The 14-day screen for Club JAQK took 3.81 s: 1.1 s counting every game's
  distinct players across 245,000 games, 1.1 s joining all 700,000
  tournaments to describe games the page never shows.

## Fix (migration 20261017204111)

- Live writers: `trg_ca_reporting_wallet_insert` takes the row's ledger leg,
  else the seat at that table; tournament rows take one club, the entry's
  (`fn_ca_tournament_reporting_club`). `trg_ca_reporting_rake_insert`'s
  tournament fees the same. `fn_ca_club_rake_daily_compute` reads
  `rake_attributions`, then the seat at the table.
- `fn_ca_reporting_rollups_from_facts(day)` rebuilds the five Report tables
  for one day from `ca_club_data_fact` (balanced to the cent against the
  ledger on 32 of 32 days); hands come from the same attribution the facts
  used. The hourly catch-up and both range rebuilds use it for every covered
  day and keep their old reading only for days before the facts.
- The Report's player pages list the club's members instead of the players
  whose earliest union club it is.
- `ca_can_view_whole_club_report` (= `fn_ca_club_data_scope` 'club': owner,
  co-owner, admins, platform admins) gates the Report's reads;
  `ca_can_view_club_finances` is unchanged for its other readers (cashier
  among them). Super agents keep their downline view on Club Data.
- `ca_club_data_screen` totals every game in one pass, takes the summary from
  those totals, and describes and counts players only for the rows it
  returns; tournaments are described for every game only when an MTT/SNG
  filter or a search needs it. 1.05 s for the same 14 days.
- The long Report readers are changed by an asserted in-place rewrite of
  their installed definitions (`pg_temp.ca_rewrite`): the migration aborts
  unless each pattern matches exactly as expected. All 13 patterns were
  checked against production before shipping.

## Not changed, on purpose

The union settlement reads that use the same guess
(`fn_union_rake_basis_by_club`, `fn_union_rake_paid_*`,
`fn_ca_union_wallet_that_can_pay`, the seat and tournament funding choices)
decide what clubs owe and which wallet pays. Changing them changes money.

## Proof

- `scripts/ci/test-club-data-report-db-postgres.py` (CI shard 2): production's
  own text for every writer changed, both migrations applied, the original
  Club Data scenario re-run on the faster screen, then live tournament and
  cash rows filed under JAQK once, the five tables rebuilt from facts equal to
  what the live writers wrote, the range rebuild and catch-up using the facts,
  club rake split by the witness, super agent refused on every Report read and
  served downline on Club Data, and P listed among JAQK's players. With the
  old tournament lookup put back it fails: `JAQK tournament winnings should be
-11 + 30 = 19, got 0`.

## The fourteen days, again (20261017221938)

20261017204111's screen measured 1.05 s as a free-standing query and then
3.79 s on production inside the function: it still grouped 450,000 fact rows
into 248,000 games to choose 200, and its per-game player count was planned as
one range scan per game. The plain screen now takes its totals in one
aggregate, chooses its rows newest day first (a fact's `last_at` falls on its
own `stat_date`, so the order is exact), and totals, counts and describes only
those rows by exact (club, day, game) lookups. Production, Club JAQK, 14 days:
3.94 s before, 0.50 s after. On the closed window 30 September to 13 October
both forms return identical totals and the same 200 rows in the same order.
A filtered screen keeps the full form, with its player count on exact lookups.
