# Club Arena Hamburger And Workspace Completion Audit

Original audit date: 2026-08-29

Current candidate audit: 2026-10-05

Scope: the hamburger drawer, every destination it advertises, the contextual section rails, all 27 Club Operations destinations, union workspaces, retained compatibility routes, responsive reachability, and the union weekly-accounting read path.

## Current Delivery State

This document describes the current release candidate, not a completed production release.

| Delivery stage                                       | Current state                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Source implementation                                | Implemented in the owned external-SSD worktree                                      |
| Focused local validation                             | Menu/navigation selections and changed fixture's 195-test wrapper pass              |
| Commit and pull request                              | PR #6147 open; rollover repair pushed at `5f608ca16a` and exact-head checks pending |
| Protected merge                                      | Pending                                                                             |
| Database migration installation and catalog readback | Pending                                                                             |
| Club Arena client publication                        | Pending                                                                             |
| Post-deploy browser certification                    | Pending                                                                             |
| Public build identity and affected live behavior     | Pending                                                                             |

Production success must not be inferred from this source audit. Final delivery still requires the protected repository route, exact migration installation/readback, successful `publish-club-arena.yml`, both public `build-info.json` endpoints, post-deploy checks, and live behavior proof.

Exact-head run `37307605805` passed the Club Arena client, server, navigation,
route, and migration checks but its accounting PostgreSQL shard 1 refused an
archived-spin fixture whose bounded recognition capture expired at
`2026-10-05T07:00:00Z`. A fresh read-only production capture proves the current
October 5 to October 12 bounds, the two legitimate post-fee-capture routing
scopes, and zero overlapping runs. The time-bound fixture and exact hash chain
have been refreshed locally, and the focused validator plus 195-test wrapper
pass; exact-head CI remains pending. This is required-check repair, not a
settlement, migration installation, merge, publication, or production-success
claim.

## Audit Basis

The inventory below was reconciled against:

- the four 2026-08-29 hamburger screenshots;
- `src/App.tsx`, including guards, redirects, preserved handlers, and handoffs;
- `src/config/clubArenaNavigation.ts`, `arenaSectionNavigation.ts`, and `clubOperationsNavigation.ts`;
- the actual hamburger, section-rail, workspace, club-context, union-authority, and legacy-redirect implementations;
- the retained-route and inverse reachability contracts;
- the authenticated hamburger, responsive-fit, and 27-route Club Operations browser specifications;
- the new settlement-period RLS migration and its regression contract.

The menu is an orientation surface, not a second authorization system. Hidden or visible links reflect confirmed capabilities, while route guards, Postgres RLS, and RPC authorization remain authoritative.

## Before Sitemap

The screenshots showed one long, mostly flat drawer with many peers that were actually duplicates, child tools, contextual actions, settings, or static help text.

### Game Modes

- Home
- Tournaments
- Tournament Lobby
- Tournament Results
- Hand History
- Hand Replayer
- Session History
- Player Sessions
- Leaderboard
- Marketplace

### Clubs

- My Clubs
- Create Club
- Find Player
- Messages
- Club Messages
- Players
- Cashier

### Unions

- Browse Unions
- Create Union

### Player

- My Profile
- My Wallet
- Achievements
- Player Stats
- VIP Status
- Rakeback
- Promotions
- Bonuses
- Transactions
- Friends
- Waitlist
- Invite Players
- Change Avatar

### Agent And Admin

- Agent Management
- Agent Dashboard
- Club Dashboard
- Club Settings
- House Ads
- Anti-Cheat

### Settings, Shortcuts, Support, And Legal

- Sounds, Vibrations, Use Real Name, Table Settings, card colors, App Settings, and Notifications
- Show Shortcuts plus six static shortcut rows
- Help & FAQ, Terms Of Service, Privacy Policy, Fair Gaming, Promotion Rules, Reset Tutorial, and Log Out

### Problems In The Former Structure

