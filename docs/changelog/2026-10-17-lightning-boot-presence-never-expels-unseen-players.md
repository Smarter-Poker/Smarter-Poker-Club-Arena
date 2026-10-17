# Lightning boot presence never expels a player it cannot see

**Measured on the private Lightning pilot, 2026-10-17.** Action converted to Lightning at 13:11 UTC with 54 seated players in its pool. At 13:56, the boot presence pass after the 13:55 engine restart stamped all 54 pool sessions `disconnected`; the reaper exited every one at 15:00:55 (`disconnect_expired`). Only a Lightning room socket reports a reconnect, and the players were horses, whose input device is the anchor engine's heartbeat, so nothing could ever un-stamp them. Every hourly restart would empty the pool of every horse.

**Cause.** `reconcileLightningPresence` ran 30 s after boot, inside the maintenance freeze, before any anchor engine was back, and reported every open session not in the `connected` set. A player nobody here had reported on yet (unknown) was treated as absent.

**Fix.**

- Only a definite absence is stamped: a player this Cluster's own anchor or room reports as disconnected and who is connected nowhere. Unknown is never stamped. The matcher's per-pass feed still withholds an unknown player from the deal, so nobody is dealt to an empty chair.
- The boot pass waits out the maintenance freeze (`isMaintenanceFrozen()`), then the same settling delay, before it judges anyone.

Pinned in `server/src/lightning/LightningBootPresence.test.ts`, including the 54-player case.

The 54 already-exited sessions are re-entered through the audited operator door (`pause` then `resume`, which calls `fn_lightning_pool_enter_seated`); their anchor seats and stacks were never touched.
