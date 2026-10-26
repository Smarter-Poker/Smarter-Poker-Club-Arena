# server/src/tournament/aParkedTableNeverFreezesOnAnUnprovenMove.law.test.ts

The engine half: a park whose movement admission is refused with a named `F06_MOVEMENT_*` refusal for `UNPROVEN_MOVEMENT_PARK_GRACE_MS` is withdrawn through `fn_f06_withdraw_unproven_movement_park` and its dealer is stopped and readmitted exactly as after the capacity withdrawal, while the refusal is still thrown and reported; a proven roster, any other refusal, or a database without the door never withdraws it.
