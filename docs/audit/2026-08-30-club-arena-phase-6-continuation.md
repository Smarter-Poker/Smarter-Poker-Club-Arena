# Club Arena Phase 6 — Community Integrity, Play, Rewards, And Union Convergence

Date: 2026-08-30  
Scope: the retained hamburger route families after the shell, account, support/legal, and first community redesign phases. This pass covers Community integrity, Play & Review, the full Rewards Circuit, Union Network subpages, deploy-safe visual media, and navigation regression gates.

## Outcome

The remaining disconnected route families now share canonical overview routes, contextual rails, live cinematic anchors, engineered black-first surfaces, and route-contract coverage. Existing Supabase reads, realtime channels, Master Bus events, forms, permissions, checkout, reward redemption, wallet mutation, tournament registration, statement issuance, settlement, and union governance handlers remain in place.

No destructive data repair, schema mutation, wallet/settlement rewrite, or unsafe relationship cleanup is included.

## Route And Content Disposition

| Route / state                                                                                                              | Purpose and live authority                                                        | Before                                                                                                                   | Phase 6 disposition                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/play`                                                                                                                    | Canonical entrance to tournaments, results, hands, sessions, and rankings         | Missing; Play opened as a flat set of menu links                                                                         | Added **Play & Review** overview and made it the first item in the Play rail and hamburger group.                                                                                                                                                                                                        |
| `/tournaments`                                                                                                             | Live tournament discovery and registration                                        | Retained; visually separate from the other record surfaces                                                               | Retained with a live cinematic tournament header. Registration and buy-in services are unchanged.                                                                                                                                                                                                        |
| `/tournament-results` and query states                                                                                     | Completed events, personal/Spin filters, payouts, bounties, and hand records      | The page reused the fixed-height `.tournament-details` shell class                                                       | Retained and moved to its own scrollable `.tournament-results-page` shell. Query filters and payout math are unchanged.                                                                                                                                                                                  |
| `/hand-history`                                                                                                            | Loaded hand archive, replay, export, share, and Jarvis handoff                    | Retained with a separate matrix/metal treatment                                                                          | Retained under Play & Review with live loaded-hand metrics and an engineered archive surface.                                                                                                                                                                                                            |
| `/session-history`                                                                                                         | Session analytics and CSV export                                                  | Retained with a separate compact page header                                                                             | Retained under Play & Review with live session, hand, and loaded P&L metrics.                                                                                                                                                                                                                            |
| `/leaderboard`                                                                                                             | Club/global real-profit rankings and tournament statistics                        | Retained with a separate matrix/metal treatment                                                                          | Retained under Play & Review with live scope, rank, and ranked-player metrics.                                                                                                                                                                                                                           |
| `/community`                                                                                                               | Canonical community map                                                           | Missing from the earlier flat community group                                                                            | Added **Community Center**, linking Search, Friends, Requests, Activity, Challenges, Messages, and Unions.                                                                                                                                                                                               |
| `/search` and `?q` / `?type` states                                                                                        | Live clubs, profiles, tables, and tournaments                                     | Legacy `tab` input persisted; total source failures erased the last useful results                                       | Legacy `tab` is actively canonicalized to `type`; the last successful query is user-scoped in session storage; live, partial, and cached states are explicit.                                                                                                                                            |
| `/friends` and `?tab` states                                                                                               | Complete relationship roster and request review                                   | Relationship reads had hard result caps; missing profiles displayed as `Unknown`; profile `is_online` could remain stale | All relationship directions use ordered complete-set reads, profile enrichment is chunked, canonical Arena names are used, realtime presence wins, and stored online status requires a fresh `last_seen`. Missing profiles are explicit and unsafe actions are disabled while removal remains available. |
| `/rewards`                                                                                                                 | Canonical rewards overview                                                        | Already added, but retained destinations used unrelated visual systems                                                   | Retained and extended to Marketplace.                                                                                                                                                                                                                                                                    |
| `/wallet`, `/transactions`, `/vip`, `/rakeback`, `/promotions`, `/bonuses`, `/achievements`, `/challenges`, `/marketplace` | Live balances, ledger, points, claims, offers, milestones, missions, and commerce | Live behavior existed across nine unrelated page treatments                                                              | Retained as one coordinated **Value Network** family with route-aware live metrics. Daily Missions keeps its newer native Mission Control authority inside that family. Mutation and checkout paths are unchanged.                                                                                       |
| `/unions`                                                                                                                  | Union directory                                                                   | Already had the approved Union Command design                                                                            | Retained; its cinematic artwork now resolves through the deploy/CDN media base.                                                                                                                                                                                                                          |
| `/unions/create`                                                                                                           | Permission-backed union creation wizard                                           | Generic rounded/glass wizard                                                                                             | Retained as **Union Forge**. Form fields, validation, and creation service are unchanged.                                                                                                                                                                                                                |
| `/unions/:unionId`                                                                                                         | Public union identity and network overview                                        | Generic violet/glass hero; an avatar URL could render as literal text                                                    | Retained with Union Network visual authority. Avatar URLs now render as images and initials remain the fallback.                                                                                                                                                                                         |
| `/unions/:unionId/games`                                                                                                   | Union tournaments, tables, and BBJ pool                                           | Generic social-media cards                                                                                               | Retained with a live Union Games command header and engineered surfaces. Registration services are unchanged.                                                                                                                                                                                            |
| `/unions/:unionId/operations`                                                                                              | Owner/admin union governance                                                      | Existing dense admin dashboard                                                                                           | Retained with a permission-aware Union Operations anchor; all existing tabs and mutation handlers remain.                                                                                                                                                                                                |
| `/unions/:unionId/statements`                                                                                              | Complete statement board and issuance controls                                    | Separate gold/navy mobile treatment                                                                                      | Retained with the cold-ledger Union Network system. Board RPC, CSV export, idempotent issuance, and server authorization are unchanged.                                                                                                                                                                  |
| `/unions/:unionId/settlement`                                                                                              | Chip-moving union settlement                                                      | High-risk financial mutation surface                                                                                     | Retained unchanged and reachable from the union rail. No settlement logic or styling dependency was altered in this pass.                                                                                                                                                                                |

## Before Sitemap

```text
Play
├── /                         Club Arena
├── /tournaments
├── /tournament-results
├── /hand-history
├── /session-history
└── /leaderboard

