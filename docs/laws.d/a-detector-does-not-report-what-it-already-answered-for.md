# tests/a-detector-does-not-report-what-it-already-answered-for.law.test.ts

A drift detector's window starts at the LATER of its own rolling span and the
`resolved_at` of the most recent incident for its source that carries a
`correction_ref`. A correction_ref is a written assertion that the cause was
fixed at that instant, so anything the detector sees after it still counts,
still clears the same floor, and still raises - only history stops being
re-reported as news. A resolution with no correction_ref (`verified:`,
`no-change-needed:`) does not move the window. Written after
`fn_ca_hand_commit_refusals` re-opened an incident thirty minutes after it was
resolved, on 117 refusals from a cause fixed that morning.
