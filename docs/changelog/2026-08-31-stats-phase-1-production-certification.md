# 2026-08-31 — Stats Phase 1 production certification

## Fixed

- Removed the public-profile request for another player's owner-only Stats contract. The database denied the request correctly, but the browser no longer issues a forbidden call or waits for a predictable error.
- Removed private hand, balance and streak aggregates from the public-profile projection, and removed the advanced-summary component's arbitrary target-user input. Owner Stats now enter browser components only through the guarded owner page.
- Removed the unused `PlayerStatsDashboard` TypeScript and CSS placeholders. The old implementation contained fabricated demo values and the retained empty files were still a misleading Stats stub.
- Updated the Stats completion state to record the merged Phase 1 pull request and the production build that served it.
- Investigated the authenticated post-deploy failure from the Playwright trace rather than treating it as CI noise. Three concurrent Stats loads produced PostgREST `PGRST002` schema-cache failures, and the request that reached PostgreSQL ended in `57014` statement timeout.
- Removed the unbounded live-history tail scan from the browser Stats contract. Page views now read the bounded per-player rollup, while the service-only maintenance job remains the single writer that advances its coverage.
- Added explicit `live_tail_included`, `rollup_covered_through`, and `rollup_updated_at` contract fields. The page labels this result as a snapshot and tells the player when newer hands will appear instead of calling delayed data live.

## Regression coverage

- The Stats v2 contract test now pins that public profiles cannot request private Stats data.
- The same test pins that the obsolete fake-dashboard files stay deleted.
- Rollup regression tests now fail if the browser path can reopen `hand_history` through `ca_hand_player_facts`, or if snapshot freshness metadata disappears.

## Phase boundary

- This follow-up certifies Phase 1 only. Club-scoped aggregation and multi-club product work remain in later phases and were not started here.
