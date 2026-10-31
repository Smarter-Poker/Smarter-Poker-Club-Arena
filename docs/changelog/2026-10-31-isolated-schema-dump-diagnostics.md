# Bounded private schema export diagnostics

Run41239776652 passed the strict Node provider-CA connection and read-only
catalogue capture, then refused in pg_dump at20:40:11UTC. The child error output
was discarded, so its exact failure cause remains unknown. No full-schema or
connected tournament/RIT case passed.

Retain only fixed error categories, bounded byte/elapsed counts, numeric exit
status and a closed signal enum from the original child. Reuse the maintained
native export driver's fixed stderr-category approach. Raw stderr and schema
bytes remain private transient buffers and are cleared; messages, endpoints,
credentials, SQL and nested errors are never published. Original deadlines,
size limits, snapshot ownership, strict TLS and cleanup remain unchanged.

Focused regressions cover redaction, unknown values, nonzero exit, deadline,
stderr overflow and spawn failure. The corrected run must identify the actual
export result; this diagnostic change supplies no full-schema or fourteen-case
acceptance credit and adds no fallback or automatic retry.
