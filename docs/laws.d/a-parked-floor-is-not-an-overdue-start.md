# tests/a-parked-floor-is-not-an-overdue-start.law.test.ts

A tournament start the operator floor is deliberately holding (or released less than 15 minutes ago) is listed as held_by_operator in fn_ca_launch_health instead of turning the launch red, every other late start stays red, and the floor hold watchdog closes its alert once every close whose table still exists is resumed.
