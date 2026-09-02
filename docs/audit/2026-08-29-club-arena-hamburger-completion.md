# Club Arena Hamburger And Workspace Completion Audit

Date: 2026-08-29  
Scope: Hamburger menu, every retained destination, club operator subpages, union tools, rewards, support/legal, route guards, state contracts, responsive shell, and production observability.

## Outcome

The hamburger is now an adaptive command drawer instead of a flat route list. It preserves every existing handler and data source while adding one permission vocabulary, one route-aware club context, consolidated workspace entry points, destination search, global search handoff, club switching, role-aware actions, live dispute attention, user-scoped pins and recents, online/stale status, and route telemetry.

No Supabase schema, RPC, realtime contract, checkout flow, form handler, settlement action, wallet mutation, or route implementation was replaced.

## Before Sitemap

The audited menu exposed these top-level groups:

- Play: `/`, `/tournaments`, `/tournament-results`, `/hand-history`, `/session-history`, `/leaderboard`
- Community: `/search`, `/messages`, `/friends`, `/unions`
- Wallet and rewards: `/wallet`, contextual cashier, `/marketplace`, `/vip`, `/promotions`, `/achievements`
- Club operations: contextual club lobby and `/clubs/:clubId/operations`
- Platform operations: `/admin`, `/house-ads`
- Support and legal: `/help`, `/legal/fair-gaming`, `/legal/tos`, `/legal/privacy`
- Settings: inline player, table, theme, sound, vibration, identity, notification, avatar, tutorial, and sign-out controls

Deep tools were reachable, but rewards, finance, club control, union administration, and legal content did not each have a single canonical overview. Permission state was independently loaded by the hamburger, club rail, operations page, integrity header, bottom navigation, and member guard. A network or RLS failure in the member guard redirected to the invite route, incorrectly presenting an infrastructure fault as lost membership.

## After Sitemap

### Play

- `/play` — canonical Play & Review overview
- `/` — club arena and live game entry
- `/tournaments` — tournament lobby
- `/tournament-results` — results, including the existing spin filter
- `/hand-history` — hand archive and replay entry
- `/session-history` — session archive
- `/leaderboard` — rankings

### Community

- `/community` — canonical community overview
- `/search` — players and clubs
- `/messages` — Messenger handoff
- `/friends` — friends, requests, and challenges
- `/unions` — union directory
- `/unions/create` — union creation
- `/unions/:unionId` — canonical union overview
- `/unions/:unionId/games` — union games
- `/unions/:unionId/operations` — canonical union administration workspace
- `/unions/:unionId/statements` — union statements
- `/unions/:unionId/settlement` — union settlement

### Rewards Circuit

- `/rewards` — new canonical rewards overview
- `/wallet` — balances and transfers
- `/transactions` — account ledger
- `/vip` — VIP tier and benefits
- `/rakeback` — rakeback rate and history
- `/promotions` — live and upcoming promotions
- `/bonuses` — bonus inventory
- `/achievements` — achievement progress
- `/challenges` — daily challenges
- `/marketplace` — diamonds, membership, and items

### Club Workspace

- `/clubs/:clubId` and `/clubs/:clubId/lobby` — one canonical live club lobby implementation
- `/clubs/:clubId/operations` — operator overview
- People and safety: `dashboard-full`, `members`, `agents`, `reports`, `disputes`, `blacklist`
- `/clubs/:clubId/finance` — new canonical Finance and Risk overview
- Finance tools: `data`, `financials`, `cashier`, `settlement`, `insurance-report`
- `/clubs/:clubId/control` — new canonical Club Control overview
- Control tools: `announcements`, `promotions`, `promo-vault`, `rules`, `settings`
- Existing game, tournament, table configuration, jackpot, messaging, invite, and report routes remain intact

### Account, Support, And Rules

- `/profile`, `/settings`, `/notifications`
- `/help`
- `/legal` — new canonical Legal Center overview
- `/legal/fair-gaming`, `/legal/tos`, `/legal/privacy`, `/legal/promotions`

### Platform Operations

- `/admin`
- `/house-ads`

## Route Changes

### Added

- `/play`
- `/community`
- `/rewards`
- `/legal`
- `/clubs/:clubId/finance`
- `/clubs/:clubId/control`
- `/unions/:unionId/operations`

### Merged Or Consolidated

- Hamburger, club rails, Club Operations, integrity, and guards now consume one route-aware club workspace identity and capability contract.
- The second AppLayout offline banner was removed; the root offline/replay state remains authoritative across shell and immersive routes.
- Finance tools are grouped behind Finance and Risk; control tools are grouped behind Club Control; rewards and legal pages each have a canonical overview.
- The Union Detail administration link now targets the contextual union operations route instead of the context-free legacy dashboard.
- The CI step previously labelled “Lighthouse” was renamed to Build Artifact Inventory; a real Chromium route-performance gate now measures navigation, load, LCP, CLS, transfer size, and horizontal overflow at three viewport sizes.

### Preserved Compatibility

- `/union-dashboard` remains supported and retains its existing self-discovery logic.
- `/union-games` remains supported.
- Existing `/clubs/:clubId/*` handlers remain their original live components.
- Existing redirects for old lobby, create-club, history, cashier, messages, agent, and other legacy paths remain in place.

### Removed

- No business route was deleted in this phase.
- Duplicate club membership/role reads were removed from the hamburger and shared navigation hook.
- The duplicate shell offline listener/banner was removed.
- Ambiguous fall-through from load failure to an empty financial, promotion, rakeback, achievement, promo-vault, settlement, or insurance state was removed.

## State Contract

Every modified live-data surface now distinguishes:

- Loading: skeleton or progress state
- Empty: successful query with no records
- Error: explicit failure copy with retry where safe
- Permission: confirmed capability denial, without pretending data is empty
- Stale/offline: menu context state, with mutations still owned by the existing offline queue
- Success: the existing live page and mutation handlers

The member guard redirects only after a confirmed inactive/missing membership. Resolution, network, RLS, or profile failures render a recoverable error and do not alter or misrepresent membership.

## Permission Matrix

| Role           | People And Safety | Finance And Risk | Club Control |
| -------------- | ----------------- | ---------------- | ------------ |
| Player         | No                | No               | No           |
| Agent          | Yes               | No               | No           |
| Manager        | Yes               | No               | No           |
| Super Agent    | Yes               | Yes              | No           |
| Admin          | Yes               | Yes              | Yes          |
| Co-owner       | Yes               | Yes              | Yes          |
| Owner          | Yes               | Yes              | Yes          |
| Platform admin | Yes               | Yes              | Yes          |

Postgres RLS and server-side RPC checks remain authoritative beneath these client gates.

## Validation

TypeScript, 9,135 Vitest tests, the production build, bundle budgets, and real Chromium mobile/tablet/desktop performance and overflow checks passed locally. Protected publication and the production manifest are verified before release handoff.
