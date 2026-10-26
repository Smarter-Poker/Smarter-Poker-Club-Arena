# A bought tournament chair keeps its cash-session plan

The existing pre-start horse session planner removed a booking as soon as the
horse already held a chair in that event. That avoided counting the event
twice, but also discarded the start time used to finish excess cash sessions.
Four cash seats plus a bought tournament chair could therefore answer
`no_commitment` ten minutes before the start.

Keep that booking's timing, and mark its chair as already included in the live
seat count. Three cash seats plus that chair still fit in four; four cash seats
plus that chair finish one cash session through the ordinary `leaveTable` door.
The existing hazard window, fifteen-minute certainty, human-table preference,
stay clocks, maintenance freeze and hand-boundary cash-out remain in charge.
No schedule, repair pass, seat deletion or paid tournament cancellation is added.

A connected planner test reproduces the original zero departures, then checks
the real booking-read/decision/leave path after correction, with matching-table,
no-double-count, outside-window and maintenance cases. Existing planning tests
remain in force. This repairs the pre-start case only: it does not certify all
current over-cap seats or the final post-launch state without natural readback.
