# Table Management Lifecycle Authority

## Phase

Phase 1 of 6: Seal lifecycle authority and remove legacy mutation bypasses.

## What Changed

- Replaced direct table soft-deletes in both legacy club pages with the same
  `fn_close_managed_game` command used by Table Management.
- Changed the legacy lobby action and confirmation copy from deletion to table
  closure, including the occupied-seat explanation returned by the server.
- Reduced `TableService.deleteTable` to a compatibility wrapper around the
  authoritative close command. It no longer performs authorization, lifecycle,
  or club-count writes in the browser.
- Removed browser tournament refund cancellation and short-field auto-cancel.
  A short field now waits without destroying registrations.
- Restricted `atomic_cancel_tournament` to `service_role` recovery callers. It
  is no longer an authenticated browser/operator API.
- Added database triggers that reject occupied table closure, direct table
  deletion, direct tournament cancellation, and protected tournament edits
  after the first registration.
- Counted every active seat and every tournament entry, including nullable
  user/system/horse rows, so special participants cannot bypass the guard.
- Rewired table-close subscribers to the named `TABLE_CLOSED` event and removed
  the now-dead `TABLE_DELETED` subscriptions.

## Verification

- Added a source-law suite preventing any browser source from restoring direct
  table deletion or tournament cancellation.
- Updated architecture, tournament non-cancellation, discarded-read, and dead
  event-subscription ratchets.
- Focused lifecycle and regression tests pass.
- TypeScript typecheck and title-case checks pass.
- Production Vite compilation and media optimization pass. Final provenance,
  full-suite, and clean-build results are recorded in the phase handoff after
  synchronizing the branch with the current `origin/main`.

## Realtime Law

Lifecycle commands publish explicit `TABLE_CLOSED`, `TABLE_UPDATED`,
`TOURNAMENT_CANCELLED`, and `TOURNAMENT_UPDATED` MasterBus events. No polling or
snapshot-diff gameplay path was added.
