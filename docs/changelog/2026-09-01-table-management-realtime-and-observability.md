# 2026-09-01 - Table Management Realtime And Observability

## Shipped

- Added one compact, append-only Table Management event feed with scope-based row security instead of restoring expensive platform-wide table and tournament subscriptions.
- Added recipient-scoped permission invalidations for club roles, union admins, union membership changes, direct club-union changes, and union ownership transfers. Revoked operators now lose the management page and hamburger link without waiting for navigation.
- Wired game, ticker, club identity, and announcement changes across devices through named MasterBus events and authoritative refreshes. No polling was introduced.
- Added connection state and a bounded operator health snapshot to the management header, including 24-hour command totals, rejected-command counts, and stale-processing integrity alerts.
- Added canonical append-only audit records for completed game commands, ticker changes, club identity changes, and announcement changes.
- Added executable hook/service tests and architecture laws covering scoped realtime, wrong-scope rejection, reconnect resync, permission revocation, event publication, audit wiring, and health mapping.

## Operational Notes

- The event stream contains identifiers and invalidation metadata only. Full game state remains behind the existing authorized reads.
- Event publication and database functions are migration-backed but were not applied to production in this phase.
- Event retention scheduling and high-volume load tuning remain planned for the scaling phase.
