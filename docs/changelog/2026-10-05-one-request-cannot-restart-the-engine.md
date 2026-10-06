# One request cannot restart the engine

2026-10-05. Launch audit blocker 1 and three engine exposure items. Engine only.

## What was wrong

`server/src/index.ts` treats any uncaughtException or unhandledRejection as
fatal: the engine drains and restarts, and every hand in flight is voided. That
is the right response to a corrupted process. It also meant that anything a
stranger could make throw was a restart button.

1. **The WebSocket upgrade.** `EngineWebSocketServer.attach` and
   `ChannelWebSocketServer.attach` both ran
   `new URL(req.url || '/', 'http://localhost')` inside the `upgrade` listener,
   before authentication, with no try/catch. `new URL()` throws on `//`, `///`
   and `//:80`. One unauthenticated upgrade with that target restarted the
   fleet, and could be repeated.
2. **The HTTP router.** `createRouter` returns an async listener that
   `http.createServer` does not await. A handler that threw became an
   unhandledRejection. Several handlers have no try/catch of their own.
3. **Frame size.** Both servers were built with `new WebSocketServer({ noServer:
true })`, so `ws` accepted 100 MiB per message. The 4 KiB and 8 KiB
   application checks run on the `message` event, which never fires for a
   message still arriving. The pinned `ws` 8.19.0 also carried
   GHSA-96hv-2xvq-fx4p (memory exhaustion, fixed in 8.21.0).
4. **`GET /actions/:tableId/:userId`** passed any string as a table id to
   `ensureCashTableEngine`, whose lookup error is classed retryable and
   rescheduled with no cap until the next restart.

## What changed

- `server/src/transport/upgradeTarget.ts`: `parseUpgradeTarget` returns the
  parsed target or `null`, never throws. The table server's listener, attached
  first, answers an unparseable target `400` and destroys the socket; the
  channel server's listener returns.
- `server/src/router.ts`: the route function is wrapped once. A handler that
  throws is reported and answered `500` (or the response is destroyed if
  headers already went out). The listener always resolves.
- Both servers set `maxPayload` to 64 KiB, above the application checks so an
  oversized whole message is still answered by them. `ws` moves to `^8.21.0`
  (lock: 8.22.0); the lockfile change is the `ws` entry only.
- `server/src/handlers/state.ts`: `/actions` answers `400` for a table id that
  is not uuid-shaped, using the platform's own `isUuidShape`.

## Proof

- `server/src/transport/aMalformedUpgradeTargetIsRefusedNotFatal.law.test.ts`
  sends the three throwing targets at a real HTTP server with both listeners
  attached. Before the fix: 9 of 10 red, with `Invalid URL` reaching the
  process as an uncaught exception. After: 10 of 10 green, each target answered
  `400` once, and an ordinary table socket still completes its handshake.
- `server/src/router.test.ts`: a throwing handler is a `500` and a resolved
  listener; a response already begun is destroyed, not written twice.
- `server/src/handlers/handlers.test.ts`: five junk table ids are refused `400`
  and never reach `ensureCashTableEngine`. The three existing `/actions` cases
  used `t1` and `ghost` as table ids and now use uuids, since that is the
  behaviour deliberately changed.
- `tsc --noEmit` clean; `src/transport`, `src/handlers` and the router tests
  pass against `ws` 8.22.0 (33 files, 512 tests).

The throwing target was not sent to production. Whether Caddy forwards `//`
unchanged was never established; the engine no longer depends on the answer.

## Not in this change

`/health`, `/metrics` and `/stable-hand` still publish human and horse seat
counts without authentication (audit item 18). That is its own change, because
monitoring and the deploy gate read those endpoints.
