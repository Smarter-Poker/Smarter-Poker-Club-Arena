# Today resets at midnight Chicago time

The Player Record and Players list Today cash and tournament results use the
America/Chicago calendar day, including daylight saving transitions. Cash reuses the existing UTC daily totals and subtracts timestamped edge facts
with the existing funded-club resolver and launch accounting cutoff. A concurrent
cash-only index keeps tournament history out of those boundary reads. Existing
weekly, monthly and overall accounting stays unchanged. The note names both
conventions explicitly.

Mounted views invalidate their figures at the next Chicago midnight and on
focus or visibility return after sleeping across it. No polling or release
schedule is introduced. The database remains authoritative for every result.

The existing Member Record PostgreSQL qualification now reproduces the old
boundary error, then verifies both readers, half-open midnight boundaries,
winter/summer offsets, 23/25-hour DST days, year rollover, funded attribution,
launch cutoffs, permissions, unchanged longer periods and replay refusal.
Client tests cover boundary events, wake-up refresh, cache invalidation and
timer cleanup. No money, facts, retention or engine settings are written.

Delivery evidence is retained in the task checkpoint under
`/Volumes/SmarterArchives/agent-evidence/chicago-stats-01a16a9f/CHECKPOINT.md`.
