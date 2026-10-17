# Keep MTT board fitting out of preference restoration's critical path

Production run 39009022845 passed all five Cashier cases but failed Chromium's
cold-return cleanup: the MTT selection reached React, its click exceeded 30s,
and the preference POST had not started when failure geometry was collected.
The original MTT open also spent over 40s between the preference response and
readiness. The phased network budget alone did not resolve this failure.

An isolated full 500-entry LobbyTable render identified synchronous fitted-text
layout work across 5,500 labels, including hundreds of off-screen cards. A
viewport-only diagnostic reduced click completion from 2,005ms to 355ms while
retaining all 500 cards, 500 desktop rows, and identical first-card fit ratios
and positions. This local profile did not reproduce the provider's 30s stall;
the initial comparison used fallback fonts and is not production acceptance.
A final comparison with Roboto Condensed and Inter loaded reduced click time
from 2,137ms to 357ms and click-to-passive-effect time from 493ms to 227ms.
All eleven first-card fit ratios matched exactly. Scrolling the last card into
view enabled fitting, and resizing to 320px refitted it correctly.

MTT cards now enable their existing text fitting only when near the viewport.
Nearby cards fit synchronously before paint; distant cards retain their DOM,
art, facts, actions and scroll space, and fit when their intersection observer
announces approach. The observer disconnects after admission or unmount. Other
fitting callers retain their enabled default, resize behavior and font handling;
a queued font callback cannot fit an unmounted label. No CSS, artwork, save
semantics, timeouts, financial behavior or engine contract changes.

Focused regressions cover deferral, approach, visibility, fallback, action
preservation and cleanup. The production lobby spec retains the first failed
trace because its zero-retry configuration never invokes on-first-retry.
Required checks, publication and the actual production results are recorded in
the existing task checkpoint; local profiling alone does not certify release.
