# server/src/tournament/aParkedTableNeverFreezesOnAnUnprovenMove.law.test.ts

The engine half: a park that has existed for `UNPROVEN_MOVEMENT_PARK_GRACE_MS` and whose movement admission still refuses with a named `F06_MOVEMENT_*` refusal is withdrawn through `fn_f06_withdraw_unproven_movement_park` and its dealer is stopped and readmitted exactly as after the capacity withdrawal, while the refusal is still thrown and reported; a proven roster, any other refusal, or a database without the door never withdraws it.

The original park creation time survives manager custody changes; a successor cannot restart the grace. Older database contracts retain their local first-refusal grace. Invalid or future timestamps cannot accelerate withdrawal.
