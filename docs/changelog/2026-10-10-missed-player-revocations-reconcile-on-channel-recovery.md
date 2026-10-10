# Player session recovery and private re-delivery

A missed durable logout event previously left an existing WebSocket grant usable until its original five-minute reauthentication sweep. Single/multiplexed private RESYNC, a new table subscription, cached club membership joins and hand replay could use that retained grant in the meantime.

The original revocation subscription now emits one recovery callback per SUBSCRIBED generation. The engine entry wires it to the two existing transports. Each reconciles a finite snapshot against the installed `fn_ca_player_session_live` authority, closing only definitively revoked sessions. Generation disposal, shutdown, socket replacement and token replacement invalidate delayed results. Unknown database authority retains the socket and refuses private re-delivery; the configured database deadline bounds reads. Existing periodic reauthentication and club membership retry behavior are preserved.

Explicit private RESYNC, subscription, club admission and replay now read durable authority, coalescing concurrent reads on the same retained connection. Synthetic unit fixtures explicitly inject a live session instead of changing production refusal behavior.

Validation: server TypeScript compiler passed; all 304 transport/service tests passed, including six real single/multiplexed RESYNC verdict cases and deferred generation/socket/shutdown regressions. These are isolated source/runtime tests, not a production reconnect certificate. Source inspection establishes the pre-fix retained grant gap; the new runtime cases prove the repaired admission and recovery behavior. No production control, policy toggle, migration replay or engine restart was performed.

Scoped startup review: `server/src/index.ts` changes only the original revocation subscription's optional recovery callback. Transport creation, attaching, original revocation delivery, shutdown unsubscribe and maintenance lifecycle remain in their existing owners. Normal engine build/source-binding and protected delivery are owned by the parent task.
