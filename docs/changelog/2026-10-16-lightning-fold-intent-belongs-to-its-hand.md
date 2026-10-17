# Lightning Fold Intent Belongs To Its Hand

A Lightning pool room survives successive hands. Fast Fold and Fold & Watch previously sent no hand identity, so a delayed first request could reach the room's replacement host and fold the next hand. HTTP idempotency protects already executed requests; it does not identify the intended hand of a request that has not arrived yet.

The player captures the actual rendered hand UUID before asynchronous transport work and sends `lightning-hand:<uuid>` through the existing action-context field. The host requires that exact hand binding before fold flags, timestamps or fold effects. Missing and stale bindings are refused. The token remains stable while other players' turns advance, preserving early folding. Ordinary action contexts and horse input paths are unchanged.

Regression coverage exercises the real persistent-room proxy across completed-hand replacement, missing/stale requests with no side effects, valid early folds, both special fold types, transport spacing, and a rate-limit retry retaining the original context and idempotency key. Client and engine adoption are both required before private activation. Older contextless special-fold requests fail safely; no contextless fallback is provided.
