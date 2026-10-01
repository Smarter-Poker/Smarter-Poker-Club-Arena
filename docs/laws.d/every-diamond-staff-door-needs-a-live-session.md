# tests/every-diamond-staff-door-needs-a-live-session.law.test.ts

Every door the Diamond Staff Desk writes through asks
`public.fn_caller_session_is_live()` in its latest definition, so a staff
session revoked on another device (whose access token still verifies until it
expires) is refused by name rather than obeyed. The door list is read from the
desk's own service files (`DiamondStaffDeskService`, `DiamondAdjustmentService`,
`DiamondIncidentReviewService`), so a door added later arrives with the check or
fails here. Migration `20260930131500` guarded ten writers; the desk's three
reads (incident board, incident trail, staff books) were guarded by line 1's
`20260930120000` by asserted substitution on top of it, and are pinned by
`tests/a-forged-request-is-refused.law.test.ts`, so they are exempt here by
name. Migration `20260930131500` is pinned too: ten doors, each
pinned to its live md5 before any redefinition, each redefined from that exact
text plus one check placed directly after its staff check and refusing in the
door's own style (the table doors raise `diamond_staff_session_required` with
SQLSTATE 28000, the adjustment doors answer that name as `refused_reason`, the
incident doors answer `authentication_required`), no grant, table, trigger or
switch touched, one `@live-proof` per door, and a final block proving anon has
no EXECUTE, both Diamond switches closed, the supply identity whole and no
watched guard off its baseline.
