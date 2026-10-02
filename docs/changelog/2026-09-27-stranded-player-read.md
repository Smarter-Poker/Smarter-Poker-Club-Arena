# Stranded-player audit filters occupied players before reading old stacks

The natural conservation run 695609 timed out after 120 seconds in the
stranded-player reader. The original plan evaluated the historical-seat lookup
before excluding occupied players and repeated that lookup for the aggregate.
Two materialization boundaries retain the original membership, latest-seat,
positive-stack, rounding, grouping and finding text while avoiding those reads.
The function keeps its identity, owner, execution grants and configuration.

The maintained native PostgreSQL fixture compares the complete old and new
results with independent expected findings, null/zero/negative stacks, live
seats in another event, eliminated/null/custom roster status, completed events,
snapshot concurrency, rollback, drift refusal and actual restricted roles.
A synthetic 12,000 occupied-player case exercises the original amplification.
The existing required PostgreSQL job runs this fixture for every changed input.
No financial record, runtime recovery, schedule or timeout setting is changed.
Production installation and the next natural whole audit remain separate proof.

Installed once as `20260927150637`, preserving function OID25456281 and its
owner/grants/configuration. The unchanged whole-function read completed in
2.438 seconds at15:06 UTC with zero findings; this is not the next natural
conservation job result or a billed-savings measurement.
