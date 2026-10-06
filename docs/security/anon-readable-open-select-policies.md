# The anonymous read surface: `USING (true)` as a default

Measured on production `kuklfnapbkmacvwxktbh` on 2026-10-06, read-only, from
the catalogue (`pg_policy`, `has_table_privilege`, `has_column_privilege`).
Nothing here was established by attempting a read as `anon`.

## What the sweep found

|                                                                                                      | count   |
| ---------------------------------------------------------------------------------------------------- | ------- |
| tables in `public` that `anon` can read at least one column of                                       | 793     |
| of those, with a **permissive** readable policy whose `USING` is `true` and whose roles reach `anon` | **167** |
| of those 167, holding a money or personal-data column `anon` can read                                | **50**  |

`USING (true)` is not three mistakes on three tables. It is what this estate
does by default when a table needs to be readable, and the three holes closed
on 2026-10-06 were found by looking rather than by anything failing.

## Why a narrow policy beside an open one is not a fix

`player_stats` carried **both** `"Player stats are public"` (`FOR SELECT`,
roles `PUBLIC`, `USING (true)`) and a correct `player_stats_self`
(`authenticated`, `auth.uid() = user_id`). Permissive policies are **OR'd**, so
the open one decided the table and the narrow one could only ever widen it.
Anyone reading the policy list saw a self-scoped policy and concluded the table
was scoped.

## The three closed on 2026-10-06

| table                          | policy                    | was                                                          | now                                                                                                                                   |
| ------------------------------ | ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `player_stats`                 | `Player stats are public` | `PUBLIC`, `USING (true)`, + table grant to `anon`            | dropped; `anon` revoked; `player_stats_club_member_read` (`authenticated`, club the viewer is a member of) beside `player_stats_self` |
| `commander_tournament_entries` | `captain_entries_select`  | `PUBLIC`, `USING (true)`                                     | self-or-active-venue-staff, `TO authenticated`; `anon` revoked                                                                        |
| `commander_waitlist`           | `captain_waitlist_select` | `player_id = auth.uid() OR player_id IS NULL OR venue staff` | the `player_id IS NULL` branch removed; `TO authenticated`; `anon` revoked                                                            |

The `player_id IS NULL` branch is worth its own line: it was written to describe
"a row with no account holder", and for a caller with **no account**
`auth.uid()` is NULL, so it evaluated **true** and published every walk-in row.

## Still open, and why this file exists

The remaining 47 of the 50 are **not** closed. Several are legitimately public
and need no change — a venue's published address and phone, a tournament's
advertised buy-in and starting stack, a table's posted rake terms. Others carry
a **player's** name or money and should be treated the way the three above
were. Grouped by what `anon` can read today:

- **player identity beside money or play**: `club_game_seats`
  (`player_name`, `notes`), `commander_tournament_points` (`player_name`),
  `bbj_winners` (`winner_display_name`, `loser_display_name`, four payout
  columns), `tournament_registrations` (`display_name`, `prize_amount`,
  `buy_in_amount`), `tournament_players` (`chips`, `bounty_winnings`),
  `poy_leaderboard` (`player_name`), `table_seats` (`stack`, hole 1b)
- **venue and staff operations**: `commander_seat_preferences`,
  `commander_shift_handoffs`, `commander_staff_shifts`, `toke_entries`,
  `venue_game_schedules`, `live_games`, `club_live_games` (all `notes`)
- **club and pool balances**: `clubs` (`promo_balance`, `insurance_balance`,
  `total_rake`), `bbj_pools` (`main_balance`, `backup_balance`,
  `promo_balance`), `spin_bonus_pools` (`balance`, `seeded_amount`),
  `arcade_jackpot`
- **published business data, likely fine as-is**: `poker_venues`, `venues`,
  `charity_events_schedule`, `poker_tour_series_events` (address, phone),
  `tour_events`, `tour_event_details`, `venue_tournament_schedules`,
  `commander_tournaments`, `commander_tournament_templates`, `poker_events`,
  `promotions`, `reward_definitions`, `arcade_games`, `poker_tables`,
  `training_levels`, `stack_depth_configs`, `memory_charts_gold`,
  `villain_archetypes`, `trivia_*`, `daily_spins`, `live_gifts`, `hands`
  (`rake`), `bbj_mini_tiers`, `commander_game_types`,
  `commander_venue_settings`, `tournament_bounties`, `tour_stop_events`,
  `tour_source_registry`, `ad_advertiser`

That last group is the reason this is an inventory and not a bug list: the
difference between a reference table that should be world-readable and a table
of payouts that must not be is a judgement only somebody who knows the product
can make, and it has to be **written down** rather than left implicit in a
policy that says `true`.

## What guards it now, and what does not

`tests/anon-is-not-a-public-table-reader.guard.test.ts` refuses a **new**
permissive readable `USING (true)` policy that reaches a browser role, and a
new `GRANT SELECT` to `anon`/`PUBLIC` on a table listed as sensitive, in any
migration after `20261006135147`. A table that is genuinely world-readable
ends the statement with `-- public-ok: <why>`, so the judgement above gets
recorded at the moment it is made.

**It reads migrations, so it cannot see what never passed through one.**
`captain_entries_select` and `captain_waitlist_select` appear in **no**
migration in this repository — they were created straight against production,
which is the normal path in this estate. Closing that gap needs a live sweep
against a baseline, the way
`scripts/ci/audit-live-definer-exposure.mjs` already does for `SECURITY
DEFINER` functions, run by the Schema Manifest Refresh workflow which already
holds the service-role key. The table-level equivalent does not exist yet and
is the single highest-value follow-up from this sweep.
