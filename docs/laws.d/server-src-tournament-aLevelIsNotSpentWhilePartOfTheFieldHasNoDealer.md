# server/src/tournament/aLevelIsNotSpentWhilePartOfTheFieldHasNoDealer.law.test.ts

A tournament's blind level is not spent while any of its tables has had no dealer (failing admission) for longer than `FIELD_WITHOUT_DEALER_HOLD_MS`, even if another table is still dealing; the owed level goes up when every table deals again (MTT 85313174 reached level 42 on one heads-up table's hands while 15 parked players could not act, 2026-10-16). The hold ends at `FIELD_WITHOUT_DEALER_HOLD_MAX_MS`, the table's critical page: past it the field plays on (Turbo Tuesday PKO bc8e3d86 was held at one level for 19 hours by one table that never dealt, 2026-10-21).

The finite minority-table hold cannot release the clock when every remaining table is failing admission, including a dealing witness from a subsequently closed table.
