# Horses read what a river caller showed down

## Why

Dan ruled on 2026-10-25 that when a player calls a bet on the river and loses,
that hand is shown. A separate engine change makes the table show every hand
whose last river decision was a call, so the showdown record carries
`mucked: false` and a `hand_name` for river callers. Humans now see what an
opponent called the river with. CLAUDE.md 10.5 requires the horses to learn
from the same information, and until now HorseMind only learned from the river
BETTOR's shown hand (the V16 `bigBetSD` read). Nothing read what a caller
showed.

## What changed

**Observation** (`HorseMind.observeHandComplete`, beside the V16 river loop).
For every player whose LAST river action was a call, and who is in the
showdown record with `mucked === false`:

- `riverCallSD` += 1
- `riverCallSDWeak` += 1 when the shown `hand_name` is one pair or worse
  (`High Card`, `Pair`, as `PokerEngine` names them; `One Pair` also accepted)

What counts as a call: the `call` action, or an `all_in` whose amount (the
street bet level it reaches) is not above the river bet level already standing.
An all-in above that level raised (full or short) and is not a call; an all-in
into an unbet river is a bet. The amount comparison was chosen over
`isFullRaise` because a short all-in raise carries `isFullRaise: false` yet
still raised. Counted once per player per hand (only the last river action is
kept). Earlier-street calls never count; a mucked or absent hand teaches
nothing.

**Read.** `HorseMind.riverCallLightTendency(id)`: null under five shown calls,
else `riverCallSDWeak / riverCallSD`.

**Decision** (`HorseLogic`, right after the V23 river fold read, same gate:
`v23Reads`, mind on, river, heads-up). Against an opponent whose read is at
least 0.5:

- river bluff volume `bluffScale` x0.85 at 0.5, down to x0.70 at 0.75 or more
- the thin-value bar drops 2 points at 0.5, up to 4 points at 0.75 or more

Below 0.5, or under five samples, nothing changes. The read is the same for
every opponent; there is no `is_horse` branch. Telemetry receipt:
`river_call_light_read`.

**Persistence.** Both counters are GREATEST-merged in `horse_mind_stats` and
`horse_mind_stats_scoped` by migration
`20261026033405_horse_mind_river_call_reads.sql`. Both tables are written
throughout play (about 7.7M and 10.0M updates), so the migration declares
`-- @install-window: daily-maintenance` and installs at the 04:00 Chicago
window. Until then the engine still works. The flush sends the two new keys,
and the current RPCs ignore keys they do not name. The hydrate drops only the
absent columns from its projection on a 42703 that names them, then reads them
as 0. The RPC bodies are the live bodies, md5-checked as a preimage, with only
the two columns added.

**Read frames.** `HorseDecisionReadFrame` gains `horse-decision-reads-v6`,
which is v5 plus `riverCalls` / `scopedRiverCalls` rows. It is written only
when a captured counter is non-zero, so every existing frame keeps its exact
bytes, and v1-v5 frames decode with both counters at 0. The positional stat
rows keep their length.

## Tests

- `server/src/engine/HorseRiverCallRead.test.ts`: counters, threshold, call
  vs raise vs all-in, once per hand, scoped bucket, and the decision nudge
  (fewer bluffs, thinner value), identical against a horse or a human
  opponent
- `HorseDecisionReadFrame.test.ts`: v5 bytes unchanged at zero, v6
  round-trip, malformed v6 refused
- `HorseMindPersistence.window.test.ts`: flush mapping, hydrate round-trip,
  hydrate before the columns exist
