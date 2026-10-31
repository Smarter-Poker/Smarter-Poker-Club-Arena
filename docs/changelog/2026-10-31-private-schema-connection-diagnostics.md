# Private schema connection diagnostics

The first protected isolated qualification run41236847208 failed before its
read-only transaction began. Its sanitized connection-stage error retained no
driver code, so the actual network, certificate or authentication cause remains
unknown. No connected tournament or RIT case ran.

The capture now classifies only a closed list of transport, TLS and PostgreSQL
connection codes, including bounded cause/AggregateError traversal. It records
only the fixed direct/session-pooler route label. Driver messages, endpoints,
credentials, stacks and nested errors remain private. Unknown and mixed causes
remain explicit; no fallback, retry, TLS downgrade or credential change is added.

Focused regression coverage verifies redaction, nested errors, cycles, traversal
bounds and connection cleanup. This is diagnostic delivery, not full-schema or
fourteen-case acceptance.
