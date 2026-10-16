# The Freeroll And Satellite Alerts Close On Their Evidence (2026-10-16)

Migration 20261016214507 closes twelve open critical alerts whose causes are
fixed and whose outcomes are read from rows; it writes no money and changes no
function. Drift-incident mirrors close through
`zz_ca_alert_resolution_reaches_the_incident`.

- 11 alerts for 85313174 "Coffee Break Freeroll (PLO4)" (10
  `Tournament.table_admission_failing`, 1
  `GameServer.tournament_dark_after_rebuild`). Cause fixed by 20261016183932
  (#7137). The event COMPLETED at 21:38:22, every named table is closed, and
  `tournament_payouts` equals the 390.40 prize pool.
- 1 alert for 9dc3fae9 "Sunday Deep Stack Satellite 25"
  (`Tournament.satellite_qualifiers_refused_repeatedly`). The satellite
  settled whole at 18:29:39: pool 600.00, two seats and one 200.00 cash award
  for the qualifier who already held a seat, remainder 0.

Each class must match its exact count or nothing is resolved; probed
read-only first (11 and 1).
