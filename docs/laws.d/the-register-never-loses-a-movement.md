# tests/the-register-never-loses-a-movement.law.test.ts

The diamond register followed the journal under an xact-scoped global advisory
lock, so every movement serialised the whole economy behind the caller's
transaction; on 2026-09-08 twenty-seven movements died on lock_timeout and the
money identity broke. The lock is gone from the follow path, a register that
cannot be written is an incident rather than a refused reward, and only the
movements an incident recorded as lost are ever replayed. The same law pins the
horse's claim to the whole seven-day window a human gets, oldest first, silent
when the refusal is the daily cap, and pins the economy instruments that shipped
always-on or fooled by a mention.
