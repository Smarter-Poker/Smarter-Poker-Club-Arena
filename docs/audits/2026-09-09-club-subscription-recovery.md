# Club subscriptions recover without reviving retired intent

A live channel socket could lose its club feed after one temporary membership
read failure. The server silently returned, leaving recovery to the client's
three-minute reassert. The immediately following presence frame was also
lost while that membership query was pending. Conversely, a successful read
could arrive after Leave or socket close and incorrectly restore the feed.
Six offline transport regressions reproduced these failures.

Club membership reads now belong to the exact connection and pending intent.
Repeated JOINs share that work. Unknown verdicts remain ungranted and uncached,
then retry with jittered exponential backoff from one second to a thirty-second
base cap. Leave and close cancel the retry and invalidate in-flight results.
Only the latest pending presence is retained and published after permission
is confirmed. An explicit denial stops retrying and removes any old feed.

Pending work is capped at 64 clubs per socket with an explicit CHANNEL_ERROR
when full. Malformed club IDs are rejected without database work or retry.
Existing heartbeat, inbound rate cap, membership cache TTL and
multi-socket hub behavior remain. This uses the existing wire protocol and
works with the already published client. It does not reconnect healthy table
sockets or execute any game or monetary action.

Regression coverage includes temporary errors/rejections, single in-flight
reads, bounded backoff, cancellation, replacement-generation ordering,
presence authorization, actual membership revocation and pending-work capacity.
All 29 tests across the three subscription/heartbeat/hub suites pass, and
server TypeScript passes.
The production engine must adopt this change through the normal Hetzner
maintenance workflow before it can be reported active.