- Home and My Clubs led to overlapping arena entry points.
- Tournaments and Tournament Lobby were duplicate doors.
- Hand Replayer was presented as a peer even though replay belongs to a selected hand.
- Player Sessions duplicated the club-scoped Players workspace.
- Messages and Club Messages were separate doors to one Messenger.
- Agent Management, Players, Club Dashboard, Club Settings, and Anti-Cheat lacked one stable club context.
- Club finance, risk, control, union accounting, and legal content had no canonical overview.
- Union administration used context-free aliases and inferred authority from the route shape.
- Static shortcut help occupied primary-navigation space.
- Conditional club, union, and platform tools were mixed with player destinations.
- Several finished deep pages could be reached only by knowing their URL, while duplicate aliases remained advertised.

## After Sitemap: Primary Command Drawer

All club-aware global destinations retain the current club through `?club=`. Club-scoped URLs retain the slug or identifier already in the route. The profile, settings, and legal destinations remain account/global routes.

| Group               | Label                | Destination                                                    | Purpose and current surface                                                                                             | Visibility                                                  |
| ------------------- | -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Profile             | Player profile plate | `/profile`                                                     | Avatar, player identity, VIP state, and live Diamond balance                                                            | Signed-in player                                            |
| Play                | Play & Review        | `/play`                                                        | Canonical overview for competition, hands, sessions, and rankings                                                       | Signed-in player                                            |
| Play                | Club Arena           | `/`                                                            | Club cards, live games, and arena entry                                                                                 | Signed-in player                                            |
| Play                | Tournaments          | `/tournaments`                                                 | Schedule, registration, and live events                                                                                 | Signed-in player                                            |
| Play                | Tournament Results   | `/tournament-results`                                          | Finishes, prizes, and past events                                                                                       | Signed-in player                                            |
| Play                | My Spin Results      | `/tournament-results?filter=mine&type=spin`                    | Preserved filtered results view with both query parameters                                                              | Signed-in player                                            |
| Play                | Hand History         | `/hand-history`                                                | Hand archive with the retained inline replay, share, and analysis actions                                               | Signed-in player                                            |
| Play                | Session History      | `/session-history`                                             | Session results and performance                                                                                         | Signed-in player                                            |
| Play                | Leaderboards         | `/leaderboard`                                                 | Club and global rankings                                                                                                | Signed-in player                                            |
| Community           | Community Center     | `/community`                                                   | Canonical overview for discovery, activity, and conversation                                                            | Signed-in player                                            |
| Community           | Find Players & Clubs | `/search`                                                      | One arena-wide search surface                                                                                           | Signed-in player                                            |
| Community           | Messages             | `/messages`                                                    | Same-origin Club Arena handoff to Smarter.Poker Messenger, retaining club context                                       | Signed-in player                                            |
| Community           | Friends              | `/friends`                                                     | Friends, requests, and challenges                                                                                       | Signed-in player                                            |
| Community           | Unions               | `/unions`                                                      | Union directory and network management                                                                                  | Explicit `fn_can_i_operate_the_union_network` approval only |
| Wallet & Rewards    | Rewards Center       | `/rewards`                                                     | Canonical overview for balances, benefits, offers, and milestones                                                       | Signed-in player                                            |
| Wallet & Rewards    | Wallet               | `/wallet`                                                      | Balances, transfers, and ledger access                                                                                  | Signed-in player                                            |
| Wallet & Rewards    | Cashier              | `/clubs/:clubId/cashier` in club context, otherwise `/cashier` | Club Trade cashier when a club is known; retained account cashier fallback otherwise                                    | Signed-in player; data remains server/RLS scoped            |
| Wallet & Rewards    | Marketplace          | `/marketplace`                                                 | Club Arena entry; web traffic hands off to `/hub/diamond-store`, while native/in-app return flows retain the storefront | Public handoff or signed-in storefront as implemented       |
| Wallet & Rewards    | VIP & Rakeback       | `/vip`                                                         | VIP tier, benefits, and earning rate; `/rakeback` remains linked by the Rewards rail                                    | Signed-in player                                            |
| Wallet & Rewards    | Promotions           | `/promotions`                                                  | Active player offers and rewards                                                                                        | Signed-in player                                            |
| Wallet & Rewards    | Achievements         | `/achievements`                                                | Progress, milestones, and unlocks                                                                                       | Signed-in player                                            |
| Club Operations     | Club Lobby           | `/clubs/:clubId`                                               | Canonical live club lobby                                                                                               | Any confirmed club member                                   |
| Club Operations     | Table Management     | `/clubs/:clubId/table-management`                              | Create, schedule, edit, close games, and control the ticker                                                             | Confirmed game-creation authority for a standalone club     |
| Club Operations     | Agent Dashboard      | `/agent-dashboard?club=:clubId`                                | Downlines, commissions, cashouts, and credit in the selected club context                                               | Club staff                                                  |
| Club Operations     | Advertise Your Club  | `/clubs/:clubId/advertise`                                     | Buy club/event advertising with Diamonds                                                                                | Club staff                                                  |
| Club Operations     | Operations Center    | `/clubs/:clubId/operations`                                    | One permission-aware entrance to the 27-route operator workspace                                                        | Club staff                                                  |
| Platform Operations | Administration       | `/admin`                                                       | Platform and club administration                                                                                        | Platform staff only                                         |
| Platform Operations | House Ads            | `/house-ads`                                                   | Platform campaign controls                                                                                              | Platform staff only                                         |
| Platform Operations | Commerce Desk        | `/commerce-desk`                                               | Diamond refunds, catalog pricing, and comparison evidence                                                               | Platform staff only                                         |
| Settings            | App Settings         | `/settings`                                                    | Audio, gameplay, privacy, and account settings                                                                          | Signed-in player                                            |
| Settings            | Notifications        | `/notifications`                                               | Alert and notification preferences                                                                                      | Signed-in player                                            |
| Support & Legal     | Help Center          | `/help`                                                        | Searchable answers and support                                                                                          | Public                                                      |
| Support & Legal     | Legal Center         | `/legal`                                                       | Canonical overview for all rules and privacy commitments                                                                | Public                                                      |
| Support & Legal     | Fair Gaming          | `/legal/fair-gaming`                                           | Integrity, security, and reporting rules                                                                                | Public                                                      |
| Support & Legal     | Terms Of Service     | `/legal/tos`                                                   | Platform and account terms                                                                                              | Public                                                      |
| Support & Legal     | Privacy Policy       | `/legal/privacy`                                               | Data collection, use, and controls                                                                                      | Public                                                      |
| Support & Legal     | Promotion Rules      | `/legal/promotions`                                            | Eligibility and campaign governance                                                                                     | Public                                                      |

