# Realtime Phase 10: Cashier History Recovery

Date: 2026-09-09

## Scope And Findings

The Phase 9 balance repair is already published. This phase follows the same
financial notifications into the Cashier's displayed transaction history.

Four confirmed defects remained on main at 7dd926c9d8:

- A financial-channel reconnect refreshed balances but did not refresh history.
- A history invalidation arriving during a pending read was discarded.
- A club change could skip its new read and accept the previous club's result.
  The session cache also used only the user ID, so it could restore another club.
- Supabase results containing errors or missing data were treated as empty arrays.
  A failed or partial read could erase a previously confirmed history.

## Repair

CashierPage keeps its existing read-only queries, direction mapping, deduplication,
ordering, and limits. Both sources must return arrays without errors before the
merged result is accepted. No ledger writes, money movement, schema or RLS changes.

useCashierHistory owns the displayed rows, loading/error state, read lifetime,
and cache for a single user and club. Normal duplicate reads coalesce.
Confirmed invalidations retain one trailing read per burst, including invalidations
during a trailing read. Superseded snapshots do not reach state or cache.
Scope changes and unmount retire pending work; returning to a previous club cannot
revive its retired request. React StrictMode cleanup is covered.

The new cache includes both user and club in its key and envelope. Unscoped legacy,
expired, future-dated, malformed, and mismatched entries are ignored. Known rows
remain visible during refresh. Failed reads preserve them and show a Retry History
action; an unsuccessful first read does not claim that no transactions exist.

The existing page listeners call the loader. Financial snapshot and ledger
notifications share a history debounce window. Initial loads and tab entry
coalesce; confirmed notifications request a trailing refresh when needed.

## Verification

- Four rendered-page regression cases fail against the original main source:
  missed reconnect read, dropped pending invalidation, wallet-source failure,
  and ledger-source failure. The same cases pass after the repair.
- 229 tests passed across 22 focused suites, including 20 request/cache ownership
  tests and 9 rendered Cashier cases. These use controlled query results, the
  actual financial hook, and actual MasterBus subscription delivery.
- Rendered navigation verifies that old club rows disappear, a late old response
  is ignored, and the new club's pending read retains loading ownership.
- Client TypeScript: no diagnostics.
- Normal push gates, production build and publication evidence are recorded below
  when complete. No hooks have been bypassed.

## Acceptance Boundary

Authenticated physical iPad/PWA acceptance remains unverified. Controlled tests and
published JavaScript establish code behavior and release adoption; they do not
establish a physical-device result. No player balances or seats were changed as probes.
