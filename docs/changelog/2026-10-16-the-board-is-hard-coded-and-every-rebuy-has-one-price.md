# The Board Is Hard Coded, And Every Freeroll Rebuy Has One Price (2026-10-16)

Dan, verbatim: "ALL REBUY ADD ON'S FOR MIDWAY UNION ARE 1 CHIP REBUY ADD ON
NOT 2, DIAMOND REBUYS ARE 100 DIAMONDS (ONE DOLLAR) I SAID I DON'T WANT
'SPAWNED EVENTS' I WANT ALL HARD CODED SCHEDULED EVENTS ONLY", and the missed
event alerts of 2026-10-16 fixed "AT ITS ROOT CAUSE AND HARD CODE FIXED".

## Prices

- `FREE_BUY_TIERS.feature` (the 8 PM Prime Time Free Buy) charged a 2 chip
  rebuy and add-on. Both tiers now charge 1.
- `fn_freerolls_are_free_buy`, the trigger every freeroll row is written
  through, prices every freeroll by its club's asset with no exception: 1 chip
  in a chip club, 100 Diamonds (one dollar) in a Diamond club. The 2026-09-04
  exception that let a scheduled Free Buy keep its own price is removed.
- `fn_poker_diamond_create_tournament_core` requires and writes 100 Diamonds
  for an arena freeroll rebuy and add-on (was 1), and `ca_diamond_economics`
  records `one_hundred_diamonds_to_the_prize_pool` for both.
- `diamondSpawnConfig` sends 100 for an arena freeroll.
- Every freeroll nobody has entered is repriced by the migration. The 48
  already-published freerolls with registered entrants keep the price they
  were entered under, because `fn_guard_managed_game_lifecycle` refuses any
  price change on a registered event; the last of them starts Mon 2026-10-19
  06:00 Chicago, and every event published after the migration runs at the
  new price.

Migration `20261016123336_every_freeroll_rebuy_and_add_on_is_one_chip_or_one_hundred_d`.

## The Board Is Hard Coded, And Why The Missed Event Alerts Fired

The eight "could not be created" alerts between 00:10 and 01:03 Chicago on
2026-10-16 had one cause: the board was first installed as database rows by a
migration, an hour before the engine release that knew how to build them, so
the engine then serving refused each occurrence it read. Data was deployed
ahead of its code.

The board is now hard coded in `server/src/config/fixedBoard.ts`: 25 events,
fixed Chicago times, both clubs, 53 starts a day each. The engine writes that
file into `tournament_schedules` itself (`syncFixedBoard`, before it reads a
schedule), adding a missing row, rewriting a row whose times differ from the
code and retiring a fixed-board row the code no longer lists. A schedule can
no longer exist ahead of the binary that runs it, because the same release
carries both. The law proves every hard-coded event builds a row in both clubs,
so an unknown template cannot ship.

Spins, Sit & Gos and the heads-up feeder satellites still start when their
seats are paid, under Dan's 2026-09-01 ruling that those formats have no
scheduled time.

## Proof

`server/src/services/theBoardIsAFixedSchedule.law.test.ts`,
`server/src/services/FreeBuy.test.ts`, `tests/law/FreerollsAreFreeBuy.law.test.ts`.
