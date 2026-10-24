# tests/the-replacement-is-created-during-the-outgoing-grace.law.test.ts

engine-up.sh creates the replacement container (no process, no journal, no published port) while the outgoing engine spends its unchanged 45-second SIGTERM grace, and starts it only after the old process has exited and been renamed away, so stop and create are no longer paid in series inside the 75-second cutover budget.
