# server/src/transport/aMalformedUpgradeTargetIsRefusedNotFatal.law.test.ts

Launch audit, 2026-10-05. Both WebSocket servers parsed the upgrade's request
target with `new URL(req.url, ...)` inside the `upgrade` listener, before
authentication and with no try/catch. `new URL()` throws on `//`, `///` and
`//:80`; an exception there is an uncaughtException, which `index.ts` treats as
fatal, so one unauthenticated request restarted the engine and voided every
hand in flight. The law sends those three targets at a real server with both
listeners attached and pins that each is answered `400` once, that nothing
escapes as an uncaught exception, that an ordinary table socket still completes
its handshake afterwards, that neither server parses `req.url` itself, and that
both bound a message while it is still arriving (`maxPayload`, 64 KiB against
the library's 100 MiB default).
