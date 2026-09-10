# Cashier Menu Escapes Page Transforms

The production Cashier canary reached its mobile boundary check on September 10
at 07:58:12 UTC and measured a left edge of -112px at a 320px viewport.
Readiness, right-click opening and mobile-hold opening had passed.
HomePage's transformed, clipped scroller and perspective container enclosed the
menu, so its fixed-position mobile rules were tied to those ancestors.

The existing wallet menu and backdrop now render through a document-body
portal. Desktop placement follows the trigger's viewport rectangle on opening,
nested scrolling and resize. The existing mobile safe-area CSS controls the
sheet. Wallet ownership, balance reads, focus, keyboard, dismissal and gesture
handlers retain their existing owner; no cron or shared layout rewrite is added.

One mounted regression failed on the original containment while the 20 existing
cases passed. After repair, all 21 pass, including desktop anchor updates and
listener disposal. TypeScript passes. This mounted test establishes containment
and lifecycle, not browser layout; the unchanged 320px production canary remains
the rendered acceptance gate. Release and loaded-fleet evidence are recorded in
`docs/audits/2026-09-10-realtime-acceptance-follow-through.md`.
