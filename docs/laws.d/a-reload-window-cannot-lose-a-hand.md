# tests/a-reload-window-cannot-lose-a-hand.law.test.ts

A PostgREST schema-cache reload (~28s on this database, fired by every DDL
statement) must not be able to drop a hand's stack write or a fee's queue
insert. Pins that the off-path retry budget in `pendingWrites.ts` is derived
from the measured reload and outlasts several of them, that the inline ladder
stays inside the 20s dealing-step budget instead of parking the table, that
both callers hand an unreachable write off-path rather than alarming, and that
"the database could not be asked" is never reported as "the chips are gone".
