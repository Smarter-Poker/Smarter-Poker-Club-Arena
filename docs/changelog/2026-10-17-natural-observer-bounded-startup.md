# Bound natural observer startup to two active pages

The latest production proof opened all six observers, but sequential startup
left the sixth only 7.811 seconds before the original shared setup deadline.
The natural proof now admits up to two observers at a time, keeping the same
single 120-second allocation across discovery and all six pages.

All six selected observers remain required and retained for the unchanged
20-minute observation. A failure stops new starts and waits for active starts
to settle before cleanup. There are no retries, replacement observers or SDK,
product, workflow, timing-assertion or provenance changes.

Focused orchestration regressions verify the two-page bound, individual
completion of all six, cumulative deadline and failure cleanup ordering.
Production two-/three-run certification remains a separate required result.
