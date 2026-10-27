# Reporting shares one day of facts across all five outputs

The first cutoff repair installed successfully, and natural job 128 moved past
its former first-query timeout. Its 06:25 UTC run still exhausted 300 seconds
at the tournament aggregation. The fact relation has about 2.2 million rows;
its only index starts with club ID, and the affected date/kind aggregation
plans a sequential scan. The producer independently read that relation five
times. No blocking transaction was present during the observed disk read wait.

Materialize only the requested day's original fact columns once, and share that
snapshot across the existing five insertions in one SQL statement. Each original
aggregation, acceptance predicate, precision, conflict rule and private grant
remains. Count RETURNING rows for the same three return fields. The five earlier
deletions and the entire function still roll back on failure. Production catalog
readback found no user triggers on these five report relations. This changes no
cron, retention rule, financial writer or maintenance publisher.

The source-bound native regression counts actual executor visits: the old
producer visits five source rows 25 times, while the replacement visits them
five times. The one-read assertion fails against the actual old body. All five
report outputs and returned row counts remain identical, including exclusion
of the other day's sentinel, launch cutoff behavior, rounding and private ACLs.
Migration rollback and repeated invocation retain their original behavior. The
existing required Data PostgreSQL entry enforces both reporting qualifications.

Exact protected-main installation and a naturally started post-install job 128,
including the closed-day refresh mark, remain required before live completion.
No synthetic production report or financial operation was used as a probe.
