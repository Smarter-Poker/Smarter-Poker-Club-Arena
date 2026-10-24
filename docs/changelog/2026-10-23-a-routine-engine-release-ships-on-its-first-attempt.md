# A Routine Engine Release Ships On Its First Attempt (2026-10-23)

Two engine releases reported "the durable Hetzner release transaction did not complete": attempt row 1160 (run 39728449445-1, 1788793e, 2026-10-22 06:34 UTC) and row 1166 (run 39902613436-1, 734578ad, 2026-10-23 05:12 UTC). Both were safe refusals: the transaction restored the sealed release and the engine kept serving. Both also restarted the engine outside the daily 4 AM Chicago break, because the urgent commit trailer authorized an off-cycle window. That part is fixed by PR #7777.

## What Spent The Cutover Budget

The candidate replacement has 75 seconds, measured from `docker stop` to the new container returning.

- Row 1160: stop 12.9 s, image snapshot 23.9 s, bridge network join 44.7 s, 81.5 s in total. The image had never had a container. Over every cutover since 2026-10-17, first runs of a new image took up to 40 s to create and 52 s to join the network; restarts of an already-run image took 0.3 s for both.
- Row 1166: the old engine logged "Shutdown complete." 6.7 s after SIGTERM, then waited 33 s more for its hard deadline. Docker killed it at 45 s. The candidate then spent 7 s creating its container, and the remaining proof steps ran past the break's proof reserve. The same idle wait ended 13 of the 14 engine drains on 2026-10-22 and 2026-10-23 at the 40 s deadline with exit code 1.

## What Changed

1. Engine shutdown no longer waits on idle transports after ownership is released. The HTTP server closes idle keep-alive sockets immediately and every remaining socket after 3 s. Both WebSocket servers terminate any peer that has not answered the close frame after 3 s. Before this, ws waited 30 s per peer.
2. The release transaction runs one throwaway container from the exact candidate image right after the build, outside any break. It has no ports, labels or env file, and it runs `node -e 'process.exit(0)'`. A failed warm-up is never fatal.
3. The daily digest counts a refused attempt as shipped when the same exact SHA shipped later within twelve hours (`retried`, beside `superseded`). Migration `20261023140557`.

The 75 s budget, the 135 s rollback reserve and every proof are unchanged.
