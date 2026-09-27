# Settlement attribution completes its bounded aggregate before sampling

The scheduled settlement correctness detector repeatedly reached its 120-second
deadline in its rake-attribution check. Its final LIMIT made PostgreSQL favor
reading every historical attribution and looking up each rake record before
testing the existing 24-hour boundary. Materializing the unchanged aggregate
separates that join plan from the 20-result sample. The predicate, rounding,
lookback, alert-writing loop, identities, privileges and other detector sections
remain exact. No financial writes, jobs or additional indexes are added.

The read-only production query completed in 19.359 seconds with parallel workers
disabled, reading 80,604 recent records. That observation is not the full
detector's live verdict or a measured dollar saving. Native PostgreSQL tests
apply the exact migration, retain function catalog identity, refuse drift and
replay, roll back atomically, compare real results across boundary cases, and
qualify the materialization boundary. The existing required accounting job
executes that fixture for each maintained input.
