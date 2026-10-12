# server/src/tournament/aParkWhoseRosterCannotBeSeatedIsWithdrawn.law.test.ts

A tournament table-break park that has not begun and whose roster has found no free seats for UNPLACEABLE_PARK_GRACE_MS is withdrawn through `fn_f06_withdraw_unplaceable_park`, its dealer stopped and readmitted so the table deals again; a park refused for any other reason, or one the database finds room for, is never withdrawn and its dealer is untouched.
