# Lease Phase 4: construct request headers once

One bounded thirty-second profile of serving 814862e3 found garbage collection
at 22.35% self time and Undici header construction at 9.61%. The inspector
closed and the same process continued. These observations identify allocation
pressure, not a claim that every GC sample comes from one caller.

The shared database transport copied each ordinary URL request into three
Headers collections before sending one. Reuse its single newly owned collection
when stamping authority. Request-object overrides still merge before the actor
stamp; viewer and original-player clients strip server markers from that same
owned collection. Caller/SDK headers are never mutated or cached across actors.
Deadlines, body consumption, cancellation, fencing and pre-execution-only retry
rules are unchanged. The public copying dataActorHeaders helper stays copying.

A constructor-budget regression failed before (three rather than one) and
passes after. Real SDK/loopback transport proves caller-forged actor/generation
headers are removed while a stalled body still reaches its independent deadline.
Focused request, concurrent actor, private-client and manager fence tests pass.
The source-wiring guard now pins the owned stamp at the same per-attempt boundary.

The existing expiring owner-window carrier records the owner's October26-only
release-when-ready instruction. It changes no maintenance safeguard or publisher.
Protected merge, exact-image installation and post-release natural/profile proof
remain separate delivery gates in the existing task checkpoint.
