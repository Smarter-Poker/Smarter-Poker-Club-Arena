# tests/the-outgoing-log-is-saved-after-the-replacement-starts.law.test.ts

engine-up.sh renames the stopped engine out of the way and starts the replacement before it dumps the outgoing log, so the log dump never spends maintenance-break seconds with no engine serving.
