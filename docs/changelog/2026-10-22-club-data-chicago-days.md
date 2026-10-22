# 2026-10-22 - Club Data and Union Data count Chicago days; MTT Winnings are finished MTTs

Dan asked for two changes on Club Data and Union Data:

1. Count days by the America/Chicago calendar day (DST aware), not UTC. Under
   UTC the page's "Day" rolled over at 7 PM Chicago (6 PM in winter), so the
   evening's play landed on tomorrow.
2. "MTT Winnings" should mean finished MTTs only. A running MTT has taken its
   entries and paid nothing final, so it read as a loss for the club. Its
   entries now show separately as "Running MTT Entries".

## Where the day is fixed: at the source

A report window can only be as fine as the bucket under it, and
`ca_club_data_fact` is bucketed by UTC day. Re-deriving a Chicago day from it
is impossible: a UTC day's row says nothing about which hours its money moved
in. So the bucket is added at the source.

- `20261022103651_club_data_chicago_day_facts_and_writer.sql` adds
  `ca_club_data_fact_ct` (the same facts keyed by Chicago day),
  `ca_club_data_game_ct` (per-game sums, the game page's ranking set) and
  `ca_club_data_hands_ct` (raked cash hands per club, Chicago day and table).
  The one live writer, `fn_ca_club_data_fact_put`, writes both buckets in the
  same statement from its cutover (`ca_club_data_ct_state.live_from`, commit
  plus three minutes), and `trg_ca_club_data_fact_rake` counts each raked
  hand once per club that shares it. Every row carries `src` (0 live, 1 the
  history load) in its key, so the load can never hold a row a settling hand
  needs.
- `fn_ca_club_data_ct_seed(utc_day)` is the one-time history load, the same
  pattern as 20261017160125's `fn_ca_club_data_fact_seed`. Chicago midnight
  falls inside every UTC day, so each UTC day splits at it: the early slice is
  re-read from `rake_records` and `wallet_transactions` with the fact table's
  own formulas and filed under the club that already holds the key, and the
  rest is the UTC fact minus that slice. Every club, game and player keeps
  exactly the totals the UTC report had; only the day moves. A slice can never
  exceed what the UTC fact recorded for its key.
- `20261022120109`, `20261022120113` and `20261022120117` run that load for
  September 16-30, October 1-12 and October 13 through the cutover day, each
  well inside the installer's fifteen minutes (heaviest day's slice measured
  at 28 s on production, read-only).
- `20261022120121_club_data_reads_chicago_days_and_separates_running_mtts.sql`
  points every Club Data and Union Data reader at the Chicago bucket:
  `ca_club_data_screen`, `ca_club_data_snapshot_v2`, the game page core, both
  game lists, the game and rake CSV exports, `ca_rake_snapshot_v2` and its
  window, series and felt. "Today" is `(now() AT TIME ZONE
  'America/Chicago')::date`, seated stacks are filed by the Chicago day the
  seat was taken, and the union hand count and agent downline windows use
  Chicago midnights. It refuses to install until every history day is loaded.

## MTT Winnings

`mtt_winnings` and `mtt_fee` now cover MTTs whose `tournaments.status` is
COMPLETED or CANCELLED. Every other MTT (REGISTERING, RUNNING) is reported as
`running_mtt_entries` and `running_mtt_fee`. Both are parts of
`tournament_winnings` and `tournament_fee`, which are unchanged, so
`total = cash + tournament` still holds to the cent. The legacy
`ca_club_data_snapshot` contract (mtt = all tournaments) is unchanged for
clients that are already open.

`accounting_basis` reads `chicago_net_money_flow` (with `day_basis`
`America/Chicago`), and the page label says Chicago time.

## Not changed

Weekly accounting, settlement, rakeback, invoices, agent commission and every
other money or accounting boundary. The club-scope agent book
(`fn_ca_rake_by_agent`) and the player list (the Member record) keep their own
day basis. Nothing that pays anyone reads these functions.

## Proof

`scripts/ci/test-club-data-union-mtt-postgres.py` now installs the four
migrations on real Postgres and checks: the live writer writes nothing before
its cutover; the load refuses a live day and a repeat; every UTC total is
preserved per club, game and player; each event lands on its Chicago day;
every reader's day, union and club totals reconcile to the Chicago facts to
the cent; Club Data and Union Data agree figure for figure; union = sum of its
clubs; a running MTT's entries are Running MTT Entries and not MTT Winnings.
The law is `tests/club-data-counts-chicago-days.law.test.ts`.
