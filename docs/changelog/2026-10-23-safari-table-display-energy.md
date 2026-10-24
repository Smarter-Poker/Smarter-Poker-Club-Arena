# Safari table display energy follow-up

Cash tables kept SessionHUD mounted while closed. It still started a session,
read bus updates and woke once a second for a label that displays only minutes.
The HUD now reads on open, ignores updates while closed, schedules the next
session-minute boundary while visible, and catches up from wall time after
visibility restoration or pageshow. Closing/unmounting releases its timer.
The result drawer also ignores stats events while closed. TablePage retains
ownership of the actual seated session and its history.

The timed bomb-pot display updated TablePage every second throughout its quiet
announcement window and indefinitely after reaching NEXT HAND. Its display
hook now waits directly for the announcement window, updates at whole-second
boundaries, sleeps at zero, and stops its display timer while the document is
hidden or the player selects another mounted table. A changed engine deadline,
table selection or Safari restoration re-evaluates wall time.
Higher priority live/waiting/bomb-only statuses need no countdown. The engine
still controls bomb-pot scheduling; action timers, gameplay and animations
are unchanged.

Verification includes maintained React component/hook tests for closed panels,
minute boundaries, quiet windows, expiry, new deadlines, close/reopen, unmount
and delayed pageshow. The original implementation fails the new energy tests.
In an isolated production-React WebKit phone-viewport comparison, four mounted
tables (two quiet and two expired bomb labels, with closed HUDs) produced 120
interval callbacks in 16 seconds before and zero afterward. Table render
counts fell from 16 each to 1/1/2/2. In both versions all four actual action
timer hooks reached zero and expired exactly once. This fixture isolates the
stats service/bus and does not establish physical iPhone temperature, battery
consumption or a full authenticated Safari session.
