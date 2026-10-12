# A waiting table still asks who is there (2026-10-06)

## What was wrong

Presence (stale heartbeats, the stay-clock sweep, the release of leaves the
clock holds) was judged only by the engine's heartbeat tick. The tick is armed
after the start-up wait loop breaks, and a cash table below its deal minimum
never leaves that loop. Every engine starts there, including after each hourly
restart, where presence comes back from the park snapshot as CONNECTED and was
never asked again.

Production, 2026-10-04, table 58b2c844: a human whose last action was 19:53
sat alone with the stack on the felt for about 1h45m, then was dealt in and
blinded three times when horses arrived. The five-minute "nobody behind the
seat" rule ran within seven minutes once the dealing loop started.

## The fix, at the cause

`ServerTableEngineBase.judgePresenceWhileWaiting()` is the presence half of
the tick, run from the wait loop's own pass, after `adoptMovedPresence` and
the sit-out restore and before `evictExpiredSitOuts`: every seated player is
registered with the presence FSM, a horse gets the same synthetic beat the
tick gives it before staleness is judged, stale heartbeats are concluded, and
the stay clocks are told. The eviction that follows then applies the same
five-minute rule the dealing loop applies. It stands down once the tick owns
presence, on tournament tables, and during the maintenance freeze. Nothing is
scheduled: it is the loop the table is already running.

Horses and humans are judged by the same rule; the horse's synthetic beat is
its input device, exactly as in the tick.

## Proof

`server/src/engine/AWaitingTableStillAsksWhoIsThere.test.ts`: a silent human
is concluded gone after the table's disconnect timeout and is evictable five
minutes later; a human whose client keeps beating never is; a horse stays
connected however long a pass takes.
