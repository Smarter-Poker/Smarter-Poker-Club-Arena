# The Daily Missions Certification Interrupts Realtime With A Code Browsers Accept

From `b293beb4e` (PR #5039) every post-deploy run failed the production Daily
Missions certification at the same place: after the step drops the routed
realtime socket, it waits for supabase-js to open a new one, and the routed
socket count never moved.

The step closed the server side of each routed socket with close code 1012
("service restart"). Playwright performs that close with the page's own
WebSocket, and a browser script may only close with 1000 or 3000-4999. The
reserved code was refused without an error reaching the step: neither the page
nor the real server saw a close, so there was nothing to reconnect from.
Measured on the Mac with Playwright 1.58 and a local WebSocket server:
`server.close({ code: 1012 })` left both sides open, while
`server.close({ code: 4000 })` closed the real connection, delivered close 4000
to the page and produced a new routed socket.

The step now closes with 4000, an application code. realtime-js 2.90.1
schedules its reconnect after any close it did not request, so the rejoin's
SUBSCRIBED status performs the bounded cursor read the step certifies. A pin in
`tests/unit/dailyMissionsProductionCertification.test.ts` refuses any close code
in the spec outside 1000 and 3000-4999.

The accessibility and database settlement suites passed on every one of those
runs; only this interruption step was affected.
