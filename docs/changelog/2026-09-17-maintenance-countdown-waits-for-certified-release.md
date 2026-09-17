# Maintenance presentation follows confirmed release

An hourly countdown previously cleared the maintenance overlay at the scheduled deadline, even while the database was still certifying its clock credits. The engine also emitted one fleet-wide end after an unrelated scorecard write, without regard to each table's resume wave.

The existing maintenance owner now projects finalizing, the actual certified resume time, and resuming separately from its unchanged persisted phases and release gates. Each table receives its end only after its maintenance flag is released; the existing lobby channel receives transition events and final fleet completion. Authenticated resync replays the current table presentation. Public health exposes the same presentation without changing existing publisher fields.

The client reads health first, retains the persisted announcement as an outage fallback, and changes an expired countdown to finalizing. Reads occur on mount, deadline, reconnect, online and visibility events. Revision and break identity fences reject delayed reads and old end events. No periodic request, thaw, financial operation or release mechanism was added.

Validation: 90 existing maintenance owner/v3 tests and 81 client presentation/clock/restart tests passed. The previous implementation failed the deadline-retention, stale-break-end and expired persisted-announcement assertions; two server projection tests also failed against it. The suite additionally covers a future database certificate with a fast host clock, failed table resumes, and delayed health responses. Full hosted checks and production verification are recorded separately.
