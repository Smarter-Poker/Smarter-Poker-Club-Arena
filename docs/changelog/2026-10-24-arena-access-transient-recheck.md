# A Slow Or Dropped Arena Access Re-Check Keeps The Verified Page

`ArenaAccessBoundary` re-reads the server entitlement (`fn_poker_arena_context`) whenever the window regains focus or becomes visible. During the database timeouts of 2026-10-23, every re-read that timed out unmounted a page the same account had already been verified for - the club lobby, a half-typed cashier amount - and replaced it with "Access Not Verified".

A timeout or an unreachable service is neither a denial nor a new identity (`src/services/arenaAccessFailure.ts`). For exactly those two failure kinds, while the same club and the same account hold a verified context, the page now stays mounted. Any answer the server does give still applies at once: not a member, unknown arena, signed out, a sign-in failure or an unclassified service error removes the page exactly as before, and a first read with nothing verified still shows the honest failure notice.

Transient failures also re-read by themselves after 15 seconds, so a dropped connection recovers without a Retry tap; sign-in and service failures are not retried automatically. Tests: `tests/components/ArenaAccessBoundary.test.tsx` (four new cases fail on the previous component; two preservation cases pin the unchanged fail-closed paths).
