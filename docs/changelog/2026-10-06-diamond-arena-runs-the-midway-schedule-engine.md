# The Diamond Arena runs the Midway Union's schedule: engine half (2026-10-06)

Dan, 2026-10-06 13:09 CT: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE
MIDWAY UNION FOR NOW", for the Diamond Arena. Earlier the same day he ruled that
the horses that were in Deep Stack Society play the Diamond Arena (#6309).

This is the engine half. The database half (another PR) adds
`fn_poker_diamond_spawn_scheduled_tournament(p_schedule_id, p_scheduled_start,
p_config) -> {ok, tournament_id, replayed} | {ok:false, reason}`. That function
is idempotent per (schedule, start) and earmarks the guarantee on the arena
house. No schedule rows are seeded here, and Deep Stack Society stays off.

## What changed

- **ScheduledTournamentService**: the schedule config is still built into the
  same row as before, with the same presets, satellite resolution and checks.
  A schedule whose club is the Diamond Arena (read through
  `parseArenaIdentity`, not a hard-coded id) keeps `claimSpawn`, then calls the
  Diamond door instead of a direct insert. The config uses whole Diamonds. The
  entry total is the same snapped ladder price (`buyInFor(wholeChips(buyIn))`)
  and the database takes the fee. The guarantee, rebuy and add-on prices are
  sent as whole numbers. A bounty is floored, never rounded up past what the
  entry funds.
  - An `{ok:false}` reply, or an answer that cannot be read, is handled the
    same way. The engine reports the reason and releases the claim. It links
    nothing and seeds nothing, so no spawn is ever faked. The next attempt waits
    on the same backoff as a refused chip guarantee.
  - The guarantee bank for an arena schedule is `fn_ca_diamond_house_available()`.
  - Union schedules are decided without any club read. If a standalone club's
    row cannot be read, that spawn waits for the next poll.
  - Chip rows are inserted byte-for-byte as before.
- **TournamentRecurringService**
  - `clubMemberIdsForScope`: an arena event draws on the arena's own members
    plus the members of `DIAMOND_ARENA_HORSE_CLUBS`. Before this change it drew
    one member row and no horses. Chip clubs are unchanged.
  - The bankroll gate judges a Diamond event on `profiles.diamonds`, floored to
    whole Diamonds, with the same rule and policy as a chip roll. Before this
    change it read `club_members.chip_balance`, which does not exist at the
    arena, so every horse was waved through. The database reserve is still the
    final authority.
- **HorseOverlayGuard**: the guard cycle also covers the arena's club id while
  `ca_arena_settings.tournaments_enabled` is exactly true, and fails closed to
  Midway alone. No database change was needed:
  `fn_overlay_at_risk(p_union)` and `fn_freeroll_fill_targets(p_union)` already
  match `c.id = p_union`.

## For the database half

Midway freerolls have `buyIn` 0 with $1 rebuys and add-ons. For these the engine
sends `buyIn: 0` and `freeBuy: true`, with `rebuyCost`/`addonCost` set to 1.
Today's `fn_poker_diamond_create_tournament` refuses both. The spawn function
must either accept them or refuse them by name. The engine only logs the
reason.

Midway satellites carry `satelliteSeats` (1 or 3). The create door currently
refuses a seat guarantee (`diamond_satellite_seat_guarantee_not_open`).

## Tests

`server/src/services/theDiamondArenaRunsTheMidwaySchedule.test.ts`.
