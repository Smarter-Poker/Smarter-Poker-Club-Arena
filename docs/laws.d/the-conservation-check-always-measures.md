# tests/the-conservation-check-always-measures.law.test.ts

fn_ca_trial_balance is the global chip-conservation check for all fourteen
accounts. It chose its snapshot window with a clock guess - the first snapshot
at or after now() minus 75 minutes - while snapshots land at :05:00.9 and the
watch runs at :20:00.5, so the window cleared the snapshot by four tenths of a
second and scheduler jitter decided whether the platform measured itself at
all: 168 cron runs in seven days produced six readings, 3.6%, none before that
day. Because the watch files only on two CONSECUTIVE breaching readings, and
readings that rare are almost never adjacent, it could effectively never fire.
Pins that the window is taken from the snapshots themselves - the two most
recent rows, one interval, every run - that p_since survives only as an
explicit override, that BOTH the check and its watch lose the clock default
(or the watch passes the old value down), and that the migration refuses to
finish unless all fourteen accounts return a non-NULL difference.
