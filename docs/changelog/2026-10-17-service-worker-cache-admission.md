# Keep optional cache storage from blocking real asset responses

Production traces isolated requests handled by the service worker while
bypassed requests still succeeded. They do not identify which native cache
operation or worker dispatch stalled. The worker nevertheless had a concrete
unbounded dependency: opening and matching Cache API entries preceded every
asset network fallback.

Cache lookup now shares the existing 300ms freshness allowance across open
and match. Rejected or stalled lookups fall through to genuine network
responses. Healthy immutable cache hits, the six-hour media revalidation
floor, stale offline media and the shell's freshness/offline behavior remain.
Shell and asset cache writes, comparisons and trimming run as caught optional
background work, so they cannot hold or replace a real network response.

Actual worker-handler regressions cover stalled and rejected cache reads,
write failures, bounded lookup, healthy cache hits, genuine offline errors
and shell/media fallback. This does not change table artwork loading, auth,
observer deadlines, cache retention or service-worker activation rules.
