# Club Entry Four-Phase Release Audit

**Date:** 2026-08-31  
**Scope:** Create A Club, Find A Player, Join A Club, and the shared Club Entry action bar

## What Existed

- The approved transparent action-pill artwork and three semantic hit targets were already wired.
- Create Club used an atomic, idempotent database function, but that function exempted horse
  accounts from the platform's four-club ceiling.
- Find Player returned global identity and live-game context while keeping wallet, statistics,
  and hierarchy details behind canonical downline authorization.
- Search results carried watch access, but the client trusted that result after it could become
  stale.
- HTTP table-state authorization checked club membership but did not enforce the table's
  `restrict_observers` setting.
- Join Club invoked the requested watch continuation and then overwrote it with a club-page
  navigation.

## What Changed

- Added a click-time `fn_get_table_watch_access` revalidation before every watch transition.
- Preserved the requested observer route after immediate joins and after membership becomes
  active while the Join dialog is open.
- Centralized seated-only observer enforcement in `TableViewerAccess`, which is shared by HTTP
  state and both WebSocket entry paths, and returned a distinct `OBSERVERS_RESTRICTED` response.
- Added a forward-only migration that makes the four-club creation ceiling identical for every
  player, including horses, without weakening atomicity, locking, or request idempotency.
- Replaced decorative Unicode loading/check glyphs with CSS loading indicators and text.
- Routed non-blocking club-card and event-bus failures through the production error reporter.
- Replaced the half-page dialog treatment with full-viewport Create Club, Find Player, and Join
  Club surfaces. Each page owns a separately scrolling body and a bottom-locked, safe-area-aware
  footer so its primary control remains visible without cropping the page frame.
- Added the same short-viewport containment to shared Club Arena empty and permission panels so a
  page edge cannot cut through the panel's lower corners.
- Removed the conventional lowercase exception for joining words from the shared runtime Title
  Case formatter. Player-facing dynamic copy now follows the literal rule as well: every word,
  including A, And, Of, The, and To, starts with a capital letter while poker acronyms remain
  uppercase.
- Repaired two newly exposed main-branch test-contract defects that blocked the release gate: the
  satellite source pin now uses the structural source-window helper, and the cash-table test now
  recognizes `min_buy_in_bb` and `max_buy_in_bb` as generated, non-writable columns.

## Verification

- Live PostgreSQL definitions were read before and after migration. Both corrected functions have
  no `is_horse` branch, retain authenticated execution, and expose the universal four-club rule.
- New runtime coverage exercises immediate join-to-watch, membership-race recovery, stale search
  access, seated exceptions, and restricted-observer denial.
- Layout regression coverage pins complete action artwork (`object-fit: contain`), scroll-safe
  modal bodies, dynamic-viewport caps, and full shared-state frames on short viewports.
- Client suite: all 10,301 cases passed across the complete run and isolated rerun of two
  machine-contention timeouts.
- Engine suite: all 3,105 cases passed across the complete run and isolated rerun of three
  machine-contention performance timeouts.
- TypeScript, ESLint (zero errors), engine build, production client build, diff checks, and Club
  Entry media/chunk budgets passed.
- The approved action asset remains the supplied artwork: 2,065 x 399 WebP, transparent, with
  three accessible overlay controls; it is not a recreated illustration.

## Real-Time Law

The audit adds no snapshot-diff or polling path. Observer state continues through the existing
named table WebSocket event stream; the new RPC is a one-time authorization recheck at the user's
watch click.
