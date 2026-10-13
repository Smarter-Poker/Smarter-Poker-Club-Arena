# Player Command Measured Roster Performance

Phase 6 preserves the existing Player Command roster and its linked Player Record return flow. It reduces rendering work at the original scroll and row boundaries without changing server reads, permissions, exports, wallet transactions, approved artwork or presence delivery.

## Changes

- `src/hooks/useVirtualScroll.ts` previously stored every pixel movement in React state. It now commits only a changed virtual window. The DOM retains the exact pixel position used by return navigation. A shrinking result immediately paints a valid final window; changes to row height or overscan reread the current DOM position. Reset clears both state and its comparison reference. The two existing Club Data consumers retain the same hook API.
- `src/pages/ClubMembersPage.tsx` previously rerendered every mounted row on unrelated parent updates and rebuilt permission/selection arrays every render. The actual row now uses React's default shallow memo comparison; independent presence changes still render, and every changed row property remains an input. Derived loaded identities, selections and allowed filters/sorts are memoized by their actual inputs. Query/owner changes still invalidate selection immediately; private data remains unpersisted.

The row body and its markup are unchanged. No custom comparator hides a capability, wallet, selection, search, position or callback change.

## Measured Verification

The real hook regression failed before the source fix: twelve pixel scroll events within one window caused twelve renders. The same events cause zero renders after the fix. Crossing a window boundary in either direction still commits one update. Tests also cover cold mounting, result shrink, configuration, reset and restored positions.

The identical real row function, measured with and without its memo boundary, renders 192 times for eight unchanged parent updates across 24 rows before optimization and zero times after. Selecting one row renders only that row. Independent presence, wallet/role/seating changes, financial revocation, latest callbacks, column changes and accessible positions remain covered.

These are deterministic render-work measurements, not claims about physical-device latency or database response times. The maintained production workspace case additionally checks the 16-row mount bound, scroll-to-row wiring and original exact 448px Player Record return. Existing mandatory CI runs the focused regressions through `tests/**`; the existing post-publication workflow runs the production case.

Source was reread and diff reviewed. Final local compilation, affected regressions and production build are recorded in the task checkpoint; protected checks, publication and exact serving identity remain separate evidence.