### Drawer Controls That Are Not Routes

- Live/offline/stale context status, confirmed role, and club switcher.
- Destination filtering plus a full arena search handoff.
- Account-scoped pinned and recent destinations.
- Context actions for Create Club, club or union Table Management, Invite Players, Create Union, and Finance & Risk.
- Owner Prize Tools with an explicit prize-club selector.
- Change Avatar, Sounds, Vibrations, Show Real Name On Social, Table Studio, Device Check, and the live 12-control Table Settings panel.
- Reset Tutorial and Log Out.
- Keyboard help remains available from the Poker Arena home shortcut sheet and table controls instead of occupying the route list.

## Contextual Section Rails

These rails expose sibling pages without inflating the hamburger.

| Family          | Retained destinations                                                                                                                  | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Play Records    | `/play`, `/tournaments`, `/tournament-results`, `/hand-history`, `/session-history`, `/leaderboard`                                    | Move among play and review surfaces without returning to the drawer                                |
| Community       | `/community`, `/search`, `/friends`, `/messages`, conditional `/unions`                                                                | Keep discovery and conversation together; Unions remains fail-closed                               |
| Rewards Circuit | `/rewards`, `/wallet`, `/transactions`, `/vip`, `/rakeback`, `/promotions`, `/bonuses`, `/achievements`, `/challenges`, `/marketplace` | Keep the complete rewards and account-value family reachable                                       |
| Player Identity | `/profile`, `/settings`, `/notifications`                                                                                              | Keep account controls together; Notifications intentionally renders flush without a duplicate rail |
| Support & Rules | `/help`, `/legal`, `/legal/fair-gaming`, `/legal/tos`, `/legal/privacy`, `/legal/promotions`                                           | Keep public support and legal siblings reachable                                                   |
| Union Network   | Detailed below                                                                                                                         | Preserve union identity while separating directory, oversight, and game authority                  |

