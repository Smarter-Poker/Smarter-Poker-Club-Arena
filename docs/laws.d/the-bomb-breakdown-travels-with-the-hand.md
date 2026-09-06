# server/src/engine/TheBombBreakdownTravelsWithTheHand.law.test.ts

`hand_history` and `bomb_pot_award_units` are written by one call in one transaction (`fn_ca_insert_hand_with_awards`), never as a row followed by an unawaited upsert. Two writes with no transaction between them lost the breakdown for 3 of 125 bomb pots in one measured hour (2026-09-06); the fix is the transaction, not a repair sweep.
