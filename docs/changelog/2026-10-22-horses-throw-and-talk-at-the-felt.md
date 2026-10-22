# Horses Throw And Talk At The Felt (2026-10-22)

## Owner Instruction (2026-10-21)

"HORSES SHOULD SOMETIMES THROW SOME EMOJI'S AT PLAYERS THAT BEAT THEM IN A HAND, OR BEFORE THEY GO ALL IN CLICK OR SEND THE GOOD LUCK EMOJI ... CURRENTLY THEY NEVER THROW ANYTHING AT ALL EVER" and "THEY NEED TO SOMETIMES SAY THINGS LIKE NICE HAND OR YOU GOT LUCKY ... INSIDE THE CHAT AFTER A HAND IS OVER." Then: "not always just the good luck, and not every time before going all in. it needs to be random and feel genuine and not like a bot or ai player."

## What Production Showed

- `horse_post_modes.table_talk` was `enabled = false`, and `horse_table_talk_ledger` had 0 rows: no horse had ever written a line.
- Even switched on, table talk only fired on 40 big blind pots, two pair or better losses and full houses shown, with one line per voice.
- No horse throw had ever been charged (`throwable_use_receipts` had 0 horse rows); there was no horse throw path at all.

## What Changed

- Migration `20261022050713_horse_table_talk_and_gestures_on`: `table_talk` on, new `table_gestures` mode on, and `fn_horse_use_throwable` (service role only, horses only) which charges a horse throw through the same `fn_use_throwable_v2` a browser calls.
- `HorseTableTalk.ts`: three new events (`pot_lost` for any lost showdown, `pot_won` for any won pot, `all_in` as a horse shoves) with wide phrase pools ("nh", "nice hand", "you got lucky", "lucky river", "ty", "gl", "one time" and many more). Every event speaks only `SPEAK_CHANCE_PCT` of the time by hash, limits loosened to 6 lines per horse per hour, 5 hands between a horse's lines, 2 hands between lines at a table.
- `HorseTableGestures.ts`: after a hand a beaten horse sometimes throws at the winner (14%), a winner sometimes at a player it beat (6%); when a horse moves all in it sometimes (30%) says good luck in chat, throws something lucky at the player it faces, or taps a Lucky, Clap or Fire reaction. Same `[THROW:id:seat]` / `[REACTION:glyph:seat]` broadcast a browser sends. At most 4 gestures per horse per hour and one per table per 30 seconds.
- `horsePacing.ts`: every line and throw lands a human beat after the moment (1.4 to 5.2 s for a typed line, 0.9 to 3.6 s for a throw, under 0.9 s while shoving), so nothing fires on the same frame as the pot.
- Chat stays cash only, as for a person. Throws and reactions work on every table a person can throw at.

## Proof

- `fn_horse_use_throwable` probed in a self-aborting DO block: a horse returned `success: true, source: lifetime_vip`; a human id returned `Not A Horse`. Nothing committed.
- Tests: `HorseTableGestures.test.ts`, updated `HorseTableTalk.test.ts` and `theHorseSaysNothingItWasNotTold.law.test.ts`.
