# Fleet telemetry counts accepted work across table retirement

A fifteen-minute baseline on one unchanged engine instance reported zero action
samples while horses were acting, and `totalHandsDealt` fell from approximately
2.212 billion to 2.147 billion. Health was summing database hand ordinals and
live-engine sample buffers. Prometheus already had a process-wide delta bank,
but a table retiring before its next scrape could leave its final work unbanked.

Health and the fleet metrics endpoint now use one `EngineTelemetry` snapshot.
The existing bank captures completed-hand, accepted-action and threshold deltas
when recorded and again at disposal. Retirement, replacement, repeated reads and
the ring buffer cap cannot reset or inflate the lifetime counters. Hand totals
mean completed hands observed by this process, not the database's hand sequence.

All eleven direct rule-execution call sites now use the same measured-apply
boundary: human and horse actions, accepted fallbacks, pre-actions, deadline and
disconnect actions, and leave folds. Timing covers synchronous `performAction`
execution; it excludes human waiting, horse computation and visible pacing.
Only a true accepted result records a sample. Rejections, exceptions and cancelled
work add none. The HTTP handler no longer records a second sample. The wrapper
preserves the rule result and exceptions, and suppresses instrumentation failures.
Poker rules, amounts, decisions, timers and settlement behavior are unchanged.

`performance.totalActionsRecorded` and `poker_actions_recorded_total` are lifetime
process counters. Action averages use at most 500 samples per live table engine
and a five-minute monotonic age window. Sample counts and the latest sample's
timestamp/monotonic age are exposed separately. Health uses `null`, and Prometheus
uses `NaN`, when a latency has no samples. This telemetry's separate broadcast
latency remains unavailable until measured; existing act-to-broadcast instruments
are unchanged. Measured broadcast averages use their own sample denominator.

Tests exercise real GameServer/HandController health and metrics, unsampled
retirement/replacement, capped and stale samples, real HTTP replay, human action,
horse pacing/cancellation/fallback, and instrumentation failures. The related
ownership, turn-boundary, leave and disconnect checks remain required. This is
local preparation from D6 `cda0ef58a775c1dcbbea9c1b866e68b710d3ff32`; no publication
or new live measurement is claimed. Installed readers should account for the
new explicit unavailable values when interpreting empty latency evidence.
