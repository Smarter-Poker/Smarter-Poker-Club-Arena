# The outgoing-log proof reads order, not a stopwatch

2026-10-26

## What failed

Publisher run 40316088773 (main at bcff924895) stopped before the origin
because `client-tests (2)` failed one test:
`tests/the-outgoing-log-is-saved-after-the-replacement-starts.law.test.ts`,
"returns from the Docker start receipt even when a subsequent inspection
stalls, then keeps the log", with `expected 3425 to be less than 2000`.

Every behavioural assertion in that test passed. The phase order was right,
the replacement started before the outgoing log was saved, both logs were kept
and both outgoing containers were retired. Only the wall-clock bound failed:
the fake Docker dump took two seconds, and the test demanded that engine-up
return in under 2000 ms. On a busy shared runner the script's own work (about
thirty fake Docker calls) took 3425 ms with nothing waiting on a dump. That
release did not publish. The next merge published normally.

## The fix

The proof now checks the order of events instead of elapsed time:

- The fake `docker logs` and the stalled `docker inspect` of the serving
  container both wait on a gate file that only the test can create. They give
  up after 30 seconds as a ceiling.
- When engine-up returns, the test requires that no dump has completed yet.
  It reads the "saved the outgoing log" line, which is written only after a
  dump succeeds. It does not use the `.log.gz` file, because gzip creates that
  file the moment a dump starts.
- The test then opens the gate and requires both logs to be saved and both
  containers retired, as before.
- The time bound is now a coarse 15 seconds, which only catches a hang.

A script that waited on a dump or on the stalled inspection would block on
the gate, and spawnSync's 20-second timeout would kill it. A returned script
cannot have finished a dump, because none can finish before the gate opens.

## Proof

- Passes 3 of 3 locally.
- Passes 3 of 3 with the machine oversubscribed at twice its core count. That
  is the condition that broke the old bound.
- Mutation: removing the trailing `&` from `retire_outgoing_in_background` in
  `server/scripts/engine-up.sh`, so the retirement runs in the foreground,
  turns the test red. spawnSync killed the script at the 20-second limit
  (status 143). The script was restored before commit.

`server/scripts/engine-up.sh` itself is unchanged.
