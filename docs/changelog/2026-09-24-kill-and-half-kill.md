# 2026-09-24 - Kill and Half Kill pots on fixed-limit cash tables (engine, rule manifest `kill-v1`)

The rules are the integration owner's manifest, copied verbatim into
[`docs/rules/kill-pots-kill-v1.md`](../rules/kill-pots-kill-v1.md). This entry
says what the engine does with them and how it ships.

## What a player sees

At a fixed-limit cash table (`flh` or `flo8`) configured for Kill or Half Kill,
a player who scoops a pot of at least the table's threshold (8, 10, 12 or 15
BASE big blinds) is the killer on the next hand. That hand plays at raised
limits and the killer posts a live kill blind before the cards:

| mode | multiplier | a 2/4-blind table (a 4/8 game) plays | kill blind |
| ---- | ---------- | ------------------------------------ | ---------- |
| full | 2/1        | 8/16                                 | 8          |
| half | 3/2        | 6/12                                 | 6          |

The ordinary small and big blinds never change. The felt reads the hand's own
kill (`kill_hand`) and the next hand's pending kill (`kill_next`) from every
state broadcast, and the fixed-limit bet sizes it draws come from the hand's
effective small bet, so the client never draws a bet the controller refuses.

## Engine behaviour (server/src/engine/KillPot.ts is the single source)

- **Exact arithmetic.** Everything money-shaped is integer minor units (cents,
  or whole Diamonds) times a rational multiplier. A base big blind whose minor
  units times the multiplier is not whole (an odd number of cents for half
  kill) is refused, never rounded: the kill is cancelled with
  `half_kill_requires_even_minor_units`.
- **Trigger, once, from the authoritative settlement.** Not a bomb hand, the
  table in half or full, and exactly one player received every award: every
  pot, both halves of every hi-lo pot (a pot with no qualifying low is its high
  winner's), and every Run It Twice board. The contested total is the pots
  after uncalled bets are returned and before rake, jackpot drop or any other
  deduction. A pot with money and no award is never a scoop.
- **Keyed by the triggering hand**, so a duplicate settlement event cannot
  schedule a second kill. Kills chain; the threshold stays in base big blinds
  and limits never escalate past the configured multiplier.
- **The kill hand.** The kill blind is live, is the preflop bet level
  (`currentBet = max(big blind, kill blind)`) and counts as the first preflop
  wager for the four-wager cap. A killer already in a blind posts only the kill
  blind in its place. A short killer is all in for the stack, the level stays
  the full kill blind, side pots apply and no chips are made. Action order is
  unchanged and the killer keeps the option on an unraised pot.
- **Cancellation.** A killer not dealt into the next hand, a table switched to
  off, a table that stopped being a fixed-limit cash table, or a bomb hand
  cancels the kill, and the cancellation is recorded on that hand's row. No
  obligation carries forward.
- **Accounting is unchanged.** `hand_history.small_blind` / `big_blind` stay
  the BASE blinds (the jackpot commit check needs them). Rake, the rake cap,
  the jackpot fee and minimum, stake bands and reporting all use base stakes;
  the kill blind is a forced live contribution and counts in weighted
  contributed rake like every other contribution.
- **Recovery.** The pending kill is written into the triggering hand's own
  `hand_history.kill_pot` inside the atomic hand commit and restored at engine
  start from the table's last settled hand (the `restoreButtonFromHistory`
  pattern). A kill hand abandoned by crash recovery never wrote a row, so the
  re-dealt hand is still the kill hand. A hand in flight keeps its frozen kill
  even if the owner changes the setting; settings apply at the next hand.
- **Horses are players** (CLAUDE.md 10.5): they trigger, post and play kill
  hands under the same rules, and the horse policy reads the hand's effective
  bet size.

## Engine and database ship in either order

The database half is migration `20260924034010_kill_pot_table_settings`
(branch `agent/claude-ca-product/feat/kill-pot-table-settings`): the columns
`tables.kill_mode` / `tables.kill_threshold_bb` and `hand_history.kill_pot`, a
trigger that refuses any kill configuration the engine cannot honour, and the
owner door `fn_set_cash_game_kill_settings`, gated on capability
`cash.fixed_limit.kill_pots` being deployed. This engine does not need it to
be installed first:

- `loadTable` and the throttled next-hand rule re-read (`refreshRakeConfig`)
  no longer name the kill columns in their row reads. `loadKillSettings`
  (`server/src/services/supabase/tables.ts`) reads them beside the row, in
  flight at the same time. Postgres `42703` (undefined column) or PostgREST
  `PGRST204` means the database does not have them yet: kill is off, and the
  engine says so once per process. Any other error is a failure: `loadTable`
  throws it, and the re-read reports it and keeps the table's current kill
  setting, so a blip never turns a kill on or off. Before this change a
  missing column would have failed every table load, and would have made the
  re-read silently stop applying every other rule (antes, bombs, run it twice).
- `restoreKillFromHistory` treats a missing `hand_history.kill_pot` as "no kill
  was ever recorded" without a warning; any other read failure still warns.
- **Writing `kill_pot` needs no branch.** The hand row reaches the table
  through `fn_ca_insert_hand_with_awards`, which inserts only the keys of the
  row that are real `hand_history` columns (its column list comes from
  `information_schema.columns ... AND p_row ? c.column_name`). So before the
  migration the key is ignored and the hand commits; after it the record is
  stored. The live body is the repository body (20260918092329 pins its
  `md5(pg_get_functiondef)` as `e7f05bb7d61360be7424c5f429066047`, which the
  repository definition reproduces). Pinned by
  `server/src/services/supabase/handHistory.killPotColumn.test.ts`, and
  executed both ways by `scripts/ci/test-kill-pot-table-settings.py` on the
  database branch.

## Tests

`KillPot.test.ts`, `HandController.killpot.test.ts`, `KillPotEngine.test.ts`,
the kill cases in `ChipConservation.property.test.ts`,
`RemainingVariantLivePolicy.test.ts` and `handHistory.test.ts`, plus for the
either-order delivery `tables.killSettings.test.ts`, `KillSettingsReRead.test.ts`
and `handHistory.killPotColumn.test.ts`. `DiamondCashBoundary.test.ts` now
expects the chip `loadTable` to read `tables` twice (the row and its kill
settings) and still never the Diamond settings row.