Player Stats remains reachable from the Poker Arena home tile and related player links. It was removed from the primary drawer because it is a secondary personal analysis surface, not because its route or live data was removed.

## Club Operations: All 27 Retained Routes

The operation registry is the authoritative inventory. Its access tier controls navigation only; page guards, RPCs, and RLS still decide what may be read or changed.

Access tiers:

- Staff: agent, super agent, manager, admin, co-owner, owner, or platform staff.
- Finance: super agent, admin, co-owner, owner, or platform staff.
- Control: admin, co-owner, owner, or platform staff.

|   # | Label            | Route                                     | Purpose                                                      | Navigation tier                                                                    |
| --: | ---------------- | ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
|   1 | Overview         | `/clubs/:clubId/operations`               | Permission-aware operator command center                     | Staff                                                                              |
|   2 | Dashboard        | `/clubs/:clubId/dashboard-full`           | Club performance, tables, tournaments, and activity          | Staff                                                                              |
|   3 | Players          | `/clubs/:clubId/members`                  | Roster, roles, balances, and member records                  | Staff                                                                              |
|   4 | Agent Team       | `/clubs/:clubId/agents`                   | Hierarchy, downlines, and agent management                   | Staff                                                                              |
|   5 | Reports          | `/clubs/:clubId/reports`                  | Player reports and moderation decisions                      | Staff                                                                              |
|   6 | Hand Review      | `/clubs/:clubId/hand-review`              | Flagged hands and audited hand lookup                        | Staff                                                                              |
|   7 | Agent Network    | `/clubs/:clubId/agent-dashboard`          | Downlines, live agent activity, and network performance      | Staff                                                                              |
|   8 | Anti-Cheat       | `/clubs/:clubId/anti-cheat`               | Integrity flags, collusion screening, and review decisions   | Control                                                                            |
|   9 | Disputes         | `/clubs/:clubId/disputes`                 | Club transaction dispute investigation and resolution        | Staff                                                                              |
|  10 | Blacklist        | `/clubs/:clubId/blacklist`                | Excluded players, reasons, and expiry control                | Control                                                                            |
|  11 | Finance Overview | `/clubs/:clubId/finance`                  | Canonical entry for ledgers, cashier, settlement, and risk   | Finance                                                                            |
|  12 | Club Data        | `/clubs/:clubId/data`                     | Game production, player results, and union invoices          | Finance                                                                            |
|  13 | Financials       | `/clubs/:clubId/financials`               | Rake, commissions, fees, wallets, and ledger activity        | Finance                                                                            |
|  14 | Cashier          | `/clubs/:clubId/cashier`                  | Club chips, transfers, and trade records                     | Finance in the operations registry; member-visible functions remain page/RLS gated |
|  15 | Diamond Wheel    | `/clubs/:clubId/wheel-operations`         | Wheel availability, price, exposure, and return              | Finance                                                                            |
|  16 | Diamond Games    | `/clubs/:clubId/diamond-games-operations` | Plinko and Crash availability, bets, and return              | Finance                                                                            |
|  17 | Diamond Costs    | `/clubs/:clubId/diamond-costs`            | Trial, capacity, renewals, services, and receipts            | Finance                                                                            |
|  18 | Settlement       | `/clubs/:clubId/settlement`               | Weekly accounting, balances, and settlement records          | Finance                                                                            |
|  19 | Insurance Report | `/clubs/:clubId/insurance-report`         | Offer funnel, contracts, and insurance-bank performance      | Finance                                                                            |
|  20 | Bomb Pot Report  | `/clubs/:clubId/bomb-pot-report`          | Forced bomb-pot volume, antes, rake, and board counts        | Control                                                                            |
|  21 | Control Overview | `/clubs/:clubId/control`                  | Canonical entry for policy, promotions, identity, and access | Control                                                                            |
|  22 | Announcements    | `/clubs/:clubId/announcements`            | Publish and review club-wide notices                         | Staff                                                                              |
|  23 | Player Offers    | `/clubs/:clubId/promotions`               | Review the live offer feed players see                       | Staff                                                                              |
|  24 | Promo Vault      | `/clubs/:clubId/promo-vault`              | Buy club inventory and send items to players                 | Control                                                                            |
|  25 | Table Management | `/clubs/:clubId/table-management`         | Open, configure, and close club games                        | Control plus the authoritative game-creation guard                                 |
|  26 | Club Rules       | `/clubs/:clubId/rules`                    | Publish rules players see before joining                     | Control                                                                            |
|  27 | Settings         | `/clubs/:clubId/settings`                 | Identity, limits, permissions, sharing, and lifecycle        | Control                                                                            |

