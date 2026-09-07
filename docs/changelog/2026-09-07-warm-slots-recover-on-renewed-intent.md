# Warm Slots Recover On Renewed Intent

The next realtime audit pass found fresh roster caching suppressing connection
recovery. An actual table correctly reclaims speculative mux slots, but returning
to a warmed row within fifteen seconds previously returned early without
restarting its lost stream. A previous full-slot refusal behaved the same way.

Fresh roster reuse now checks the independent connection lifecycle. Renewed
intent retries a missing speculative connection without rereading seats. A
pending-auth guard coalesces concurrent pointer/touch/focus calls. Existing
facades and live-table ownership retain priority; no slot cap changes.

Two new regression cases failed before the fix: evicted slot recovery and a
previously full mux. The concurrent-intent case protects against duplicate
acquisition while authentication is pending.

Continuity: PR #3573 merged as 4b02ae9b5a and was verified in the public
build stamp dated 2026-09-07T23:17:02Z. PR #3581 addresses the independently
reported TOS idempotency defect; do not duplicate that work. The signed-in
verification browser still displayed the TOS screen after acceptance on the
older build. Authenticated entry latency and the broader realtime audit
remain open, including four-table navigation and mobile reconnect behavior.

Verification: 67 focused tests passed, TypeScript and targeted ESLint passed.
A subsequent public engine health sample reported running=true, 313 active
tables, 281 hands in flight and zero stalled tables. This is a sampled server
health result, not proof of browser entry performance.

Release follow-up: the blocking phone squeeze CSS test mounted the actual
application before replacing its body with a fixture, allowing asynchronous
application startup to alter that fixture. It now fetches the built entry
and referenced CSS through the request context and mounts them in a blank
document with an explicit mobile viewport. Missing assets now fail clearly.
All six phone squeeze browser checks pass against the local production assets,
including geometry, layer lifetime, animation durations and reduced motion.
No production CSS or animation thresholds were changed.
