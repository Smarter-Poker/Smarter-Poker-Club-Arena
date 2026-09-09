# Shared Realtime callbacks retain registration authority

## Production incident

At 2026-09-09 00:18:35.800 UTC, engine build 276faa64 logged an uncaught
`Tournament data authority cannot be rebound inside another manager context`
from the bounty obligation Realtime callback in GameServer. A manager-wake
callback also reported the same error. The process entered fatal drain, hit
the 40-second shutdown deadline, and restarted at 00:19:16 on the same build.
This was not an OOM kill. Bounded Docker logs covering the incident contain
the stack through RealtimeChannel's synchronous callback dispatcher.

A shared Supabase Realtime socket can be created or reconnected inside any
manager's async chain. The SDK invokes other channels' callbacks in that
socket's context. A service callback then dispatching manager B while the
socket belongs to manager A correctly trips the immutable authority fence.
The unhandled synchronous exception can stop the whole engine.

## Change and boundaries

Both bounded service clients bind each Realtime event and subscription status
callback with AsyncResource.bind when it is registered. Each handler retains
its own context even when several owners register on one channel. Service
handlers can dispatch the intended manager; manager handlers retain their
own exact tournament ID and lease generation through asynchronous work and
Data API requests. Channel identity, fluent return values, filters, callback
arguments and optional subscription timeouts are retained.

The SDK prototype, manager authority guard, HTTP timeout/retry policy and
SQL fences are unchanged. There is no generic service-authority escape and
no catch-all that suppresses callback errors. Private cards and monetary
writes are not part of this change.

## Verification and release limit

Seven regression tests failed against the previous transport, using actual
installed SDK channels and offline event dispatch. The fixed implementation
passes all eleven Realtime cases, including CLOSED/CHANNEL_ERROR status
callbacks and preservation of the cross-manager refusal. The focused actor,
HTTP deadline, manager wake, elimination scheduler and process shutdown
suite passes 58 tests across eight files. Server TypeScript is checked before
push. No live subscription was opened by these tests.

This is an engine change. A merged PR or a new client build stamp does not
prove it is active. Verify the normal Hetzner maintenance cutover's build
ancestry, then observe sustained table progression and the absence of this
fatal stack. High-load hand gaps and physical iPad PWA reconnect remain
separate acceptance items; this incident fix is not proof they are resolved.
