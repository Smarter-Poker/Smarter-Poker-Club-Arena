# server/src/tournament/aLevelIsNotSpentWhilePartOfTheFieldHasNoDealer.law.test.ts

A tournament's blind level is not spent while any of its tables has had no dealer (failing admission) for longer than `FIELD_WITHOUT_DEALER_HOLD_MS`, even if another table is still dealing; the owed level goes up when every table deals again (MTT 85313174 reached level 42 on one heads-up table's hands while 15 parked players could not act, 2026-10-16).
