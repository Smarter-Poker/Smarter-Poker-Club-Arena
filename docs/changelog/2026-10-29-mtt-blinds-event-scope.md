# Blind clocks belong to the viewed tournament

BlindsTab retained broadcast level and break state when navigation replaced its tournament with another event whose persisted clock columns were identical. The next event could therefore display the previous event's level or appear paused. Two rendered regressions fail before the repair.

Key the clock state owner by tournament ID so navigation retires the previous event's state and handlers. Existing discrete level/break events, authoritative row values, presentation timers and layout remain unchanged. This fixes a reproduced display failure; it does not establish the cause of the original engine stalls.

Verification: both rendered regressions fail before the fix; all 81 connected lobby clock and discrete event relay tests pass afterward. Root TypeScript compilation passes. Hosted qualification, publication and affected live proof remain pending.
