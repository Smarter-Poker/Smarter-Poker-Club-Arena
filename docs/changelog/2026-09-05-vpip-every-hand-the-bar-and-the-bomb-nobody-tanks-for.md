# 2026-09-05 - VPIP counts every hand, a low-VPIP boot is a two-hour bar, and nobody tanks for the bomb

Three rules from Dan on 2026-09-05, engine + SQL.

## 1. "VPIP NEEDS TO WORK FOR EVERY HAND, BOMB POTS COUNT AS A HAND"

The hand row (`ca_hand_facts`) was always written for a bomb hand, so hands
were counted - but `vpip` was derived from the preflop action log, and a bomb
hand has no preflop street, so nobody was ever marked as having put money in.
Every dealt-in player of a bomb hand now carries `vpip = true`
(`handFacts.ts`, `isBombPot`, passed from `logHandHistory`). 1,682 fact rows
across 713 bomb hands since 2026-09-01 backfilled (`20260905063000`, DML
only). `fn_nit_check` / `fn_cash_vpip_status` read the same column, so the
eviction and the tracker agree at once.

## 2. "IF A PLAYER GETS BOOTED BECAUSE THERE VPIP IS TO LOW, RATHOLE RULES APPLY, THEY CAN'T JOIN THAT GAME AGAIN FOR 2 HOURS"

`cash_rejoin_constraints.barred_until` (same key as the floor: club + variant

- sb + bb). The nit eviction cashes out with leave mode `vpip_evicted`
  (`atomic_seat_cashout_locked` learns the word; the engine passes it for the
  nit case only); `fn_cash_session_close` writes the bar for the rejoin window
  (two hours, or the game's longer one), whatever the stack - the floor, if they
  were ahead, as before. `fn_cash_rejoin_floor` - the read `atomic_table_buyin`
  makes before any chips move - raises `VPIP_BARRED:<seconds>` while the bar
  stands; `fn_cash_effective_buyin` reports `barred_seconds` instead of raising
  (the buy-in sheet closes and says "You Were Removed For Low VPIP. You May
  Rejoin This Game In N Minutes"); `fn_cash_game_join` refuses `GAME_BARRED`
  before a table is chosen. Horses are players: a barred horse is refused the
  same way. `20260905064000`, probed rolled back on a live chair (bar written,
  floor raises, buy-in refused, modal reports, game bar), applied 03:20 UTC.

## 3. "WHEN THERE IS 3 MINUTES LEFT, THE 15 MINUTES CONVERTS TO BOMB POT IN 1-5 HANDS (RANDOMLY SELECTED HANDS), SO PLAYERS DON'T TANK AND WAIT"

`BombPotScheduler`, timed mode: at the first hand boundary inside the last
`TIMED_ARM_WINDOW_MS` (3 min) of the interval the clock retires and the bomb
becomes N hands away, N drawn once, uniformly from 1..5. From then on
`nextBombDueAt` is null (no clock on the felt) and `handsUntilDue` counts the
hands down - "BOMB POT IN 3 HANDS", "NEXT HAND" - so the number cannot be
moved by slowing play. The interval restarts from the bomb hand as before; the
armed count is persisted with the rest of the scheduler state. Applied to
every timed bomb table (the Action template is one), because the edge it
closes exists on any visible bomb clock. `BombPotScheduler.test.ts` 36 (+4).
