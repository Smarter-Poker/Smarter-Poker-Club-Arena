# The settlement lane is per tournament for authorities

Date: 2026-09-10. One migration, `20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql`,
applied 17:31:47 UTC and recorded in `supabase_migrations.schema_migrations`.
Rollback, byte for byte: `2026-09-10-the-settlement-lane-is-per-tournament-for-authorities.rollback.sql`.

## What was wrong

#4135 gave every rolling tournament authority (seat purchase, registration,
horse seat-first, rebuy, unregistration, bounty collection, seat move, mystery
reserve) a per-tournament key T(id), but took it only after the platform-wide
key G (`ca:tournament-terminal-settlement:v1`) in EXCLUSIVE mode, held to
commit. So every one of those operations on the platform still ran one at a
time. Postgres logged 55-102 `still waiting for ExclusiveLock on advisory lock
[5,4265093629,1253463894,1]` lines (a wait past 1 s each) in every busy five
minutes between 16:30 and 17:30 today; at 08:09 G was held in 89% of samples
with a queue in 78.8% and waits up to 6.6 s. Entry doors hold the maintenance
boundary `530090` shared, so the same queue slowed the :53 break announcement
(`2026-09-10-the-maintenance-break-gate-opens-again.md`, "The next thing").

Two more platform-wide holds sat on the same paths: `fn_mystery_bounty_pay`
took the GLOBAL lane (G and B exclusive, so every call held every hand
settlement on the platform) only because it is keyed by award id, and the
committed-move resolver took G exclusive for a read-only lookup.

## What changed

| path                  | G (platform) | B (hands) | T(id)     | was             |
| --------------------- | ------------ | --------- | --------- | --------------- |
| rolling authority     | shared       | -         | exclusive | G exclusive     |
| terminal / rare       | exclusive    | exclusive | -         | unchanged       |
| hand settlement       | -            | shared    | shared    | unchanged       |
| seat-exit authority   | shared       | -         | exclusive | G exclusive     |
| mystery bounty payer  | shared       | -         | exclusive | G + B exclusive |
| move receipt resolver | shared       | -         | shared    | G exclusive     |

- Rolling authorities of different tournaments no longer wait for each other;
  the same tournament still serialises on T(id); terminal authorities still
  exclude everything; a hand still waits only for its own tournament.
- The three trigger guards that read G-held-exclusively as proof of authority
  (`fn_tournament_live_seat_acquisition_requires_authority`,
  `fn_satellite_target_player_provenance_is_immutable`,
  `fn_tournament_payouts_are_append_only`) now accept T(the row's tournament)
  held exclusively as well. A shared hold proves nothing. Nothing else in them
  changed.
- No upgrades: the seat-exit authority (called inside a move that already holds
  its lane) and the mystery payer (called inside the per-tournament bounty
  sweep) used to request G exclusive while holding G shared; both now take
  their tournament's lane.
- `fn_lock_daily_mission_user` locks the profile FOR NO KEY UPDATE, so it no
  longer blocks the FOR KEY SHARE every foreign-key check takes (a logged
  cycle through `profiles` between a cash buy-in and a registration).
- `fn_ca_release_unseatable_registrant_at_launch` takes the lane before the
  tournament and receipt rows, the order a seat purchase uses.

The migration refuses to run unless every replaced body is byte-identical
(md5) to the reviewed one and the sets of functions naming G and of rolling
authorities are exactly the reviewed sets; after the change it re-proves on
the live catalog that only the two lane helpers take G exclusively and that no
function taking the rolling lane reaches the global lane within four calls.
The diff of every replaced body against production is only the lines above.

## Verified on production

- 17:32:45-17:33:05, 80 quarter-second samples of G: held exclusively in 1
  (a terminal authority), shared in 7, a queue in 0; up to 4 rolling
  authorities of different tournaments holding their lanes at the same moment,
  which the old lane made impossible.
- Postgres logged no wait on G after 17:31:50 (55-102 per five minutes before).
- No guard refusal (`TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY`,
  provenance, append-only payout) from any caller after the change; the only
  matches in the log are the migration's own statements.
- `pg_stat_database.deadlocks` unchanged across the change (50); the three
  `deadlock detected` lines of the preceding 15 minutes were all before it.

## Follow-up: the bounty sweep takes one tournament's lane per call

`20260910174349_the_bounty_sweep_takes_one_tournament_lane_per_call.sql`,
applied 17:43:49 UTC. The engine calls `fn_sweep_pending_tournament_bounties`
with no tournament on every pending-obligation notification, i.e. on every
bounty bust, and with no tournament the lane helper takes the whole lane: G
and B exclusive, which holds every hand settlement and every rolling authority
on the platform for the length of the sweep. Seven mystery-chest obligations
refused with `inventory_exhausted` are retried every 60 s (about 200 attempts
each today), so that barrier was being raised at least once a minute, and at
17:34:56-17:35:19 one such sweep queued sixteen hand settlements behind B with
nineteen statement timeouts in the minute. Called without a tournament, the
sweep now settles only the tournament of the first order-eligible due
obligation, under that tournament's lane; `pending` and `retry_after_ms` still
describe the whole platform, so the engine's existing loop calls again at once
while other tournaments have due work. A transaction never holds two
tournaments' lanes.
