# Throwable Audio Deadlines

Bound response headers and body reads to ten seconds per audio container. A stalled WebM now aborts and permits AAC fallback; failure of both containers releases the cache entry so a later throw can retry. The same deadline covers the AAC codec fallback path. Timers are cleared after settlement and diagnostics remain local.

Six audio lifecycle tests pass, including stalled fetch recovery and stalled response-body fallback. Also removed the unused static pepperoni class identified by the measured-grammar and class-resolution CI gates, without altering the artwork or raising the unresolved-class budget.
