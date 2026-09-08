# Database Response Deadline

## Confirmed Failure

The engine service-role fetch wrapper cleared its 15-second deadline when fetch resolved response headers. Body consumption happened later, outside that deadline. A server that sent headers and a partial body could hold a table database await indefinitely. A 503 body could also strand the retry classifier before it knew whether replay was safe.

Caller abort signals that were already cancelled were ignored, Request-object signals were overwritten, and forwarded abort listeners remained attached after completion.

## Fix And Evidence

Keep the per-attempt deadline until the database response has fully arrived. Drain a cloned stream and discard each chunk, preserving the original response metadata and readable body for the SDK. These are fully consumed database responses; this intentionally buffers the original body before returning it. It is not a general streaming-download wrapper.

Check caller cancellation before each attempt, propagate Request signals, and remove listeners in every exit path. Retain the existing restricted retries for PGRST001/PGRST002/PGRST003 pre-execution 503 responses. Network failures, timeout and ambiguous mutation outcomes are never replayed by this transport.

Five regression cases failed on the prior implementation and pass after the change. Nine tests now include success bodies, bodyless responses, safe retry and no ambiguous-write retry. A real Supabase SDK query against a local HTTP server that sends headers and then stalls also returns an error within the configured deadline. Server TypeScript verification passed.

## Remaining Limits

This closes an unbounded-wait failure. It does not explain or resolve the previously measured roughly twelve-second normal hand gap. Settlement ordering and financial recovery remain unchanged. Live deployment, per-step hand timing and the broader reconnect acceptance matrix remain open.

References reviewed: Supabase JavaScript initialization/custom fetch documentation and MDN Using Fetch (fetch resolves on headers; body reads remain asynchronous). Supabase changelog reviewed September 8; no relevant SDK configuration breaking change was identified for this transport correction.
