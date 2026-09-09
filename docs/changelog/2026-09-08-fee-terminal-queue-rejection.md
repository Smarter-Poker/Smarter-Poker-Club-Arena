# A Rejected Deferred Fee Is Checked Before Its Attempt Ends

The original fee queue insertion can move off the dealing path after temporary database failures. If a later attempt returned a permanent error, that callback returned done immediately. It neither confirmed banking nor reached the existing financial alarm, so the in-memory attempt could disappear silently.

The permanent-error branch now calls alarmUnqueueableFee before ending. That existing function checks for a queued or banked receipt, suppresses an alarm for accounted funds, and reports missing or unverifiable banking. Transient errors still retry; acknowledged inserts still finish without an alarm. This adds no payment, sweep, queue, cron, or repair mechanism.

Two actual-module regressions failed on the old callback. All 18 tests across the new terminal-rejection suite and existing jackpot queue suites passed after correction, with server TypeScript passing. Cases include a missing fee, an already banked fee, continuing transient failure and subsequent successful insertion.

Wiring: queueUnbankedFee supplies this attempt to the existing enqueuePendingWrite driver. The original fee payload reaches the existing alarm. No live wallet or financial record was changed by these tests. This fixes the silent terminal branch, not the wider accounting audit or engine deployment backlog.

Follow-up verification found the shared driver logged every terminal result as landed, including a handled database refusal. PendingWriteOutcome now distinguishes refused completion; both fee and hand-stack callers pass that result, and the driver logs refusal without claiming a committed write. An actual-driver baseline reproduced the false landed log. All 6,904 server tests across 485 files, 35 reload/fee-alarm checks, and server TypeScript passed with this follow-up.
