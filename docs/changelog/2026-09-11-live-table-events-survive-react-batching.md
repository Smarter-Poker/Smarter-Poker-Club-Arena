# Live Table Events Survive React Batching

The post-cutover mobile WebKit certificate reached real gameplay and exposed two client defects. HAND_STARTED could be followed by another event before React committed the hook state, so the deal animation never received its trigger. Browser offline events also left an OPEN game transport looking healthy until its silence watchdog expired.

The React binding now commits each discrete public and private event before a later event can replace it. Retired hook owners cannot publish events. Snapshot updates retain their existing batching. Both table transports and the channel client retire offline connections, invalidate pending token work, preserve subscription intent, and resume through their existing single-owner online path. The shared socket closes at the physical owner, including lobby prewarm, rather than retaining a half-open link behind a released facade.

Before the repair, all five new regression cases failed and 74 existing cases passed. The regressions cover public/private event delivery, mux and legacy table recovery, channel recovery, and authentication work overtaken by network loss. Acceptance assertions and production cutover guards are unchanged. Live publication and the final browser result must be verified separately from these local tests.

The expanded covering validation passes 228 tests in seven suites, including retired hook ownership, event ordering, connection refusals, restart handling, and animation laws. Type checking and lint passed. The local bundle built successfully, but its provenance check detected a concurrently advanced main; the branch must incorporate that descendant before publishing.
