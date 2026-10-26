# Player Management refreshes itself at most once every 180 seconds

Dan, 2026-10-25: "STOP AUTO REFRESHING THE PLAYER MANAGEMENT PAGE. ONCE EVERY
180 SECONDS IS FINE, NOTHING SOONER."

The roster re-read the whole loaded list whenever a live signal arrived (horse
play, membership changes, window focus, tab return), held only to one read per
30 seconds. In an active club that meant the list reloaded roughly every 30
seconds. The floor (`liveRosterRefreshPolicy.minIntervalMs`) is now 180
seconds, and every automatic re-read goes through it. Pressing refresh,
searching, filtering or sorting still reads immediately.

Pinned by `tests/unit/playerManagementRefreshesAtMostEvery180Seconds.test.ts`.
