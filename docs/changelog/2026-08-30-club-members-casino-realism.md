# Club Members #smarterCasinoRealism Audit — 2026-08-30

## Scope

Route: `/clubs/:clubId/members` (production example: Shark Club Players).

Single job: let club staff locate a player, understand their current role, presence,
downline and balances, then enter Member Management without losing roster context.

## Existing Implementation Read

- `src/pages/ClubMembersPage.tsx` already reads the complete roster from the single
  `ca_club_members_overview` RPC and uses structural real-time invalidation.
- `src/hooks/useVirtualScroll.ts` progressively exposes 30 rows, then 20 per viewport
  intersection. This prevents the former 34,000-row DOM failure and was preserved.
- `src/pages/ClubMembersPage.css` rendered every row through `backdrop-filter`, used
  large rounded cards, and had no visual anchor beyond member avatars.
- The session cache wrote only the first 300 rows, briefly presenting that partial set
  as the whole club. During that window summary totals were wrong and CSV export could
  be incomplete.
- Search filtered and sorted the entire roster synchronously on every keystroke.
- Online-but-not-seated members had only a cyan avatar ring, with no visible text state.
- The row button's overriding accessible name omitted player number, club and four of
  the five displayed financial/roster metrics.

## Design Direction

Palette: Obsidian `#05070a`, Carbon `#0d1218`, Gunmetal `#27313c`, Chrome
`#b8c3cd`, Energy Cyan `#00d4ff`, Club Blue `#4169e1`, restrained VIP Gold
`#ffc93c`.

Typography: Rajdhani for the editorial command heading and tabular figures; Roboto
Condensed for compact operational labels; Inter/system sans for readable body copy.

Layout: rendered roster vault hero → live roster telemetry rail → compact search and
filter console → precision access plates for individual members.

Signature: a purpose-built photorealistic personnel vault — black anodized machinery,
chrome portrait medallions, casino chips and a blue crystal core — with real application
data layered beside it in HTML.

The initial concept used the old three detached summary cards. That was rejected during
self-critique because it preserved the generic dashboard composition. The shipped design
integrates telemetry into the rendered vault and keeps the controls in one machined console.

## Changes

- Added `public/images/club-members/roster-vault.webp` (1536×1024, 127 KB), generated
  specifically for the route and compressed for web delivery.
- Rebuilt the full responsive presentation in `src/pages/ClubMembersPage.css`; removed
  per-row backdrop filters, reduced corner radii, added layered chrome framing and a
  single reduced-motion-safe reveal.
- Added semantic hero and directory headings, a visible search label and live result count.
- Made all three roster summary cells stable during loading to eliminate the Agents-card
  layout shift and replaced misleading loading zeroes with an em dash.
- Deferred roster search with React `useDeferredValue`.
- Versioned the roster cache to v3 and made it all-or-nothing under a 1.25M-character cap.
  Oversized union rosters no longer masquerade as a complete 300-row cache.
- Kept CSV export disabled until the authoritative live roster finishes syncing.
- Added a visible `Online` state for connected members who are not seated.
- Expanded member-row accessible names to include player number, home club, wallets and fees.
- Increased avatar transform requests to 64 px to keep the larger medallion crisp without
  fetching full-size storage originals.
- Added regression tests for asset weight, decorative-image semantics, compositor cost,
  deferred search and complete-cache behavior.

## Real-Time Law

Presentation-only change. Existing discrete `CLUB_JOINED`, `CLUB_LEFT` and
`MEMBER_ROLE_CHANGED` bus events plus the named club-members sync channel remain intact.
No snapshot diff, polling loop or timer-based roster refresh was added.

## Verification

- Targeted roster regression suite: 24/24 passed.
- Accessibility, shipped invariants, no-hover law and footer-clearance suites: 57/57 passed.
- TypeScript: passed with zero errors.
- ESLint: passed for the changed TypeScript and test files.
- Production Vite compilation: passed; route chunk is 13.59 KB (4.94 KB gzip).
- Responsive visual verification: passed at 1280×720 and 390×844 with zero horizontal
  overflow; every interactive target is at least 44×44 CSS pixels.
- Production cold-load proof: pending push, World Hub sync and hub-vanguard READY state.
