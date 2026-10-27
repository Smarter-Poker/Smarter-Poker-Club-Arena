# Reporting bounds club discovery and shares one day of facts

The installed cutoff repair moved natural job 128 past its former first-query
timeout. Its 06:25 UTC run still exhausted 300 seconds at the fourth fact read;
07:25 and 08:25 later completed, and the closed-day refresh mark was saved.
09:25 through 13:25 then timed out earlier, in the caller's final gap count.

Materialize the requested day's original fact columns once and share that
snapshot across the five existing report insertions. Preserve every aggregation,
acceptance predicate, precision, conflict rule and three returned row counts.
Use the original physical fact alias so the existing ownership contract remains
enforced without changing or weakening its assertions.

The caller previously scanned and deduplicated every recent rake record twice
to discover a small set of clubs. Use the existing club/time index through an
EXISTS probe for each club instead. A validated foreign key with ON DELETE SET
NULL proves the same non-null source club set; installation checks that exact
premise. Preserve union-only clubs, signed and zero rake, inclusive date bounds,
completion markers, original rollup calls, failure handling and gap alerts.
Cron schedule and both existing timeout values remain unchanged.

Source-bound native qualification proves 25 fact visits become five for five
source rows, with identical values in all five report relations and identical
return fields. It checks another day's exclusion, installation rollback, repeats,
private authority and full rollback when a later output refuses. The combined
migration installs and rolls back both exact function bodies in the same native
world. A separate actual caller comparison preserves outputs, calls, markers and
alerts for 0, 1, 3 and NULL days, including missing/marked/failing rollups and
null/deleted clubs. Its isolated executor reads at least 20,000 old source tuples
versus at most ten with indexed probes. This is not a production latency claim;
unchanged rollup helpers are stubbed only in that isolated caller comparison.

The existing required Data PostgreSQL entry enforces all three source-bound
fixtures. No new index, schedule, financial rule or publisher is introduced.
Exact protected-main installation and natural job 128 success with saved report
readback remain required before live completion. No synthetic production report
or financial operation was used as a probe.
