# A degraded engine can still be replaced

2026-09-11 · deploy train (`.github/workflows/auto-deploy-hetzner.yml`)

## What happened

At 06:58 UTC, after the thaw surge, the engine's equity worker pool went
permanently `failed`. From then on `/health` reported `status: "degraded"`,
and `server/src/handlers/health.ts` answers **503** for anything that is not
routing-ready. It sends the same body with the 503. The handler's comment
names the deploy verifier as the reader it keeps that body for.

The deploy train read `/health` with `curl -sf`. `-f` turns any non-2xx
answer into an empty string, so every read failed. Run 34571396262 carried
#4249, #4255, #4256 and #4257. It polled its break gate 175 times and logged
`/health unreadable` on every poll. At 07:55:08 a complete restart
certificate went by unread: counting*down, durable, 0 unparked tables,
290 s left. The run shipped nothing. The build that would have replaced the
degraded engine could not ship \_because* the engine was degraded.

The host's locked re-check used the same `-f` under `set -e`, so fixing the
runner side alone would still have refused the cutover.

Players were not affected. Caddy has a single upstream and no active health
check, so it routes regardless of the 503.

## The fix

Two changes landed within minutes of each other and are reconciled here.

#4267 (`read valid restart certificates from degraded engines`) fixed the
two certificate reads: the runner's break gate and the host's locked
re-check. Both now read the body of a 200 or 503 answer after a complete
transfer, and anything else still fails closed. That form is kept as is.

This change fixes the four remaining reads that ask what the engine is.
Each one now reads the body whatever the HTTP code:

| Step                                          | Read                                |
| --------------------------------------------- | ----------------------------------- |
| Skip if production already serves this commit | version                             |
| Verify: the public hostname check             | version                             |
| Commit the verified SHA/image-ID release seal | identity + liveness, under the lock |
| Verdict                                       | version                             |

The seal-commit re-check matters most. The Verify step has already required
a routing-ready 200. A later 503, for example from a worker pool restarting
under the thaw surge, must not refuse the seal and roll back a verified
build.

Two places keep `-f` on purpose, and each now says so:

- the post-cutover **Verify** loop, because a new build is not verified
  until it answers a routing-ready 200;
- **ROLLBACK** recovery verification, for the same reason.

## Pinned by

`tests/a-degraded-engine-can-still-be-replaced.law.test.ts`:

- The certificate and identity steps contain no `curl -f` read of `/health`.
- Only the Verify and ROLLBACK steps keep `-f`.
- The host re-check keeps its fail-closed order: `set -euo pipefail`, then
  the read, then the marker.
- The real drain-gate script is run against a loopback stub that answers 503
  with a complete certificate. It must accept on the first poll. Against the
  previous workflow it logs `unreadable` until it is killed. Verified: 8 of
  the 10 cases fail on the old file.

`tests/engine-recovery-healthcheck.law.test.ts` already pinned the same rule
for the host supervisor, which had the same bug.
