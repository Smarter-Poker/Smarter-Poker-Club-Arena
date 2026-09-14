# server/src/services/theEngineOpensABoundedNumberOfConnections.law.test.ts

The incident recorded an uncapped default fetch pool, connection churn and
rising RSS. TLS allocation/fragmentation is a hypothesis for that growth,
not an established cause. This law tests main-isolate pool behavior rather
than claiming a native-memory ceiling or production allocator diagnosis.

`services/httpDispatcher.ts` installs one Agent with a per-origin cap
(`ENGINE_HTTP_MAX_CONNECTIONS`, default 128) and idle reuse
(`ENGINE_HTTP_KEEPALIVE_MS`, default 30 000) from the existing runtime constructor.
The law pins the first import in `index.ts`, refusal diagnostics and the
`/health` install report. Its real loopback origin verifies connection reuse
and a socket cap for overlapping requests. The truncated constructor string
is assertion display text only; `window-ok` documents that existing exception.
