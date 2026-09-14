# server/src/services/theEngineOpensABoundedNumberOfConnections.law.test.ts

Node's global `fetch` carried every Supabase call through an undici Agent with
no per-origin connection cap and a four-second keep-alive, so the engine opened
a fresh TLS session for almost every request: 240 HTTPS connections open and
1,674 in TIME-WAIT in an ordinary minute, 3,800 during one tournament
re-admission storm (measured 2026-09-14). Each session is native memory in
glibc's main arena on the main thread, and that arena keeps its high-water
mark, which is how the process passed 2 GB with a flat V8 heap, the on-host
image build was refused 11 of 14 times, and the kernel OOM-killed the engine on
2026-09-12. `services/httpDispatcher.ts` installs one bounded Agent
(`ENGINE_HTTP_MAX_CONNECTIONS`, default 128 per origin;
`ENGINE_HTTP_KEEPALIVE_MS`, default 30 000) from Node's own bundled
constructor. This law pins that it is the first import of `index.ts`, that a
refused override keeps the ceiling and is named, that a runtime whose default
is not undici's Agent is reported rather than guessed at, that `/health`
publishes the outcome, and - against a real loopback origin - that six
overlapping requests open at most `cap` sockets and sequential ones share one.
