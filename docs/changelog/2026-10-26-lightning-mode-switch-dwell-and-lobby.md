# A Lightning game stays in its mode long enough to play it, and the lobby says when it is switching

2026-10-26. Lightning transition, phase 5 of 5. One database migration (waits
for the daily 04:00 maintenance install) and a lobby-only client change. No
engine change, no money moved, no seat touched, no always_on flag changed.

## What production showed

Before always_on was set, the pilot game 681eb9e8 switched between Must Move
and Lightning 19 times in 5 days. The quickest return into Lightning after it
had ended was 48 seconds, and 3 of the 19 returns came within 15 minutes. The
only protection was the gap between the ON and OFF player counts and a
10 second wait before turning OFF. Nothing made the ON side wait, and nothing
kept a game in a mode for any minimum time.

The lobby made each switch worse. While a game was ending (pending_off or
draining) its card still said LIGHTNING LIVE and its door became Join Game,
which sat the player at a table that was halted until the switch finished (up
to 80 seconds). While a game was starting (pending_on) the card said MUST MOVE
and Join Game bought into a halted table (up to 146 seconds).

## What changed in the database

Migration `20261026110858_a_lightning_game_stays_in_its_mode_long_enough_to_play_it`:

- **Turning ON waits 60 seconds.** The player count must stay at or above the
  ON number continuously for 60 seconds before the game starts switching into
  Lightning. The first sighting is remembered on a new column,
  `cash_games.lightning_on_condition_since` (the twin of the existing
  `lightning_off_condition_since`); any pass that does not see the count high
  enough clears it, so a count bouncing around the line never adds up.
- **Turning OFF waits 120 seconds** instead of 10.
- **A game stays in a mode at least 15 minutes** after an automatic switch
  before the next automatic switch. The clock starts when the last switch
  finished. An operator drain does not start it, and an operator enable,
  resume, unfreeze or drain since the last automatic switch lifts it.

All three are settings in the game's Lightning rules, exactly like the old
OFF wait: `pending_on_dwell_ms` (default 60000), `pending_off_dwell_ms`
(default now 120000) and `min_mode_dwell_ms` (default 900000). Setting one to
0 turns it off. `fn_lightning_config` reports all three.

What does not change:

- **always_on games.** They switch exactly as before; neither new wait is ever
  consulted for them and their new column is never written. All 11 live
  Lightning games are always_on today, so nothing they do changes. The two
  Must Move games with Lightning switched on and no always_on are both
  disabled, so nothing can turn them on either.
- **Operator controls and drains.** `fn_lightning_operator_control` and
  `fn_lightning_drain_advance` are not touched. Switching Lightning off, a
  drain, or a disabled game still empties Lightning at once.
- The 3-second five-player wait, the engine, and the in-room "Lightning Is
  Starting" line (awaiting Dan's approval).

How it was checked: the live bodies of `fn_cash_cluster_lightning_drive`
(md5 `e4e4813b063e5f738cab2a12e67b5c2e`), `fn_cash_cluster_begin_pending_off`
(`d146e9c6ab3d051d9b871b70e4b10116`) and `fn_lightning_config`
(`85c851a53fe15425be958144836d5f75`) were read from production with SELECT
only. Every patch anchor was counted in the live bodies (each exactly once).
The drive and the OFF function were rebuilt byte for byte on a scratch local
Postgres (same md5s), the migration was applied there, and the drive was run
through every case: always_on begins at once; a population game waits 60 s,
an oscillating count resets the wait; inside 15 minutes nothing switches;
after 15 minutes the OFF side waits 120 s; switching Lightning off drains at
once even inside the 15 minutes; an operator enable lifts the floor; a game
last changed by a drain is not held; settings of 0 restore the old behaviour.
A second apply refuses. The four `@live-proof` lines evaluate true there.

Why the daily window: adding a column locks `cash_games` for a moment, and
that table is read by every lobby, join and drive pass, so the file declares
`@install-window: daily-maintenance` and installs inside the 04:00 freeze.
Until then production behaves exactly as today.

## What changed in the lobby

- Starting (pending_on): the card says **Lightning Starting**.
- Ending (pending_off or draining): the card says **Lightning Ending**.
- In both, the Join Game door is shown and disabled on the card, the board
  row and the game panel, with no other new text. A player already seated
  still gets Return To Game. Nobody is moved anywhere.
- Classic games and the Short Deck, Omaha Hi-Lo and Pineapple Must Move games
  (which never run Lightning) are unchanged in every mode.

The card's medallions are drawn in capitals by the card's own style, as LIGHTNING
LIVE and MUST MOVE already are; the words themselves are Title Case.

## Tests

- New `tests/lightning/lightning-mode-switch-dwell.law.test.ts`: replays the
  migration's patch against the recorded live preimages
  (`tests/fixtures/lightning-mode-dwell/`), pins the three numbers, the
  always_on and operator exclusions, the md5 guards and the install window.
- New `tests/lightning/lightning-lobby-says-when-switching.test.tsx`: the words,
  the disabled door on all three lobby surfaces, seated players, and the
  unchanged Classic and never-Lightning games.
- Updated the two tests that pinned the old LIGHTNING LIVE / MUST MOVE words
  during a switch (`lightning-phase-6-review-fixes`, `lightning-phase-7-reversion`).

## The Lightning entry page too

The Lightning entry page (`/lightning/<game>`, reached from View Game) offered
its own Join Game during a switch. It now shows the same words ("Lightning
Starting" / "Lightning Ending") and the door disabled, from the same
`clusterModeDisplay`. `tests/lightning/LightningEntryPage.test.tsx` covers
pending_on, pending_off and draining; its no-intent pin for JOIN GAME moved
from a pending_off Cluster (now disabled) to a MUST MOVE one.
