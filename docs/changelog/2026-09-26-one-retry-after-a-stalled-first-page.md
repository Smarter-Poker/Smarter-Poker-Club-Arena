# One Retry After A Stalled First Page (2026-09-26)

After #5310 the rakeback settler's pages took 29-41 s instead of 350-430 s. At
09:12-09:14Z a productive cycle was followed by a first-page `Cash source batch
failed` client timeout. That chunk had committed server-side, so a retry would
replay it in milliseconds, but a cycle that halts before acknowledging a page waited
the full 30-minute interval.

A cycle that acknowledges a page now earns one 60 s retry of a later first-page
halt. The retry spends it; only another productive cycle restores it. A second
consecutive stall waits the interval, so a persistent failure costs at most one
extra attempt per productive cycle. Pinned by four multi-cycle cases in
`server/src/services/rakebackWatermark.test.ts` (three fail before, all pass after).
