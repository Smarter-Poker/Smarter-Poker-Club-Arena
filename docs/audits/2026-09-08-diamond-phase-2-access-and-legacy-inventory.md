# Phase 2 Access And Legacy Dependency Inventory

This inventory earns no implementation credit for the old Diamond application. Its runtime is scheduled for deletion under the programme. Preserve the original card artwork and shared platform wallet.

## Access Call Chain

- ClubHomePage, including clubIdOverride in a table tab, mounts ArenaAccessBoundary before any cached club content or chip wallet. The boundary calls caller-bound fn_poker_arena_context. Diamond users see automatic membership and the honest pre-release status, with no join or chip lobby. Phase 5 replaces that pre-release presentation with the complete shared Diamond skin.
- ClubJoinService verifies authoritative context before fn_join_club_atomic. Diamond bypasses the join/referral mutation and returns identity metadata. Public previews still work before login.
- server/src/handlers/state.ts and the WebSocket viewer path share authorizeTableViewer. The function verifies table-to-club identity, existing seats and Diamond entitlement. restrict_observers remains effective.
- loadTable refuses the generic chip engine for Diamond until dedicated custody and settlement are wired. Generic Diamond seat creation is refused in SQL before funding can establish a chip-backed seat.
- Game SELECT policies add an outer membership restriction for chip-club outsiders. Entitlement is checked against auth.uid and a real profile, not a browser role or materialized Diamond membership.
- Ordinary club game-creation and two-argument is_club_admin grants reject Diamond. Historical owner membership becomes player/automatic. Platform staff are checked by the existing fn_is_platform_admin, independently from club hierarchy.

## Live Database Retirement Targets

- fn_arena_deposit(integer,text) and fn_arena_withdraw(integer,text): exclusive legacy chip_balance bridge. Do not reuse. Remove with the custody migration after the complete liability inventory. The Phase 2 member trigger refuses their chip writes transactionally.
- fn_ca_arena_diamonds(): legacy balance reader. Retire after updating its callers and accounting reports.
- fn_ca_arena_seat_is_same_asset(): legacy reporting trigger, not an authorization guard. Its exception swallowing must not be mistaken for financial enforcement. Review/report replacement during custody and operations phases.
- ca_arena_settings and the single clubs identity: reconcile nonfinancial identity/configuration instead of creating another arena. Settings are not proof of completion.
- club_members historical Diamond row: preserve evidence, zero balances checked before role/status transition. No new synthetic membership rows or membership-slot usage.
- Shared DiamondService, platform balances, transaction journal, transfer routes, profiles and accounting evidence remain shared infrastructure. Do not delete them by searching for the word arena or diamond alone.

## World Hub Source Inventory

Baseline: 7c4035bcea827b89f924a8616fd99abdc813f887. Read from origin/main, not another agent's dirty working files.

Delete the standalone page/subpages, iframe entry, exclusive stores/preferences/services/styles, menu/footer/orb registrations and old incoming URLs in Phase 5. Remove exclusive jobs/deployment/database leftovers in Phase 12. Rewrite shared navigation/help references. Preserve public/cards/diamond-arena.png as the approved club image. A route alias or disabled iframe does not satisfy removal.

Matched source/configuration files requiring classification during deletion:

- pages/\_app.js
- pages/hub/[orbId].js
- pages/hub/diamond-arena.js
- pages/hub/diamond-arena/history.js
- pages/hub/diamond-arena/leaderboard.js
- pages/hub/diamond-arena/schedule.js
- pages/hub/diamond-arena/stats.js
- pages/hub/diamond-arena/table-settings.js
- pages/investor.js
- pages/sitemap.xml.js
- src/components/WorldThemeProvider.js
- src/config/bottom-nav-routes.json
- src/config/hamburgerMenus.js
- src/config/world-footer-navigation.json
- src/config/worldMenuNavigation.js
- src/lib/liveHelp/agentPrompts.ts
- src/lib/liveHelp/contextCollector.ts
- src/lib/liveHelp/jarvisKnowledgeBase.md
- src/lib/liveHelp/knowledgeInjection.ts
- src/lib/storage.js
- src/orbs/manifest/registry.ts
- src/registry/masterIndex.ts
- src/scripts/addPageTransitions.js
- src/scripts/batchPageTransitions.js
- src/services/diamondArenaPreferences.js
- src/state/worldStore.ts
- src/stores/diamondArenaStore.js
- src/styles/worlds/diamond-arena.css
- src/types/world.d.ts
- src/world/PremiumHub.tsx
- src/world/components/CardCustomizerPanel.tsx