The authenticated browser suite uses the reserved standalone template club because a union-managed club correctly refuses local Table Management. A node-safe browser inventory is pinned to the application registry so a future operation cannot silently escape the positive route sweep.

## Union Workspace

Union identity is now resolved at the layout level even though the layout is mounted above the child `:unionId` route. A route shape never grants authority.

| Label            | Route                               | Purpose                                               | Required authority                                        |
| ---------------- | ----------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Directory        | `/unions`                           | Browse and manage club networks                       | `fn_can_i_operate_the_union_network`                      |
| Create Union     | `/unions/create`                    | Create a union                                        | independent `fn_can_create_union` result                  |
| Overview         | `/unions/:unionId`                  | Union identity, member clubs, and network overview    | Signed-in route; page data remains authoritative          |
| Games            | `/unions/:unionId/games`            | Union games and tournaments                           | Signed-in route; page data remains authoritative          |
| Operations       | `/unions/:unionId/operations`       | Union administration workspace                        | `ca_can_oversee_union` through `UnionOverseerGuard`       |
| Table Management | `/unions/:unionId/table-management` | Create and control union games                        | separate `fn_is_union_operator` game-management authority |
| Union Data       | `/unions/:unionId/data`             | Union production and performance                      | `ca_can_oversee_union`                                    |
| Statements       | `/unions/:unionId/statements`       | Weekly invoices, delivery status, and missed clubs    | `ca_can_oversee_union`                                    |
| Settlement       | `/unions/:unionId/settlement`       | Union balance square-up and period records            | `ca_can_oversee_union`                                    |
| Diamond Costs    | `/unions/:unionId/diamond-costs`    | Union access, sponsored clubs, capacity, and receipts | `ca_can_oversee_union`                                    |

The rail resolves oversight and game-management authority independently, keeps both privileged tiers hidden while their reads are pending or fail, and keys the result to the current union. A slower answer from union A cannot expose links after navigation to union B. The hamburger uses the same current-route identity for its Table Management action, including direct `/unions/:unionId/*` visits.

## Added, Merged, Renamed, Redirected, And Parked Routes

### Canonical Overview And Workspace Routes Added During The Cleanup

- `/play`
- `/community`
- `/rewards`
- `/legal`
- `/clubs/:clubId/operations`
- `/clubs/:clubId/finance`
- `/clubs/:clubId/control`
- `/unions/:unionId/operations`
- `/unions/:unionId/table-management`
- `/unions/:unionId/data`
- `/unions/:unionId/statements`
- `/unions/:unionId/settlement`
- `/unions/:unionId/diamond-costs`

