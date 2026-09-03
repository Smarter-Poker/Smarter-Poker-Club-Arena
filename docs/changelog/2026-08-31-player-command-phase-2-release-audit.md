# Player Command Phase 2 Release Audit

2026-08-31. Mandatory release audit of the completed Phase 1 reliability
foundation and Phase 2 directory-first loading work for the Club Arena Players
surface.

## Production Findings

The UI recovery path worked, but it was masking a database read that was no
longer release-grade. An authenticated cold load eventually recovered all 593
SHARK CLUB players without a manual click, yet the direct service-role RPC took
7.216 seconds, then 6.312 seconds, and a third request failed after 14.082
seconds. The roster function rebuilt lifetime fee and hand totals from 59,322
daily/variant rollup rows every time a player searched, filtered, sorted, or
loaded a page.

The recovery budget also belonged to the page rather than the request. Once a
cold read exhausted its two outer recovery cycles, a different search, club, or
manual Retry could inherit that exhausted counter and lose automatic recovery.

Two interaction/accessibility gaps remained:

- Export All could be pressed during the 260ms search debounce and therefore
  export the previous query while the input already displayed the new one.
- The recycled roster exposed a label but not list/listitem semantics or the
  virtual row's position within the complete result set.

## Corrections

- Added `member_fee_lifetime`, an internal one-row-per-player projection of the
  canonical `member_fee_rollup`. A locked initial backfill prevents a write
  race, statement-level transition-table triggers maintain insert/update/delete
  deltas, and the migration aborts unless every user's fees and hands match the
  canonical daily rows exactly.
- Moved only the roster fee CTE to that projection. Authorization, redaction,
  hierarchy, wallet, presence, and horse treatment remain byte-identical.
- Reset bounded recovery for a new club/search/filter/sort request and for an
  explicit user or structural refresh. Automatic attempts for the same request
  remain capped.
- Disabled both export controls while the visible search and the debounced
  authoritative query differ, and duplicated the guard inside the handler.
- Exposed the virtualized directory as one accessible list with accurate
  `aria-posinset` and `aria-setsize` values.

## Verification Evidence

- Transactional production migration compile and rollback: passed.
- Transactional insert, update, delete, and `INSERT ... ON CONFLICT DO UPDATE`
  trigger probes: passed and rolled back.
- Transactional SHARK CLUB timing with the projection: default 593-player page
  0.206-0.487 seconds; `KingFish` search 0.178-0.321 seconds.
- Focused Player Command tests after the corrections: 82 passed.

The complete client/server/build/security/publisher and post-publication live
evidence is recorded by the protected release that contains this file.

No new or reused artwork was introduced in this audit.
