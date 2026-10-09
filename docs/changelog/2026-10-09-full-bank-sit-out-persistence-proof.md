# Full Bank Sit-Out Persistence Regression

The existing manual and automatic full-bank expiry tests now exercise the real
ServerTableEngine constructor persistence callback with a seat occupancy identity.
An isolated seat adapter observes the exact update predicates and applies them to
a current seat plus other-table, other-player, former-occupancy and departed-seat
controls. Both paths must persist sitting-out, preserve it through heartbeat and
clear it only after explicit return, without touching the control seats.

This extends the already deployed player-control fix with regression protection.
It changes no runtime, database migration, artwork or financial behavior. The
adapter proves the connected persistence request and guarded state transition;
it does not claim a real production bank-expiry hand or a PostgreSQL integration.
