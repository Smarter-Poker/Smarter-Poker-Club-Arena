# Tournament settlement preserves uncertain transaction outcomes

The ordinary terminal request treated every five-character SQLSTATE as proof that a write rolled back. A connection failure, including 08007 (transaction resolution unknown), followed by a resolver lock timeout therefore released the finish guard without establishing the original outcome.

The terminal request now uses the existing shared statement-refusal classifier. Connection, resource, intervention, system and internal error classes remain unknown until the serialized resolver or a verified committed receipt answers. Explicit rollback refusals and pre-execution PostgREST handling retain their existing behavior. No money, recorded ranks or original hands are rewritten.

Six request-level regressions failed before the correction and pass afterward. Each retains the original request and calls its serialized resolver; ordinary lock-timeout refusal remains a positive control. This is a source defect reproduced in isolation, not an established cause of the three current live stalls.

Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