Community
├── /search
├── /friends
├── /messages
└── /unions

Rewards
├── /rewards                 overview
└── nine live destination pages with separate visual systems

Union Network
├── /unions                  cinematic directory
└── create/detail/games/operations/statements with unrelated page systems
```

## After Sitemap

```text
Play & Review
├── /play                    canonical overview
├── /tournaments
├── /tournament-results
│   └── ?filter=mine&type=spin
├── /hand-history
├── /session-history
└── /leaderboard

Community Center
├── /community               canonical overview
├── /search
│   ├── ?q=:query
│   └── ?type=players|clubs|tables|tournaments
├── /friends
│   └── ?tab=requests|activity|challenges
├── /messages                World Hub Messenger bridge
└── /unions

Rewards Circuit
├── /rewards                 canonical overview
├── /wallet
├── /transactions
├── /vip
├── /rakeback
├── /promotions
├── /bonuses
├── /achievements
├── /challenges
└── /marketplace

Union Network
├── /unions
├── /unions/create
├── /unions/:unionId
├── /unions/:unionId/games
├── /unions/:unionId/operations
├── /unions/:unionId/statements
└── /unions/:unionId/settlement
```

## Route Change Ledger

### Added

- `/play` — canonical Play & Review overview.
- `/community` — canonical Community Center overview.

### Renamed In Navigation

- The Play family entrance is **Play & Review**.
- Community receives **Community Center** as its first destination.
- Existing deep route labels remain recognizable and their URLs are unchanged.

### Merged Or Consolidated

- Play, Community, Rewards, Support/Legal, Club Operations, and Union Network now each have one overview or contextual workspace rather than relying on an exhaustive flat drawer.
- Marketplace is part of the Rewards Circuit rail and overview.
- Union creation, overview, games, statements, and operations now share one visual system without sharing or replacing their business handlers.

### Removed

- No business route or handler was removed.
- No compatibility route was removed; old tournament, history, message, cashier, union, and club deep links continue to resolve through the existing declarations and redirects.

## Integrity And Reliability Improvements

- Relationship reads no longer stop at arbitrary 100/200-row caps.
- Profile enrichment is issued in bounded batches and does not silently convert a failed profile read into hundreds of anonymous users.
- Player naming uses the established Arena identity resolver rather than `username` alone.
- Presence is freshness-aware: realtime presence is authoritative; a stored online flag is accepted only with a recent timestamp.
- Search preserves a recent successful snapshot for transient total failures and labels cached/partial results honestly.
- Canonical search query parameters are written with `replace`, preventing legacy state from remaining in copied URLs.
- All cinematic media in the changed shared headers and workspaces resolves through `MEDIA_BASE`, preserving the Vite base path and optional media CDN.
- A retained-navigation contract test now checks player, club-member, operator, owner, platform-staff, support, section-rail, dynamic club, and dynamic union destinations against declared App routes.

## #SmarterCasinoRealism System

- Void black and carbon surfaces: `#020407`, `#080d12`.
- Machined structure: `#26333d` gunmetal, `#b9cad7` chrome, 3–5px corners.
- Electric blue remains an LED seam, focus signal, and live/attention state rather than a painted page background.
- Rajdhani display typography, Inter body copy, and monospace system/status readouts.
- Cinematic authority comes from existing Smarter.Poker diamond, vault, tournament, lobby-machine, marketplace, and union-bank artwork.
- Large glass panels, violet SaaS gradients, arcade capsules, and external Google-font imports were removed from the changed route families.
- Mobile layouts use edge-aware heroes, 44px controls, clipped horizontal overflow, and single-column collapse where required.

## Deliberately Excluded High-Risk Work

- No bulk deletion, reciprocal repair, or deduplication of friendship rows. Relationship repair requires a server-owned invariant and audited RPC before touching user graph data.
- No new search RPC, full-text index, or schema migration. Those require a measured database rollout and rollback plan.
- No wallet, checkout, reward-settlement, statement-issuance, union-treasury, or chip-settlement rewrite.
- No removal of compatibility routes without production traffic evidence that external links and saved bookmarks no longer depend on them.
- No new Platform Operations overview was introduced because `/admin` currently mixes club administration with platform controls; presenting one merged surface before its authorization model is separated would be misleading.

## Validation

- Focused information architecture, complete-set read, community integrity, cinematic route-family, and route-contract tests: **76 passed across 7 files**.
- TypeScript: **passed** (`tsc --noEmit`).
- Static route-target checker: **126 declared routes and 64 programmatic navigation targets; 0 invalid targets**.
- Title-case policy: **passed**.
- Full Vitest regression: **641 files and 9,465 tests passed** on the fully integrated release head.
- Production build and asset pipeline: **passed** on current `origin/main`; 434 media assets optimized, 0 failed, and build provenance reported `behind-main=0`.
- Authenticated desktop/tablet/mobile route, overflow, broken-link, and interaction verification: pending publication so it can be exercised against the exact immutable production artifact.
