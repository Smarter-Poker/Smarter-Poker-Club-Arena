# Authored registration stays open through level 10

The nine newly authored October 27/28 schedules explicitly choose a levels-only registration window. Their existing final clock trigger preserves level cap 10 and disables the secondary minutes deadline, including after prestart clock edits. This prevents generated satellites reverting to level 9 or fixed minutes closing entry early during breaks. Existing zero-based admission closes at index 10, displayed level 11. Unmarked schedules and running/finalized terms retain their behavior.

Validation: exact installed admission predicate evaluated against 25 in-memory production configurations at displayed levels 1, 9, 10 and 11, including a three-hour elapsed clock, without entry RPCs or chip writes. Isolated PostgreSQL fixture applies the real migration and verifies insert, subsequent clock edit, unmarked, running and finalized boundaries.
