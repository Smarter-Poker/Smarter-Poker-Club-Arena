# PLO5 1/2 Madness without Lightning (2026-10-24)

Dan: "A 1/2 PLO5 MADNESS GAME WHILE THE BUGS ARE BEING WORKED OUT FOR LIGHTNING
GAMES. START IT NOW, 50% VPIP BB ANTE. AND ADD THE BEST PLO HORSES TO THE GAME."

## Why it is not a Madness-template row

Since `20261023230807` the Madness template is Lightning Games: the creator
forces Lightning on, refuses a second enabled Madness game at a stake, and the
floor trigger pins every Madness snapshot to 40%. The Lightning PLO5 1/2 game
stays live for the Lightning work, so the stand-in is an ordinary Classic
must-move game carrying one named rules profile.

## What changed

- `fn_cash_game_floor_from_template` honours `rules_profile =
  'madness_without_lightning'` on a Classic, non-Lightning game only: the
  Madness promise (BB ante, two-board 3 BB bomb pots every 10 minutes) with a
  50% floor over 10 hands. No other game changes.
- "PLO5 1/2 Madness" opened in Midway Union: 6-max, must-move, 100-200 BB,
  Lightning off. Main 1 opened through `fn_cash_cluster_open_table` and
  projected by `fn_cash_apply_ruleset`; the migration asserts the table carries
  every promise and aborts if not.
- Pinned by `tests/unit/plo5MadnessWithoutLightning.test.ts`.

## Horses

Every horse runs the same fleet brain, so the PLO layers (phase 11/13/15 PLO5
policies, opponent memory snapshots, range-advantage continuation, Omaha flush
stack-off guards) apply at this table exactly as at every other. Low-stake-band
cash horses with the best measured PLO results are seated through the normal
treasury seat path; the fleet keeps the game topped up after that.

## Turning it off

`fn_cash_game_switch_off` retires it like any Classic game. While it is enabled
it holds the Midway Classic PLO5 1/2 must-move key, so the dormant ordinary
"PLO5 1/2 Classic" cannot be re-enabled beside it.
