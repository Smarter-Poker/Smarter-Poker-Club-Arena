# Diamond Phase 8: The Tournament Door Has A Switch

Status: Phase 8 In Progress. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door, And Now One Of Those Doors Actually Refuses Them.

## A Branch That Never Asked Whether It Was Open

`fn_poker_diamond_reserve` moves real Diamonds out of a real wallet into custody, and it has always had two branches. The cash branch prices against a table's buy-in range. The tournament branch prices against a tournament's buy-in plus fee. Both then reserve.

Only one of them asked whether it was open. The cash path is admitted through `ca_arena_settings.cash_games_enabled`, which defaults to false and is checked inside the same fail-closed lookup that finds the table. The tournament path checked nothing. It found the tournament, priced the entry, and reserved.

## Why That Was Harmless, And Why That Is Not A Defence

It was harmless for one reason: nothing called it. No Diamond tournament exists, `poker_diamond_custody` holds zero rows, and the function's only caller in the database is the cash buy-in. No money has ever moved through the open door.

The danger was never the past. It was that the first server code to call this for a tournament would be admitted, with no switch anywhere to refuse it, and no way for whoever wrote that caller to notice that nothing was guarding them. A door that is merely unused is not a door that is shut.

The switch has to exist before the caller does. That is the whole reason this lands now rather than alongside the entry function it will eventually gate.

## What It Does

`ca_arena_settings` gains `tournaments_enabled`, NOT NULL, defaulting to false. The tournament branch is gated on it in the same lookup that finds the row, so a chip club, a union-owned tournament, a missing settings row and a closed switch all arrive as NOT FOUND rather than as four separate checks somebody can reorder or forget. That shape is copied from the cash door deliberately rather than invented.

The price check stays a separate failure. "This arena is not open" and "you offered the wrong amount" are different answers, and a caller that cannot tell them apart will retry the one it cannot fix.

The gate was exercised in the isolated fixture across every way it can refuse: switch off, switch on with a union-owned tournament, switch on with a chip club, and no arena settings row at all. Each one refuses. With the switch on and the row clean, the entry prices at 110 against a 100 buy-in and a 10 fee, and a 999 offer is still refused separately as a bad price.

## What It Does Not Do

It does not open anything. `tournaments_enabled` ships false, so the effect on the running estate is to turn an unguarded path into a refused one. Diamond cash is untouched and `cash_games_enabled` keeps its own value and its own meaning. The new law asserts both: that the migration does not flip its own switch on, and that it does not touch the cash one.

It also does not write the first `tournament_entry` custody row. Writing one is a buy-in against a real wallet, which is outside what this work is authorised to do, and proving the accept path end to end needs the whole Diamond money schema standing up in the fixture rather than the four tables the gate itself touches. What is proved here is the gate: that it refuses when closed, and that it is not a permanent block when open.

## Applied

Migration `20260912112311_the_tournament_door_has_a_switch.sql`, applied once. Never reapply.

`tournaments_enabled` is false, `cash_games_enabled` is unchanged, custody holds zero rows, and the reserve function keeps its `{postgres, service_role}` door.
