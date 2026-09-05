# The fleet state says when a horse last acted, and the mind remembers tempo

2026-09-05. Two items from the deep audit's situational-awareness list.

## 1. A dead instrument that looked alive

`ca_horse_fleet_state`: 564 rows said `seated`, and on all 1,000 rows
`last_action_at` was NULL, `hands_this_session` was 0 and
`session_started_at` NULL. The fleet manager's minute upsert never carried
those three and `fn_ca_fleet_state_upsert` overwrote them with nothing, so
anything that wrote them could not survive a minute. The panel could not tell
a seated horse that was playing from one that was stuck.

Settlement is the one place that sees every horse-hand, so it touches the
seat: `HorseHandReview` accumulates `(horse, table) -> hands, newest
settlement time` and flushes it on the existing nets timer through
`fn_ca_fleet_seat_touch`, which adds the hands, keeps the newest timestamp,
starts a session on first touch and restarts it when the table changes. The
minute upsert now PRESERVES the three columns when its own row carries
nothing (patched in place from the live definition). Kill switch
`HORSE_SEAT_TOUCH_ENABLED=false`.

Not done here, deliberately: `stable_hand_horse_state` (35 h stale, empty
plans) belongs to the Stable Hand gates (#3141, #3160) and its executor is
logged as "human yield only" - a policy state, not a broken writer.

## 2. The action log had a clock nobody read

Every `ActionRecord` has carried `Date.now()` since the engine was written.
No read looked at it. `HorseMind.observeHandComplete` now classes every river
bet of 20bb+ that reached showdown by the gap since the previous action -
snap under 1.5 s, tank at 8 s or more - and by whether the shown hand was
value: `snapBetSD` / `snapBetSDStrong` / `tankBetSD` / `tankBetSDStrong`,
persisted in `horse_mind_stats` under the same GREATEST merge as every other
counter (the V34 migration is the reason: a read that resets on deploy is a
read for nobody).

`HorseLogic` reads it exactly where the V16 big-bet tell is read - river, a
bet of three quarters of the pot or more - measuring how fast THIS bet came
and asking what this player's bets at that tempo have shown down as. Five
observations minimum; respect moves by 0.08 either way. A horse's own tempo
is randomised (V14), so the read learns nothing from the fleet and everything
from a person, which is who it is for. Receipt `v43_tempo_read`, flag
`v43Tempo` (default on, off in `full_vs_v2_legacy`).

## Not done, and why

The audit listed "the brain cannot tell a human from a horse". It still
cannot, on purpose: CLAUDE.md 10.5 and the naming law say a horse is a player
and is not to be named to those not entitled. A read that keyed on
`is_horse` would be exactly the asymmetry those laws forbid. What the brain
learns about a person it learns the way a person would - from the hands.

## Tests

`HorseV43TempoAndSeatTouch.test.ts` (6): the counters class snap / tank /
neither and ignore a record with no timestamp; the tendency is null under
five; a horse calls a snap bet from a snap-bluffer at least as often as a
mid-tempo one, with the receipt firing only on a classed tempo; the flag
silences it; the legacy card switches it off; the seat touch accumulates per
horse per table with the newest time, horses only. Migration applied;
manifests regenerated; ledger rows for the flag, the receipt and the four
counters.
