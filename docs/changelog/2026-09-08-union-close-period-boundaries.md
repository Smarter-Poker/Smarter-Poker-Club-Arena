# Union Close Period Boundaries

Applied `20260908044150_union_close_period_boundaries_are_disjoint.sql` to production on 2026-09-08.

The weekly rakeback cursor applied the reset floor after calendar alignment. The live floor is 2026-09-07 00:00 UTC, while `fn_union_week_start` defines weeks at Monday midnight in America/Los_Angeles (07:00 UTC in September). A fixed seven-day step from that floor would submit a different period from the statement/cascade paths and could skip hours when the next invocation realigned. Fixed UTC steps also mishandled daylight-saving transitions.

The cursor now applies the floor and then rounds up to the next canonical union week. Each next boundary is calculated by the union calendar. The direct close accepts finite, fully closed, calendar-aligned periods and checks for any overlap with a recorded close after acquiring the union wallet lock. Different period IDs cannot re-cover the same rake interval through this function. This does not change rates, attribution, treasury funding or the user's instruction to start with the first clean week.

Validation: 10 isolated PostgreSQL cases cover invalid/future periods, recorded overlap, adjacent periods, UTC floors, legacy cursors, the 167-hour spring week and the 169-hour fall week. A separate two-session case confirms that concurrent overlapping closes serialize and only one records coverage. Calendar tests stub the payout callback; admission tests use the actual close body with a zero-rake basis. These are period-boundary tests, not a certification of the full attribution/distribution calculation. The combined accounting suite has 166 passing cases on PostgreSQL 17.11.

The production compile probe rolled back its DDL. Applied definitions were verified with unchanged service-role-only grants. Hashes: close 315af918ff53073c0d1f08f4189e49d3; close_all 47828b78ce64337d2da669c7f5c806a7.

Two historical Midway records overlap (2026-04-01 through 2026-08-17 and 2026-08-10 through 2026-08-17). Their overlap is not treated as proof of two independent payouts. They predate the explicit reset floor and were neither settled again nor edited. Full historical provenance and the downstream club/agent/player distribution audit remain open.

Publishing follows the Club Arena Hetzner pipeline: branch, automatic PR/required checks/merge, then publish-club-arena.yml to ca-static.smarter.poker under /srv/club-arena/releases/<commit>. Database definitions are already applied independently. No direct World Hub/Vercel publication is used.
