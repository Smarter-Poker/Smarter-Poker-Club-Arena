# Retention releases maintenance admission between pages

The history pruner held its shared maintenance lane while looping across pages for a 20-second work budget. A queued exclusive maintenance operation can block subsequent shared continuation requests, whose admission timeout is one second. The earlier discovery budget change did not alter this original pruning phase.

The existing pruning invocation now processes one existing raw page of at most 250 rows and commits its cursor together with disposal, archival and deletion. Its existing caller commits before the next phase. An unfinished pass continues past the hourly boundary; a completed pass retains the existing hourly revisit. Human history, the eight-day policy, original-hand custody, accounting guards and financial records retain their existing rules.

Production recorded 881,640 new hands in the preceding 24 hours at 16:00:28 UTC. A single 250-row page every 30 seconds could scan only 720,000 rows per day. The same existing cron job therefore runs every 10 seconds, providing a nominal 2,160,000 raw-row capacity with room to traverse retained evidence. The migration checks the exact job identity, original command and schedule, changes that job through `cron.alter_job`, and verifies that its command and identity remain intact. It adds no job.

The native qualification binds the exact installed preimage and candidate, checks cursor progress, equal timestamps, retained evidence, rollback and maintenance-lock release. Required accounting shard four executes it. A single page is a row bound, not a wall-clock guarantee; installation and natural production progress, lock contention and engine-kill evidence remain required before incident closure.
