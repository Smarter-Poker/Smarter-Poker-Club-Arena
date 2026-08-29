# Hamburger Workspaces And Trust Contract

## What Changed

- Added a route-aware `ClubWorkspaceProvider` for strict club UUID resolution, active membership, role, platform staff, capability, offline, stale, and retry state.
- Added fail-closed staff, finance, and control route gates derived from the same registry that builds operator navigation.
- Corrected the member guard so an access-read failure cannot redirect a valid member to an invite.
- Added canonical Rewards, Legal, Finance and Risk, Club Control, and contextual Union Operations routes.
- Rebuilt the hamburger as a SmarterCasinoRealism command drawer with search, context switching, role-aware quick actions, live attention, pins, recents, and connectivity state.
- Added route-view and route-paint telemetry alongside the existing Core Web Vitals pipeline.
- Added explicit retryable errors to financials, promotions, rakeback, achievements, promo vault, settlement, and insurance reporting.
- Replaced the falsely named CI Lighthouse step with an honest artifact inventory and a real Chromium route-performance/responsive budget.
- Removed the duplicate AppLayout offline banner while preserving root offline replay behavior.

## Safety

- No database migration.
- No RPC or table contract change.
- No handler, form, checkout, settlement, realtime, or wallet mutation replacement.
- Existing compatibility routes remain registered.
- Permission UI fails closed; RLS and server checks remain authoritative.

## Verification

- TypeScript: passed
- Focused role/route/state tests: 28 passing
- Full Vitest suite: 606 files and 9,135 tests passing
- Production build and bundle budget: passed; initial load 316 KiB gzip against a 320 KiB limit, total 2,156 KiB gzip against a 2,400 KiB limit
- Chromium mobile/tablet/desktop route budget: passed on Legal Center and Health, with zero horizontal overflow at 390 px, 834 px, and 1,440 px
- Protected publication and production manifest: enforced before delivery and recorded in the release handoff
