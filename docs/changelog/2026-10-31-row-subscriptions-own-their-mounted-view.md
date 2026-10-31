# Mounted row subscriptions keep their own binding

A second club lobby mounted after the first had joined reused its channel key.
The row hook refused the already-joined binding, so the second view received no
membership events and could replace the first view's recovery factory.

`useMasterBusChannel` now scopes the registry key to the mounted hook with React's
stable instance ID. Each view retains the same authenticated, filtered row
subscription, callbacks, explicit recovery and cleanup. Logical channel names
remain in diagnostics; errors are not suppressed. Shared tournament broadcasts
and private record topics are unchanged. No new polling or repair loop is added.

The actual locked Realtime SDK regression fails on the original hook and passes
with both views receiving real-shaped row frames; removing one leaves the other
subscribed and final cleanup removes both. Existing admission, retry and stale
callback tests also pass.

The seat-move spectator verification still targeted the closed Diamond ladder,
whose selected physical table was absent from the serving engine. It now uses
the same active King club and reserved spectator membership as the adjacent live
continuity check. Existing zero-participation, identity, rendering, replay and
cleanup assertions remain required. The existing workflow law covers this target.

Real-time law: row updates arrive through the existing discrete Postgres Changes
subscription; no snapshot diff or polling is introduced. TypeScript and live
publication evidence are recorded in the task checkpoint.

The existing production mobile lobby suite also retains a targeted live case:
its reserved observer opens an embedded club lobby, returns to the same club
route to mount a second view, observes both join acknowledgments and natural
row events, then returns to the persistent view after the other unmounts.
Only topic ownership and event counts are retained, with both public client
stamps. No member rows, credentials, synthetic traffic or financial writes
are introduced.