### Compatibility Routes And Consolidations

| Former or duplicate entry                     | Canonical result                        | Disposition                                                           |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `/clubs`                                      | `/`                                     | Redirect; one arena/home implementation                               |
| `/clubs/create`                               | `/?create=club`                         | Redirect to the retained create-club modal                            |
| `/tournament-lobby`                           | `/tournaments`                          | Redirect; one tournament lobby                                        |
| `/hands`, `/history`                          | `/hand-history`                         | Redirect; one hand archive                                            |
| Hand Replayer menu entry                      | Replay action inside `/hand-history`    | Merged into the hand that owns the replay                             |
| `/player-sessions`                            | resolved `/clubs/:clubId/members`       | Contextual redirect; one player-operations workspace                  |
| `/messages/clubs*`, `/clubs/:clubId/messages` | Messenger handoff                       | Club context/conversation is preserved; duplicate menu door removed   |
| `/agent-management`                           | resolved `/clubs/:clubId/agents`        | Contextual redirect                                                   |
| `/players`                                    | resolved `/clubs/:clubId/members`       | Contextual redirect                                                   |
| `/data`                                       | resolved `/clubs/:clubId/data`          | Contextual redirect                                                   |
| `/invite`                                     | resolved `/invite/:clubId`              | Contextual redirect                                                   |
| `/anti-cheat`                                 | resolved `/clubs/:clubId/anti-cheat`    | Contextual redirect                                                   |
| `/clubs/:clubId/dashboard`                    | `/clubs/:clubId/data`                   | Redirect; duplicate Club Data handler removed                         |
| `/clubs/:clubId/lobby`                        | same `ClubHomePage` as `/clubs/:clubId` | Route preserved, implementation consolidated                          |
| `/rakeback-dashboard`                         | `/rakeback`                             | Redirect; one rakeback display                                        |
| `/notification-center`                        | `/notifications`                        | Redirect through the retained compatibility component                 |
| `/waitlist`                                   | `/`                                     | Redirect; waitlist actions remain with the lobby/table that owns them |
| `/union-dashboard`                            | `/unions`                               | Legacy alias only; the real handler is `/unions/:unionId/operations`  |
| `/union-games`                                | `/unions`                               | Legacy alias only; the real handler is `/unions/:unionId/games`       |

No required business handler was deleted. The drawer stopped advertising duplicate aliases, while bookmarks, old notifications, and stale deep links continue to resolve safely.

### Explicitly Parked Product Pages

- `/xmtt`: a built cross-club tournament page intentionally left without a navigation door.
- `/flash-pool`: a built fast-fold lobby intentionally left without a navigation door.

These are not presented as dead, complete, or missing work. They remain declared and covered by the inverse reachability allowlist because launching them is a separate product decision. Developer showcases, diagnostics, share links, and external entry points are also intentionally absent from player navigation.

### Missing-Page Gaps Closed

- Play & Review, Community Center, Rewards Center, and Legal Center now provide canonical family overviews.
- Finance & Risk and Club Control now provide canonical club overviews.
- Every Club Operations tool has a registered door and permission tier.
- Union Operations, Table Management, Data, Statements, Settlement, and Diamond Costs are all reachable from the authorized union rail.
- Agent Network, Anti-Cheat, Hand Review, Promo Vault, Bomb Pot Report, Diamond Wheel, Diamond Games, and Diamond Costs no longer depend on a typed URL.

## Authority And State Corrections In This Candidate

- The union section rail no longer treats any non-Games URL as proof of ownership.
- The parent layout reads the union reference from the current pathname and resolves its canonical UUID.
- Oversight and game-management checks are separate because they admit different people and different tools.
- Pending, rejected, missing, and stale authority reads fail closed.
- Authority state is keyed by union/club context, preventing a late response from the previous route from flashing a privileged door.
- A direct union deep link now receives the same Table Management decision as a union reached through a club.
- The hamburger browser contract now proves My Spin Results including both query parameters, Legal Center, and the real Marketplace handoff.
- The responsive inventory now includes `/play`, `/community`, `/rewards`, `/legal`, and every one of the 27 operator routes at mobile, tablet, and desktop dimensions.

