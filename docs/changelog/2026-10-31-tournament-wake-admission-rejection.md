# Tournament wake admission keeps its durable continuation

A committed tournament-manager wake could be left pending after its admission
rejected. The page drain propagated the rejection past its failure-backoff
branch, and the live Realtime callback only reported it. With no further frame
or reconnect, neither path retained a continuation for that durable request.

The page owner now isolates a failed row, admits independent later rows, and
returns a failed drain result even after advancing across pages. Its existing
capped causal backoff retries the same unconsumed receipts. A rejected live
notification hands its receipt to that same drain only while its original
channel and server lifecycle still own it. Acknowledgement remains inside the
manager's successful full sweep.

Focused regressions reproduce both original rejection paths and cover a later
page, the same receipt's successful retry, scoped and global drains, shutdown,
and retired channel/lifecycle callbacks. This source qualification does not
establish production installation or tournament recovery; the owning release
still requires exact runtime and affected-behavior proof.
