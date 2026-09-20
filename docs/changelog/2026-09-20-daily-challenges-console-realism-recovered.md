# Daily Challenges Console Realism Recovered After The September 16 Restoration

## Why this ships again

PR #4516 (`feat(challenges): harden casino-realism console`, squash
`d38bd2aa6bbd57d36ffdfbc23ce2791ff6c538dd`, merged 2026-09-14) delivered the
work described below. PR #4711 (`Restore September 13 GitHub/Hetzner delivery
and application baseline`, squash `ea498c1fab27f2db522072cb3ffa4fff86b3a204`,
merged 2026-09-16) reset every Daily Challenges file to the September 13 source
`c35e9403a043457c8c8d495dd50cf86c35290919`, which is byte-identical to the PR's
parent. Git ancestry therefore contains `d38bd2aa` while the effective tree
carried none of it: the V9 Challenge Vault tile returned 404, the route shell
and its fallbacks were deleted, the three cycle instruments were gone, the
mobile stylesheet again disabled `border-inline` and `clip-path`, the off-schema
gold, coral and brown values were back, and the claimable-vault validator again
compared the seven-day vault with lifetime totals.

This change forward-ports the complete PR #4516 diff onto current `main`. Every
hunk was classified against the intervening work: twenty-one files apply
unchanged because nothing touched them after the restoration; `AuthGuard.tsx`
gains `loadingFallback` beside the newer `publicFallback` (PR #4712) without
weakening it; `PageErrorBoundary.tsx` gets its optional `fallback` on the
Sentry-free implementation; `entryBundleStaysLean.test.ts` gains the Daily
route pin beside the newer ranking-host pin. The Silent Revert Guard will
report this as a historical-content restoration; it is intentional, and no
newer work on these paths is lost (verified with `git log d38bd2aa..main` on
each path).

## What the recovered work does

Daily, Weekly, and Monthly Challenges retain their approved cinematic
`#SmarterCasinoRealism` master instead of being flattened into a generic console.
Each cycle now has its own animated mechanical instrument, every loading card is
a closed machined chassis, mobile hero rails keep all four chamfers, and the
route-specific authentication and crash states use the same artwork, frame, and
instrument language as the live ledger.

Those route fallbacks ship through a focused stylesheet rather than importing
the full mission-page paint into the global application entry. The cinematic
loading experience therefore remains immediate without charging unrelated Club
Arena routes for the complete Daily Challenges stylesheet.

The Club Arena Home entry now uses a native-ratio, text-free Challenge Vault
scene with live DOM title and status copy. The previous static poster, stretched
ratio, and baked-in sample objectives are no longer used. Daily Challenge links
also preserve their active club context through cycle changes, malformed-route
recovery, and mission actions.

The dashboard receipt validator no longer compares the claimable seven-day
reward vault with lifetime completed-minus-claimed statistics. Expired rewards
correctly remain in career totals without making a valid dashboard appear
unavailable.

Regression coverage now includes the three distinct cycle mechanisms, closed
loading frames, the Home tile's intrinsic dimensions, route-specific loading and
crash fallbacks, club-context deep links, the expired-reward receipt case, and an
exact 393px responsive certification pass for every challenge cycle.
