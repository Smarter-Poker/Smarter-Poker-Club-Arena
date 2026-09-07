# 2026-09-07 - the outgoing engine's log survives the deploy

The engine container is replaced every hour and `docker rm` deletes its
json-file log with it. On 2026-09-07 the engine was unreachable for a minute
at 16:52 UTC and came back inside an off-schedule break (the 17:00 scorecard's
only `fail` of the day, 420s recovery); by the time anyone looked, the
container that did it had been replaced twice and there was nothing to read.

`server/scripts/engine-up.sh` - the one run-spec both the deploy and the host
supervisor use - now saves the outgoing container's whole retained log
(`docker logs -t`, up to the json-file's 5 x 50 MB) to
`/var/log/club-arena-engine/engine-<stopped>-started<started>-<id>-<image>.log.gz`
between `docker stop` and `docker rm`. Measured on the live container: 46 MB
raw, 14 MB gzipped, ~490k lines per hour. Retention is fourteen days or 6 GB,
oldest first, and the newest file is never deleted whatever the cap says. A
failed dump warns and never stops the deploy. The deploy workflow prints the
newest three file names in its own log after cutover.

Pinned by `tests/unit/theOutgoingEngineLogSurvivesTheDeploy.test.ts`. Verified
by running the function against the live container on the host (twice, with a
1 MB cap, to exercise the size prune and the keep-newest rule).