## Weekly Accounting Read Repair

`UnionPeriodRecords` queries union aggregate rows in `settlement_periods` where `union_id` is set and `club_id IS NULL`. The existing SELECT policies derived access through `club_id`, so valid union-period rows were silently removed by RLS and Weekly Accounting could appear empty.

Migration `20261005111546_union_period_records_belong_to_their_union_overseers.sql` makes the smallest supported correction:

- adds one authenticated, SELECT-only policy for the exact aggregate-row shape;
- binds access to the route guard predicate `ca_can_oversee_union(union_id)`, preserving the same union-overseer and platform-staff contract used by the retained workspace;
- leaves existing policies, data, balances, writers, and settlement function bodies unchanged;
- revokes the retired `SECURITY DEFINER` `generate_period_settlements(uuid)` browser entry from `PUBLIC`, `anon`, and `authenticated`;
- retains service-role execution for internal compatibility;
- asserts the catalog postimage and exposes policy/privilege live proofs.

The migration file is implemented and locally contract-tested. It is not installed until the exact migration appears in the production migration ledger and its policy, roles, predicate, function owner/security mode, and privileges are read back.

## Business Logic And Dynamic Data Preservation

- Existing React page handlers remain the destinations for retained routes.
- Supabase, realtime, forms, checkout returns, club switching, Messenger handoff, route guards, and responsive navigation remain wired through their existing owners.
- The hamburger carries context; it does not replace authorization.
- Club and union money pages retain their existing RPC/RLS contracts.
- The only database behavior change in this candidate is the exact union-period SELECT visibility and retirement of the unused browser settlement generator entry.
- Loading, empty, error, permission, stale/offline, and success states remain distinct where their owning pages implement them. A failed authority read is never converted into permission.

## Visual System Boundary

The retained drawer keeps the established Smarter.Poker casino-realism language: near-black vault depth, a restrained blue energy seam, machined chrome/gunmetal borders, crisp condensed typography, compact engineered radii, image-backed club navigation art, clear focus states, and a mobile-width chassis. Existing approved Marketplace, Diamonds, and Club Arena artwork remains authoritative; dynamic text and data stay live.

This candidate does not claim a new full painted-chassis conversion of every variable-height retained page. Producing that safely requires approved master art or native-ratio slice families for each surface. Fabricating CSS frames, stretching a fixed render, or replacing working pages while preserving neither their measured zones nor their dynamic controls would be a high-risk visual rewrite. Under the explicit instruction not to build high-risk changes, that art-dependent conversion was not introduced. The current casino-realism treatment was retained while the navigation, authority, reachability, data, and responsive defects were corrected.

## Focused Candidate Validation

The following evidence is local candidate evidence only. It is not merge, installation, publication, or live proof.

| Check                                                             | Result                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused navigation Vitest selection                               | 9 files, 98 tests passed                                                                                                                                                             |
| Dedicated layout-level union authority regression                 | 6 of 6 tests passed, including pending fail-closed behavior, separate authority tiers, stale union A to union B response rejection, account switching, and access-event invalidation |
| Final settlement, migration-law, and union-rail focused selection | 7 files, 61 tests passed                                                                                                                                                             |
| Final integrated affected Vitest selection                        | 10 files, 107 tests passed                                                                                                                                                           |
| Post-review browser-contract selection                            | 2 files, 40 tests passed                                                                                                                                                             |
| TypeScript                                                        | `npx tsc --noEmit -p tsconfig.app.json` passed                                                                                                                                       |
| Navigation and UI copy gates                                      | Title case, painted text, navigation labels, and UI text all passed                                                                                                                  |
| Production build                                                  | `npm run build` passed at `3c84d94b27`, with build provenance reporting `behind-main=0`                                                                                              |
| Browser-spec discovery                                            | Hamburger, responsive-fit, and exhaustive Club Operations specs parsed successfully; 171 tests listed                                                                                |
| Entry-chunk blocker regression                                    | 4 focused files, 64 tests passed; TypeScript and targeted lint passed                                                                                                                |
| Final production build and first-paint gate                       | Build passed for navigation source candidate `c13fc9ae41`; entry-chunk gate passed with no new modules downloaded before first paint                                                 |
| Required-check baseline repair                                    | The existing upstream two-file Horse Phase 11 null-proof repair was carried unchanged; its focused server selection passed 1 file and 95 tests                                       |
| Archived-spin recognition-period rollover                         | Exact capture/manifest/CI hash chain validated; focused wrapper passed 195 of 195 tests                                                                                              |

