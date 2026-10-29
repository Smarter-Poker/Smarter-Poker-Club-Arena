# A delayed break request cannot restart a released tournament break

The MTT audit reproduced a race in `TournamentManagerBase.pauseForBreak`.
The synchronized-break sweep and the newly admitted tournament path can both
request a pause. Each checked `onBreak` before awaiting eligibility. A delayed
eligibility result could then reset an accepted countdown to `last_hand`, clear
its persisted deadline, and park the dealers a second time. If the first break
had already released, the delayed request could park the tournament after its
resume timer had been consumed.

The manager now checks the accepted break-start generation after eligibility
returns, together with current pause and stage ownership. The generation is
retained through release so a stale request cannot reopen that break. A later
fresh break remains permitted. Existing lifecycle fencing, add-on pause
ownership, blind-clock preservation and financial paths are unchanged.

Regression: the real manager's break lifecycle harness drives independently
resolved eligibility promises. Both active-countdown and already-released cases
failed before the repair with an extra database write. The focused four-file
suite passed 48 tests after the source repair; final candidate verification is
recorded in the task checkpoint. The existing required server suite includes
this regression file through `src/**/*.test.ts`.

This is an independently reproduced race, not a claim that it caused the
October 29 `physical_identity_unreadable` quarantines. Those incidents retain
their existing recovery owner. Source/test completion is not engine activation
or live verification.
