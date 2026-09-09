# Warm entry must prove current state

## Root cause

After a mobile network change, warmSocket returned immediately for an existing
OPEN facade. The lobby resume handlers did run, but they could preserve a
half-open transport. Opening that table adopted the subscription, replayed
cached state and armed no acknowledgement deadline. That cached snapshot could
make an unusable socket look connected until the ordinary long watchdog ran.
PRs #3884 and #3888 cover mounted table and channel resume; neither alone
covered this warm placeholder and its transfer to the real table.

## Correction

A warm SUBSCRIBED and renewed lobby intent now require a fresh table snapshot
within five seconds. The live table still receives bounded cached state on
entry, then proves fresh state. A probe already started in the lobby retains
its original deadline through adoption. Cached replay, PING and old snapshots
do not satisfy it. Equal-sequence fresh snapshots do, and an announced table
rebuild allows its new lower sequence. Announced maintenance suppresses probes.

A silent physical socket is replaced; other inbound traffic preserves the
physical socket and only the affected table subscription is replaced. The
lobby immediately retries a failed state probe while the entry still exists
and the page is visible. Releases, supersession, refusal and real-table
ownership do not cause speculative retries. Hidden pages and retired facades
do not retain destructive delayed callbacks. No buy-in or gameplay is replayed.

## Validation

The cached-state adoption regression failed against the previous implementation:
the dead socket remained OPEN after five seconds. The eight initial focused
cases were 7 failing / 1 passing before implementation (six failures also
identified the missing warm-probe method). The expanded recovery, mux, warm-up
and observer suites cover 138 cases. After correcting an old fake close event
to carry the actual event object, the 25-case warm-up suite passes; the other
113 cases passed in the combined run. Root TypeScript compilation passes.

The physical iPad home-screen flow remains unverified: the supported browser
connection cannot refresh its CDP tabs. Tests are not a physical device claim.

## Delivery and performance checkpoint

PR #3884 is served as part of 276f66a220f0cd2147e90b66b92a6e50f4e3ee4e,
publisher 34288553534, built 23:01:55 UTC. PR #3888 merged as
5c07d06c09291d931d6b4f0eec2559000d1188de; both public and Hetzner origin
served that exact commit, built 23:09:53 UTC, publisher 34289206356.

Engine health proves #3881 adoption as 276faa64 at the scheduled 22:55 restart.
The early two-second hand-gap readings did NOT hold as workload grew. At
23:15:40 UTC there were 663 active tables and 397 tournaments: median 8,497ms,
p90 17,057ms, maximum 34,279ms over 2,000 samples. There were no blocked
settlements in that sample. This leaves the overall hand-delay incident OPEN.
The lease convoy correction is installed, but does not establish sufficient
throughput under the later load. Do not claim the next hand always takes 2s.

The Madness table progressed from hand 8388234 at 22:59:58 to hand 8395981
at 23:15:40. That is server progression, not proof of the owner's display.
