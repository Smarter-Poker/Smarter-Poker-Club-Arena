# Phase 2: Fixed-Limit Completion And Pot-Limit Ceilings

Phase 2 remains in progress. This batch covers part of C03, C04 and BX03. Test success does not establish merged or deployed adoption.

## Benchmark And Defects

Compared September 8, 2026 with Caesars Entertainment WSOP Live-Action Rules 2026, rule 133:
https://assets.wsopcdn.com/wsop/853ee602-e1e9-4019-a0cf-381419d805c6.pdf

Below half a fixed-limit wager, an eligible player can complete it. Half or more is treated as a wager and the next raise uses the full increment. The existing bet-plus-three-raises house cap is retained; other rooms' cap counts are not silently adopted.

Actual HandController regressions reproduced eight failures and six passes before changes: both flh and flo8 rejected opening completions from 1, 5 and 9.99 to 20, and a completion from 25 to 40 after a bet of 20. Half-or-more openings already accepted their full raises.

## Implementation And Wiring

BettingStructure.fixedLimitStreetBounds derives the last counted wager level from aggressive actions on the current street. Calls are excluded because their history amount is chips added, not a raise-to amount. Cumulative small increases are measured against that level. The shared helper supplies the completion increment and half-wager cap count to HandController, the server action normalization/menu and the snapshot publisher. The shared capped-action check consumes the same rule; no automated-seat strategy or policy changes are included.

PokerEngine accepts an explicit fixed-limit completion increment for its matching minimum and maximum. The street bet remains fixed_bet_size; fixed_raise_size separately conveys the current completion increment. Both HTTP and live snapshots publish it. mapEngineSnapshot maps it and TablePage consumes it for both table-tab and action-panel bounds. Older snapshots fall back to the existing street size; server normalization remains authoritative. No SQL or live wallet mutations.

## Verification

- 23 new completion tests: both variants, below/exactly/above-half openings, partial raise completion, cap counting, deep-shove normalization, previously acted player protection, cumulative increases, and actual engine HTTP/live/action-menu parity.
- 20 additional pot-limit tests: independent accounting examples including cents, blinds, antes/dead money represented in the pot, and limpers; actual controller paths for plo4, plo5, plo6 and plo8. Exact ceiling accepted, one cent over rejected without chips spent, deep shove capped.
- Together with existing FixedLimit tests: 81 passed across three files.
- Client snapshot mapping: 10 passed, including distinct completion metadata and older snapshot fallback.
- Server and client TypeScript commands completed without diagnostics.
- Initial local production build compiled the bundle but provenance rejected it because main advanced by one commit. This is a failed build gate, not a build pass. Preserve it; merge current main normally and rebuild. No rebase/orphan-guard bypass.
- After committing and normally merging current main, the second full local build passed, including provenance behind-main=0. SENTRY_AUTH_TOKEN was absent for the local build; no source-map upload was attempted.
- Push gates, CI, automatic merge and deployed source adoption are pending when this evidence is authored. No live financial wager was submitted.

## Additional Stored-Card Review

Read-only installed-function review also traced ca_player_hands_v2 and ca_player_stats_overview_v2. Both call ca_assert_self before the internal reader. The assertion requires matching authenticated identity except for the service role. The internal hand reader suppresses another user's hole cards and is not directly executable by authenticated callers. This extends the direct-reader evidence in phase2-card-visibility; it does not certify all authentication/session policy or the Phase 6/9 aggregate-statistics follow-up.
