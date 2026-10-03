# A close attempt that prepared a long week pays in the next (2026-10-03)

## What happened

In the chunked weekly close each attempt prepares its book and then pays the next round in the same
transaction. Measured on 2026-10-03 for the week 2026-09-21..28 in rolled-back cron jobs: Deep Stack
Society's preparation took 285 s (one fresh weekly recompute) and its round 2 114 s; Midway's round
2 took 167 s and its round 3 54 s. At the ~2.3x volume of the week closing 2026-10-05 a standalone
club's first attempt would prepare for about 11 minutes and pay round 2 for about 4 more, past job
272's 720 s statement timeout, so it would only finish on the 50-minute fallback budget in one
transaction of about 15 minutes.

## Fix

Migration `20261003121635_a_close_attempt_that_prepared_a_long_week_pays_in_the_next`, only in a
chunked close: when an attempt's preparation succeeded after durable work of its own (a P&L step it
proved and kept, or a weekly recompute it recorded for one of the book's clubs) and more than 60
seconds have passed since the attempt began, the attempt ends as a committed `prepared` step (run row
`running`, nothing paid, no failure, no alert). The next attempt reuses those receipts through the
preparation's existing proven-current reuse and pays the round. A preparation that only reused
receipts, and a paid-scope replay, never stop this way, so the close always moves forward.
