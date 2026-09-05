# 2026-09-05 — Ready is not dealing: the on-demand door returns when the engine exists

Root fix for the contract behind BUG 4 of `2026-09-05-cluster-autonomy-live-audit.md`,
which the cluster controller worked around (fire-and-forget wake) and which
`2026-09-04-templated-rules-visible-and-the-ten-hand-floor.md` recorded as
still hanging `GET /state`, `GET /actions` and the WS `ensureTable`.

## The contract that was wrong

`ServerTableEngine.start()` resolves when the DEALING LOOP starts, which is
after `start_wait_for_players` sees the AutoStart figure of seated players.
For a one-player table that is "when a second player arrives", possibly
never. `GameServer.ensureCashTableEngine` returned `start()`'s promise, and
its own doc comment said the opposite of what it did: "lets start() publish
the waiting snapshot as soon as its database reads complete". So:

- A player opening a table nobody else was on: `GET /state` awaited a second
  player before answering the first.
- The same for `GET /actions` and the WebSocket `ensureTable` (both
  admission paths call it when no engine is in the map).
- The cluster controller's WAKE awaited it and parked a worker per lone
  Main 1; the `inTick` latch then parked the whole controller (BUG 4).

## The fix

`ServerTableEngineBase` gets a public `ready: Promise<boolean>`, settled once:

- `true` at the FSM's `waiting` transition — row loaded, every sub-engine
  configured, waiting snapshot publishable. The wait for players that
  follows is the engine's business, not the caller's.
- `false` if `start()` fails before that, or `stop()` / `killForRestart()`
  runs first. A later settle is a no-op; it never rejects.

`ensureCashTableEngine` returns `engine.ready` and stores it as the
collapse-concurrent-connects promise. The `start()` chain keeps running
exactly as before for its failure handling (map slot, hub room and lease
freed on `on_demand_table_start_failed`).

Nothing else changed. The controller's fire-and-forget wake and its 120 s
stall guard stay — they are correct on their own terms and the guard is
worth having regardless.

Tests: `ReadyIsNotDealing.test.ts` — true at `waiting` with one seated
player while `start()` is still parked; false on a failed start; false on a
stop before `waiting`; settled once; the door hands out `ready` and keeps the
start chain's failure handling.
