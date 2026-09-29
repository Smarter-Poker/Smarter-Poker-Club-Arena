# tests/board-producers-measure-what-they-name.law.test.ts

Four observability producers reported a number for the wrong thing (2026-09-26):
`fn_tournament_chip_conservation_check` called a starting stack that was never
issued "chip drift -30,000" (incident 0f8f8cc6); `fn_ca_absent_tournament_players`
could not see a registrant who was never given a chair; `fn_ca_tables_that_cannot_deal`
clocked a bust-thinned event from its oldest seating (12 minutes read as 8 days);
and `MttPlayStopped` fired for three days on a stalled count with no denominator
while the whole tournament fleet stood still. This law pins the four corrected
measurements in migration 20260926023322, keeps the shared chip-supply definition
untouched, and pins `MttFleetNotDealing` - the share of eligible MTTs that dealt a
hand, threshold 0.25 derived from 0.13 (outage ceiling) and 0.53 (healthy), behind
the maintenance break guard.
