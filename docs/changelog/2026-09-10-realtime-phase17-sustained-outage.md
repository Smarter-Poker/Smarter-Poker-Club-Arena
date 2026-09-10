# Phase 17: Keep The Injected Outage Active Through Retry

Production run 34492394057 tested exact Phase 17 release
7732b971982bb888e6c0b455e73568bae1d7bbf1. It executed 292 cases: 287 passed,
five failed, two additional cases were skipped and none were flaky. Four
failures stopped at the engine release prerequisite (0a768961 versus the
expected Phase 17 release). The additional failure was the Daily Missions
injected-outage assertion at line 1847, which found no error alert.

The retained failure screenshot shows the recovered live challenge board,
including a spendable balance, rather than the unavailable state. Artifact
10159728896 is 9,623,375 bytes, SHA-256
55c9ff57abee866fdab3d42320c7f691bb797cbf542c5926baccfd13b8289e25.
Cleanup verified account deletion at 15:28:29 UTC.

The fixture aborted only the first three dashboard network attempts and then
restored traffic. The new subscription handoff legitimately asks for a fresh
dashboard after the first read fails if the server has a newer revision.
Source inspection, the recovered production screenshot and mounted reproduction
support the outage ending before the assertion observed the error. The
artifact does not retain a request trace proving the precise response ordering.

Two new mounted cases verify the distinction: a temporary outage heals through
subscription reconciliation; a sustained outage remains visibly unavailable
through automatic reconciliation and then supports manual retry. All nine
handoff cases and four freeze interaction cases pass.

The production fixture now keeps aborting dashboard traffic while checking the
unavailable UI. After the Retry control is positioned, recovery requests are
held until the retry click has occurred, preventing automatic recovery from
removing the control before that click. The fixture then restores traffic.
Error visibility, hidden unconfirmed balance/streak, successful recovery and
the live ledger assertions remain. The retry count requires at least the first
three failed attempts; additional legitimate recovery attempts do not end the
outage. Existing service tests remain responsible for each call's retry budget.

No application or database code changed. Formatting and Playwright collection
pass. This fixture correction requires normal merge, publication and a new
production verdict before the phase's complete UI acceptance can be claimed.