Browser discovery proves that the cases are registered, not that they passed against production. The 27 positive club routes, conditional menu actions, query-aware hamburger destinations, and 375x812, 834x1194, and 1440x900 overflow checks still require the configured authenticated post-deploy execution.

## Final Verification Required Before Success

- Pass required checks on the exact pushed pull-request head and complete protected merge.
- Install migration `20261005111546` once through the approved database route, then read back the migration ledger, policy command/roles/predicate, and legacy function ACL/owner/security mode.
- Complete `publish-club-arena.yml` successfully.
- Prove the serving revision at both `https://ca-static.smarter.poker/build-info.json` and `https://smarter.poker/hub/club-arena/build-info.json`.
- Read the Client Browser Verification and Live-Table/Engine Verification jobs separately; do not turn an unrelated engine result into a client hold or a client success into engine proof.
- Run the authenticated production hamburger, 27-route operator, union-authority, responsive-fit, no-horizontal-overflow, and broken-link checks.
- Confirm the actual live menu and nested routes, then clean up the isolated fixture state.

## Policy Receipt For This Resumption

- Canonical policy read: `2026-10-05T12:42:45.846Z`
- Portable policy read: `2026-10-05T12:43:21.534Z`
- Policy version: `2.9`
- Manifest SHA-256: `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`
- Owner policy: `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
- Operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
- Hardening standard: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
- Reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
- Owned worktree: `/Volumes/SmarterWork/agent-work/club-arena-menu-finish-20261005`
- Branch: `fix/club-arena-hamburger-final-certification-20261005`
- Candidate head at resumption: `40378fb6dc3437dd5c3db1d35635b934ca553776`
- Latest protected main integrated for local validation: `1a95cbe912`
- Pull request: `#6147`
- Navigation source candidate certified locally and by the production-build job: `c13fc9ae41b0a13f906553b33e0ea5ad01f7bc25`
- Required-check baseline repair carried from upstream: `c8e0e0dc71c7052454365b01df18fe72f9467dd5`
- Active blocker recovered at resumption: production-build entry-chunk gate found `useUnionRouteId.ts` and `unionIdResolver.ts` through the always-mounted section rail. The rail now resolves union identity lazily, remains fail-closed across resolution and authority races, and the focused tests plus exact entry-chunk gate pass locally.
- Required-check baseline repair: exact-head run `37306433361` reproduced the stale current-main Horse Phase 11 null-proof after its completion evidence landed. The already-authored upstream fix `9946e57fb8` was carried unchanged as a test-and-changelog-only repair, and its focused server selection passed 95 of 95 tests.
- Exact-head required-check repair: run `37307605805` passed all other relevant jobs but accounting PostgreSQL shard 1 refused the self-expired archived-spin recognition window. Read-only production evidence captured at `2026-10-05T12:40:08.506687Z` proves the current two-scope state and zero overlapping runs; the bounded fixture/hash chain is refreshed without changing production data or behavior.
- Rollover pre-push receipt: source candidate `5f608ca16a674a8f51b35d2829764cf2b04703a0` passed policy bundle validation, migration/live-schema guards, changed-file contracts, and 653 of 653 selected tests. Remaining evidence at that push was protected checks, publication, and live verification.
