# Club Data counts what the club played (2026-10-17)

Dan, on Club JAQK's Club Data screen: "THERE IS NO SHOT THIS IS CORRECT DATA
FOR THE ENTIRE CLUB WITH ONLY 5 GAMES ... CLUB OWNERS SEE EVERYTHING, AGENTS
SEE THERE GENERATED STATS + DOWNLINES, REGULAR PLAYER ACCOUNTS DONT SEE THE
DATA BUTTON OR PAGES. MAKE SURE THAT THIS IS ACCURATE REAL TIME DATA AT ALL
TIMES. AND THE CLUB NAME SHOULD BE AT THE TOP NEXT TO "CLUB DATA"."

## What production said (2026-10-17 03:30 UTC, the 1 Day view)

|             | Screen | The money                                       |
| ----------- | ------ | ----------------------------------------------- |
| Tournaments | 0      | 2,683 entered through Club JAQK (4,227 entries) |
| Cash rake   | 132.71 | 13,182.27 on 96 Midway Union tables             |
| Cash games  | 5      | 5 JAQK-hosted tables plus 96 union tables       |

## Cause

Every Club Data fact (`club_table_daily`, `ca_club_tournament_daily`, the
felt) decided a union player's club with a guess: the player's EARLIEST
joined club in the union (`fn_ca_cash_reporting_club` and five copies of the
same `ORDER BY joined_at` in the rebuilds). All 585 Club JAQK members are
also SHARK CLUB members and joined SHARK first, so everything they played
through Club JAQK was filed under SHARK CLUB. 139 of the morning's 283 union
cash seats were bought in from Club JAQK wallets; all 139 read as SHARK's.
SHARK was inflated by the same amount (26,931 of rake shown, about 13,945 its
own).

The platform never needed to guess. The club a chip moved through is written
with the money: `chip_ledger.club_id` on the wallet leg (same transaction,
written first; 3,854 of 3,854 wallet rows matched), `table_seats.club_id` on
the seat (agrees with `rake_attributions.club_id` on every contribution read)
and `tournament_players.club_id` on the entry (2,685 of 2,685).

## The first fix (#7262, 20261017105645) and what it left

#7262 replaced the guess with a different one: the club of the player's most
recently joined seat at ANY table, with the union no longer consulted. Read
at 15:55 UTC: 150 players were seated at more than one cash table and 63 in
two or more clubs, so a hand was credited to the club of whichever seat the
player took last, and a hand at one of the 42 open non-union tables could be
credited to another club entirely. Club JAQK showed 86 cash tables where its
seats had played 133. Every day before 11:10 UTC was left as it was (October
16: 41 games, 1,250.32 fee; September 20: 7 games, 158.97), tournaments were
never touched (1.10 of tournament fee for the whole of October 17), and the
footer guessed the viewer's role on the client, so the Data door could show
while roles were still loading.

## Fix (migration 20261017160125)

- `fn_ca_cash_reporting_club` goes back to never leaving the union it is asked
  about (its pre-#7262 body, the last resort only). The new
  `fn_ca_cash_table_reporting_club(union, table club, user, table)` reads the
  player's seat AT THAT TABLE first; `fn_ca_club_table_daily_add_rake` (the
  advanced report's live writer) calls it, and `fn_ca_club_cash_felt` reads
  the seat it is already looking at.

- `ca_club_data_fact`: one row per club, UTC day, game and player, written by
  two new insert triggers (`ca_club_data_fact_rake` on `rake_records`,
  `ca_club_data_fact_wallet` on `wallet_transactions`) in the transaction
  that moves the money, with the club read from those records. The old guess
  is only the last resort for a row that carries no club at all.
- `ca_club_data_screen` reads it, scoped by `fn_ca_club_data_scope`:
  owner, co-owner, admins and platform admins see the club; agents, sub agents
  and super agents see themselves and their downline
  (`fn_ca_club_data_downline`); anyone else gets 42501.
- Cutover without a gap or a double count: the triggers write rows created
  from `ca_club_data_fact_state.live_from` on; `fn_ca_club_data_fact_seed`
  fills everything before it a day at a time, refuses to run until a minute
  after `live_from`, and refuses an overlapping window
  (`ca_club_data_fact_seed_log`). Nothing is scheduled and nothing repairs.
- History: `fn_ca_club_data_fact_seed` is run by hand one UTC day per call
  from 2026-09-16 to `live_from`, so every past day on the screen is counted
  from the money too.
- The advanced report (`/data/advanced`, `ca_club_data_snapshot`) still reads
  the old facts. Its live writer now follows the seat at that table; its
  past days are what `fn_club_table_daily_refresh_day` last wrote.

## Client

- The header reads "CLUB JAQK - CLUB DATA"; the club's name is the part that
  gives way on a narrow phone.
- An agent's screen says "You And Your Downline" and has no Report door (the
  report is the whole club's).
- The refusal reads "Club Data Is Open To The Club Owner, Admins And Agents."
- The footer asks the server (`fn_ca_club_data_scope`, the same function the
  screen enforces) who may see Club Data, remembers the answer per account
  and club for the session, and keeps the Data door closed until it knows, so
  a player never sees it flash on. Players keep #7262's five-door art
  (`club-arena-footer-player-v1.webp`); operators keep the six-door master.

## Proof

- `scripts/ci/test-club-data-fact-db-postgres.py` (CI shard 2, inside the
  Data console native PostgreSQL contracts step) runs the real
  migration on a private Postgres with the JAQK shape: facts land under the
  club the money moved through, owner/agent/player/anon scopes, the felt, the
  filters, a player seated at a union table, a SHARK home table and a JAQK
  home table (each hand to the seat at that table, in the facts, in
  `club_table_daily` and in the felt), and seed equals triggers. With the
  wallet writer put back on the guess it fails: `JAQK cash facts wrong:
(2,0,0,0)`; with #7262's latest-seat lookup put back it fails:
  `club_table_daily JAQK at T should be 2 + 3, got 2`.
- `tests/club-data-counts-what-the-club-played.law.test.ts` pins the source.

## Not changed, and why

- `ca_can_view_club_finances` still admits super agents to the advanced
  report and the other finance reads. Narrowing it changes eighteen finance
  reads and the cashier's view of super agents; the everyday screen and the
  footer follow Dan's rule now, and the advanced report's scope is the next
  item.
