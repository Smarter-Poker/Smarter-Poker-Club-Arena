# A Sit And Go Is Not An Overdue Start (2026-10-15)

The first launch health reading after `20261015101222` installed named 12 "overdue starts": 8 Spins and 4 heads-up Sit and Gos with a 13:30 UTC start_time. Those formats start when their last seat is bought, not at start_time, so they were doing exactly what they should.

Migration `20261015141135` limits the overdue-start reading to scheduled events (`MTT`, `SATELLITE`). Nothing else in `fn_ca_launch_health` changes. Pinned by `tests/a-sit-and-go-is-not-an-overdue-start.law.test.ts`.
