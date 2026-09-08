# Poker Arena: Diamond Arena Build Programme

Date: September 8, 2026. Phase count: 12.

## Approved Product Contract

This replaces the earlier recommendation for two separate World Hub destinations. The World Hub has one player-facing Poker Arena entrance. Reuse the existing Club Arena application as the shared shell, lobby and game implementation. Diamond Arena is a diamond-only skin and operating policy inside it, not a second poker application.

The user explicitly approved:

- Rename the player-facing Club Arena umbrella to Poker Arena.
- Show Shark Club, Diamond Arena and the user's other joined clubs in the shared selector.
- Shark Club is the default chip-club selection, but the user must join before accessing its games or member content. Default selection is not membership.
- Every platform user is already a Diamond Arena member. No join request, join button, approval queue or private-club membership requirement applies to Diamond Arena.
- Other chip clubs retain explicit membership and existing approval rules. Show only a minimal public discovery/join surface to nonmembers; no member data or gameplay access.
- Diamond Arena contains players only. No union structure, agents, subagents, downlines, commissions, agent wallets or private-club ownership flow.
- Player-to-player diamond transfers ARE allowed through the platform wallet and from inside Diamond Arena.
- Diamond Arena gameplay, available balances, custody, fees, prizes, refunds, house funding and reporting are diamond-only. Never convert them to chips or include them in chip balances, journals, treasury totals or supply.
- Reuse Club Arena code and approved assets extensively. Treat the old independent Diamond Arena application as zero: no reuse and no completion credit. Remove all old Diamond Arena runtime code and legacy paths, not merely hide or disable them.
- Preserve active tables when switching lobbies; never automatically switch the player's active table.
- Platform operations remain staff-authorized. A staff permission is not an agent hierarchy.
- Existing horse parity rules remain applicable; “players only” describes the absence of union/agent business roles, not a new exclusion of horses. Any automated participation must use the same funded diamond paths and existing authorization rules.

## What Phase 1 Means

Phase 1 is the architecture, dependency inventory and implementation contract. It does not claim to deliver a playable skin. Phase 2 begins the access/policy implementation; funding and gameplay follow in dependency order.

Phase 1 deliverables:

1. Isolated branch from freshly fetched canonical Club Arena origin/main.
2. This complete phased programme.
3. Source ownership and boundary map.
4. Reconciliation of older written rules with the user's latest directions.
5. Explicit acceptance gates, existing release prerequisites, and no unknowns disguised as completed work.

Source baseline for this phase:

- Canonical checkout: /Users/smarter.poker/Documents/club-arena.
- Worktree: /Users/smarter.poker/Documents/.agent-trees/club-arena/codex-diamond-arena-plan.
- Branch: agent/codex-diamond-arena-plan/feature/poker-arena-diamond-phase-1.
- Fetched baseline: 5717a6d1e2221d0d9054f3ca76fd8ab0d009dc11.
- World Hub source inspected earlier: e6aaa044e52bc01ef6639c133e52498014b02601. Refresh its authoritative head in its own worktree before implementation.

No source checkout containing other agents' unfinished work will be reset, cleaned, copied wholesale or used as the implementation branch.

## Source Evidence And Corrections

The existing HomePage loads memberships through ClubsService.getUserMemberships and uses ClubJoinService. ClubJoinService calls fn_preview_club_join and fn_join_club_atomic. These remain the chip-club entry path.

ClubHomePage accepts clubIdOverride, which is a useful composition seam. It does not make the whole page currency-independent or authorize automatic membership.

The existing router and Vite asset base use /hub/club-arena. Rename visible labels first and preserve working URLs; do not rename the repository, engine service, RPC namespace or deployment directory simply to match branding. A /hub/poker-arena alias can be added through the established route configuration with deep-link tests. /hub/diamond-arena should become a compatibility link selecting the Diamond skin inside the same shell, not another lobby application.

Current platform accounting migrations already created clubs.asset, clubs.is_platform and an arena identity. Their presence earns zero completion credit for this build. Inspect and safely reconcile them rather than creating a duplicate system arena or erasing records.

Older rules in DIAMOND-RULINGS 4 and 16 prohibited wallet transfers; the user's explicit instruction here supersedes that prohibition. Current code may have removed or disabled the old transfer route/UI. Phase 4 must verify the current implementation and restore a single atomic authorized path where necessary. Merely displaying an old wallet control is insufficient.

Older arena funding functions use club_members.chip_balance. That storage model conflicts with the latest diamond-only requirement and must not power the new skin. Keep generic gameplay algorithms; provide distinct diamond-denominated custody and ledger ownership. Existing chip-named financial fields are not acceptable diamond wallet storage.

The prior read-only live audit found a diamond system club with no union, one configured arena settings row, and no arena_deposit/arena_withdraw journal rows under that exact filter. That narrow result is not a full balance or migration certificate. Re-inventory all holdings and pending obligations before retiring any old path.

Existing DIAMOND-ACCOUNTING-ROADMAP requires seven consecutive clean trial-balance days, zero suspense and no open critical diamond incident before public Diamond tables open. This programme retains that public release gate. It does not prevent implementation, staging or isolated certification testing. Do not invent completed clean days or weaken the gate to finish a phase.

## Architecture

One application, one shared engine implementation, two explicit kinds of game context:

- Joined chip club: current membership and chip economy.
- Global Diamond Arena: automatic platform membership, diamond economy, no business hierarchy.

An arena context should carry stable identity, kind, asset, navigation and capabilities. The server derives financial context from authoritative table/tournament configuration. Browser-supplied asset, club ID or role cannot select an alternative wallet or grant access.

A system clubs row may remain as a nonfinancial foreign-key identity for existing table/tournament relations. It must never acquire chip balances, union associations, agent assignments or ordinary club-creation grants. Existing chip clubs remain unaffected.

Automatic Diamond membership should be a platform entitlement for every account. If shared components require a participation row, create/repair it idempotently behind the entitlement, including existing accounts and new signups, without asking the player to join. A missing materialized row is not a reason to show a join wall. Login/session revocation and normal platform security still apply.

A Diamond participation record must not consume a private-club membership slot, affect agent counts, create an upline, or grant access to Shark Club.

Reuse one engine artifact. Worker placement may later be separated for capacity and failure isolation, but do not fork the game rules or create a new dealer.

## Reuse And Change Map

Paths are relative to Club Arena unless marked World Hub.

| Domain              | Existing Source / Contract                                                                            | Required Treatment                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Arena directory     | src/pages/HomePage.tsx; src/services/ClubsService.ts                                                  | Shared selector; explicit chip membership; automatic Diamond entry; no fabricated memberships  |
| Join flow           | src/services/ClubJoinService.ts; ClubEntryTrustService.ts; fn_preview_club_join; fn_join_club_atomic  | Preserve for chip clubs; Diamond entitlement is separate                                       |
| Membership          | src/services/MembershipService.ts                                                                     | Do not inherit role hierarchy or membership-slot limits for Diamond                            |
| Shared lobby        | src/pages/ClubHomePage.tsx; src/components/lobby/GameLobbyPanel.tsx                                   | Reuse composition and existing cards through an explicit skin/policy boundary                  |
| Game visuals        | src/components/lobby/game-cards/; src/components/table/                                               | Reuse approved artwork, layout, animation and controls; diamond-specific units and identity    |
| Persistent table UI | src/components/table/PersistentTableLayer.tsx; src/App.tsx                                            | Keep seated tables alive across selector/navigation changes                                    |
| Cash queues         | src/services/cashGameLobby.ts; fn_cash_game_lobby; fn_cash_game_join                                  | Reuse queue/must-move behavior with arena isolation and entitlement                            |
| Client transport    | EngineStateClient.ts; EngineSocketMux.ts; TableWebSocket.ts; GameServerAPI.ts                         | One authoritative protocol; asset-aware financial events and reconnect                         |
| Table access        | server/src/services/TableViewerAccess.ts                                                              | Add global entitlement to HTTP/WS paths without opening private clubs                          |
| Engine              | server/src/GameServer.ts; server/src/engine/HandController.ts; PokerEngine.ts; ServerTableEngine\*.ts | Reuse game lifecycle; replace currency-coupled financial boundary, not engine                  |
| Rule extensions     | VariantRules.ts; BombPotScheduler.ts; RunItTwiceEngine.ts; StraddleEngine.ts; TimeBankEngine.ts       | Reuse verified behavior per game; no new untested variants implied                             |
| Configuration       | server/src/services/supabase/tables.ts                                                                | Load authoritative asset and arena capability; validate before play                            |
| Funding             | src/services/TableService.ts; server/src/services/supabase/seats.ts and wallets.ts                    | Shared seat lifecycle, distinct diamond funding/settlement implementation                      |
| Tournaments         | server/src/tournament/TournamentManager\*.ts; settleObligation.ts                                     | Reuse scheduling/state/obligation model with diamond custody and payouts                       |
| Rake and treasuries | ServerTableEngineSettlement.ts; services/supabase/rake.ts; rakeAllocation.ts; FeeReconciler.ts        | Diamond house destinations only; no commission/union/chip legs                                 |
| Platform wallet     | src/services/DiamondService.ts; World Hub useDiamondBalance.js                                        | One authoritative platform available balance, separately identified game custody               |
| Wallet transfer     | World Hub DiamondWalletModal.jsx; pages/api/store/diamond-transfer.js, current successors             | Verify/restore single atomic player-to-player path; preserve existing eligible-recipient rules |
| History/stats       | HandHistoryService.ts; StatsFactsService.ts; SessionStatsService.ts; LeaderboardService.ts            | Shared facts infrastructure, separate asset/scope and replay privacy                           |
| Operations          | financialAlerts.ts; integrity modules; platform staff API                                             | Reuse alerts/recovery, scope incidents and powers explicitly                                   |
| Navigation/publish  | src/main.tsx; vite.config.ts; World Hub next.config.js; publish-club-arena.yml                        | Same SPA/origin; remove legacy Diamond routes and iframe implementation                        |
| Capacity            | server/src/services/tableLease.ts; server/src/scale/                                                  | Verify actual live integration before claiming horizontal scaling                              |

Every implementation phase must expand its row into exact current callers, database functions, triggers, constraints and tests before editing. This table is the boundary inventory, not a claim that all transitive dependencies have been certified.

## Diamond Money Contract

Use the existing authoritative platform diamond balance for available funds. Add/reuse only properly diamond-denominated game custody. Prefer automatic funding on buy-in and automatic release after settled cash-out rather than a second manually funded spendable wallet.

Every movement must:

- Identify authenticated owner, source and destination, asset, amount, operation type and stable idempotency key.
- Bind retries to the exact request; altered payloads cannot replay another movement.
- Validate amount, funds, membership/entitlement, game state and permitted destination server-side.
- Lock in a consistent order and commit funding, custody, seat/entry and journal effects atomically.
- Record enough evidence to recover after a lost response, engine restart or partial delivery.
- Refuse an invalid/unfunded transaction without shutting down the whole arena.
- Produce management alerts for discrepancies and preserve valid unpaid obligations for reconciliation.
- Never invoke chip minting, conversion, distribution, agent credit or union settlement.

Supply conservation counts available wallets, cash-game custody, tournament prize custody, house holdings and any funded Diamond reserves once each. If stacks/pots decompose table custody, do not count both. Transfers and buy-in/cash-out move existing diamonds; they are not mint/burn events.

Use integer diamond units consistent with current wallet/journal storage. Review engine rounding, odd pots, split boards, fees and payout remainders. Do not silently create fractional wallet diamonds.

Tournament playing stacks are nonredeemable tournament units. Entry and prize money are diamonds. Tournament units must never become withdrawable diamonds just because the UI uses diamond artwork. This distinction does not associate the game with Club Arena's spendable chips.

Player transfers spend only available funds. Simultaneous transfer/store purchase/buy-in must never double-spend. Seated users can open the wallet, verify a recipient and transfer available diamonds without abandoning their table. Both parties receive durable records and balance updates.

Purchased-lot provenance, refunds, debts, chargeback handling and existing settlement-window rules must be preserved through transfers and game custody. Do not use generic feature-spend logic that grants VIP users free stakes; any sponsorship must be funded explicitly.

## Phases And Exit Gates

### Phase 1 Of 12: Architecture, Inventory And Programme

- [x] Record all decisions from this conversation, including latest membership correction.
- [x] Establish an isolated current Club Arena worktree and branch.
- [x] Map shared frontend, engine, access, wallet, settlement and deployment boundaries.
- [x] Identify obsolete transfer prohibition, manual Diamond join requirement and chip-named arena funding.
- [x] Define all remaining phases and objective exit gates.
- [x] Update conflicting current specification sections while preserving historical evidence.
- [x] Prepare the verified specification and changelog for branch publication; actual commit/push status is reported separately.

Exit: reviewable programme and reconciled policy in a protected branch; no claim of live gameplay.

### Phase 2 Of 12: Arena Identity, Access And Asset Boundaries

- [ ] Inspect current schema/RPC/trigger chain and preserve any existing arena obligations.
- [ ] Establish exactly one system Diamond identity; no ordinary club grants.
- [ ] Define typed frontend/server arena context and explicit capability rules.
- [ ] Implement automatic Diamond entitlement for current/new users and repairable participation.
- [ ] Keep explicit join/approval before chip-club games and member data, including Shark Club.
- [ ] Enforce no union, agent, commission or private membership-slot association.
- [ ] Authorize lobby, direct links, table state, WebSockets and staff routes consistently.
- [ ] Make unknown/mismatched asset fail at transaction entry; no fallback to chips.

Exit: access and wrong-asset integration tests pass, no public funded games yet.

### Phase 3 Of 12: Diamond Custody, Ledger And Reconciliation

- [ ] Select dedicated diamond custody records; retire dependence on chip_balance.
- [ ] Implement atomic reserve/release and entry/seat contracts using proven Club Arena semantics.
- [ ] Enforce nonnegative amounts, valid denominations and request-bound idempotency.
- [ ] Inventory/forward-migrate any old arena balances without erasing history.
- [ ] Extend all diamond supply/trial-balance/snapshot surfaces and exclude diamond holdings from chip books.
- [ ] Preserve provenance, purchased-lot/debt treatment and audit identities.
- [ ] Add recoverable obligation records and management incident wiring.

Exit: concurrent/replayed/failure-path movements conserve diamonds and produce zero chip effects.

### Phase 4 Of 12: Wallet And Player-To-Player Transfers

- [ ] Inspect current platform transfer route, UI and database status; reconcile earlier retirement.
- [ ] Reuse current wallet components/services where compatible; restore one atomic transfer path if absent.
- [ ] Verify recipient identity, confirmation, server-side eligibility and existing policy.
- [ ] Show available and in-play diamonds separately, with no chip conversion action.
- [ ] Make transfer UI accessible while seated and while browsing.
- [ ] Verify both-party ledger/balance updates and retry behavior.
- [ ] Test transfer versus buy-in, store spend and other outgoing transfer races.

Exit: authorized test users can transfer available diamonds once; reserved game funds remain untouched.

### Phase 5 Of 12: Poker Arena Shell And Diamond Skin

- [ ] Rename visible umbrella/header/World Hub tile to Poker Arena.
- [ ] Reuse current selector: Shark default, Diamond adjacent, joined clubs included.
- [ ] Shark nonmember sees Join, not member content; Diamond never shows Join.
- [ ] Reuse shared lobby sections and approved game-card designs.
- [ ] Scope labels, available balance, icons, filters and persistent preferences to selected arena.
- [ ] Preserve active table, animation and sound behavior across navigation.
- [ ] Keep shared Club Arena technical URLs where needed; create the new Diamond selection inside Poker Arena. Remove the old standalone Diamond route, redirects, aliases and iframe entry points.
- [ ] Test mobile, desktop, deep links, back/refresh, auth return and old caches.

Exit: correct shell/selection/access behavior without old iframe or simulated game content.

### Phase 6 Of 12: First Fully Playable Diamond Cash Game

- [ ] Wire shared NLH engine to Diamond buy-in, actions, settlement and leave.
- [ ] Fund seat, blinds, bets, pots and cash-out in diamonds only.
- [ ] Wire hand history, result events and wallet refresh.
- [ ] Test actual multi-user play in a controlled certification environment.
- [ ] Verify all-in, side pot, tie, disconnect, restart, pending leave and response-loss retry.

Exit: complete play-and-cash-out flow reconciles every diamond; no chip or hierarchy writes.

### Phase 7 Of 12: Cash Game Parity And Table Features

- [ ] Enable each intended Club Arena variant only after corresponding Diamond tests.
- [ ] Reuse waitlists, offers, rebuys/add-ons, seat changes, must-move and multi-table flows.
- [ ] Reuse supported bomb pots, board counts, straddles and run-it-twice.
- [ ] Integrate table skins, cards, time banks, rabbit hunt, chat, voice and throwables where supported.
- [ ] Keep feature diamond charges separate from game stakes, with no double charge.
- [ ] Audit insurance and side-feature liabilities before enabling any such product.
- [ ] Run table lifecycle and denomination regression tests across configurations.

Exit: explicit supported-feature matrix passed; unsupported features remain honestly unavailable.

### Phase 8 Of 12: Tournament, SNG And Heads-Up Funding

- [ ] Reuse registration, late entry, re-entry, rebuy/add-on, balancing and blind clocks.
- [ ] Separate Diamond prize escrow from tournament playing units.
- [ ] Reuse single obligation settlement for prizes, refunds and cancellations.
- [ ] Preserve finishing-position evidence and recover pending obligations after restart.
- [ ] Test every paid place, ties, canceled events and duplicate payout attempts.

Exit: all funded tournament lifecycles close exactly and cannot pay playing-stack units to wallets.

### Phase 9 Of 12: Spins, Bounties, Satellites And Reserves

- [ ] Adapt spins prize draw/reserve logic to funded diamonds.
- [ ] Wire bounty, PKO and mystery-bounty pools and activation rules.
- [ ] Implement diamond-to-diamond satellite escrow transfer and duplicate qualification handling.
- [ ] Fund guarantees and promotional entries from authorized diamond house/budgets.
- [ ] Implement rake/fees/BBJ destinations only in Diamond accounts, where approved.
- [ ] Remove every inherited union/agent distribution and chip treasury dependency.
- [ ] Test prize-pool conservation, capped exposure, rounding and cancellation recovery.

Exit: specialty prize liabilities and reserves reconcile; no inferred new prices/guarantees.

### Phase 10 Of 12: History, Statistics And Management

- [ ] Scope histories/replays, earnings, stats, leaderboards and wallet records to Diamond.
- [ ] Verify public/private fields and opponent card privacy.
- [ ] Show real member/online/seated/table counts with meaningful zero/error states.
- [ ] Add staff-only game configuration, incident review and audited adjustments.
- [ ] Integrate financial push alerts and reconciliation without arena-wide automatic lockout.
- [ ] Verify no agent panels, union menus, chip metrics or synthetic players appear as real activity.

Exit: every displayed metric and management action has an authoritative, tested source.

### Phase 11 Of 12: Adversarial, Load And Regression Verification

- [ ] Test cross-asset request forgery and unauthorized membership/management access.
- [ ] Test transfer/store/game concurrency, duplicate delivery and crash recovery.
- [ ] Verify one engine owner per table and safe release/recovery.
- [ ] Exercise shared chip-club regression suite without spending real user funds.
- [ ] Measure lobby fan-out, action latency, event-loop load, database locks and reconnect storms.
- [ ] Verify actual scaling integration before enabling additional engine workers.
- [ ] Test old bookmarks, expired/revoked sessions, stale storage, service workers and mobile rotation.

Exit: reproducible evidence, measured operating envelope and no unresolved critical build defects.

### Phase 12 Of 12: Release, Retirement And Live Proof

- [ ] Verify existing clean-accounting release prerequisites with actual time-series evidence.
- [ ] Complete an exact migration/engine/frontend compatibility and rollback manifest.
- [ ] Use established Hetzner static/engine publishing; World Hub routing through its pipeline.
- [ ] Verify published SHAs and real public route behavior.
- [ ] Verify certified buy-in/play/leave/transfer end to end after deployment.
- [ ] Delete all legacy Diamond Arena runtime modules, routes, API handlers, iframe assets, jobs, deployment targets, flags and obsolete configuration after dependency verification. Disabled or unreachable code does not satisfy removal.
- [ ] Remove exclusive obsolete database functions, triggers and tables through new forward migrations after reconciling balances and obligations. Preserve historical migration files and financial journal evidence.
- [ ] Search both repositories and deployment configuration for every inventoried legacy symbol/path; document each remaining match as shared infrastructure or historical evidence. Verify old URLs expose no Diamond Arena screen, API or redirect alias.
- [ ] Verify shared Diamond Wallet, player transfers and Club Arena gameplay still work after deletion.
- [ ] Keep rollback compatible with outstanding Diamond tables/obligations.
- [ ] Update phase evidence and all programme status records.

Exit: usable published Diamond skin, exact financial reconciliation, no orphan routes or chip contamination.

## Legacy Removal Contract

Inventory legacy Diamond Arena files, routes, database objects, deployment resources and incoming callers in Phase 2. Remove replaced writers during Phase 3, old UI and route paths during Phase 5, and remaining exclusive infrastructure during Phase 12. Do not build new code on legacy Arena services. Reuse comes from Club Arena and the shared platform wallet. Removing an old Arena wrapper must retain the shared service it calls. No compatibility route for the old standalone Diamond Arena is required; update every internal caller to the new Poker Arena selection. Financial records remain historical evidence, not a legacy execution path. Rollback must not reactivate old Diamond writers or chip-backed funding.

## Verification Standard

A phase closes only when its stated deliverable exists and the relevant checks have passed. A pushed branch is not a published feature; a migration file is not an applied migration; a passing typecheck is not a completed poker hand.

For phases adding runtime code: record exact commit, changed callers, focused behavior tests, required repository checks, schema application evidence where applicable, and deployment status. For Phase 1 documentation: inspect diff, validate source paths and phase coverage, run required hooks/typecheck, and record branch publication separately.

Report format:
“Phase N Of 12 Is Done.”
Brief result and material limitation.
“Ready For Phase N+1 Of 12.”

Do not change phase numbers silently or count existing old Diamond work as completed phases.

## Settings And Prerequisites

No additional user input is required for Phase 1 or the architectural foundation. Audit current approved economic settings before building them into production. If an exact Diamond stake schedule, rake rate/cap, guarantee or prize structure has not been approved, propose concrete settings at the relevant phase; do not silently copy chip amounts or invent future player entitlements. CLAUDE.md 10.9 reserves those future economics to the user. This does not hold up the earlier phases.

The existing seven-clean-day release condition is documented in DIAMOND-ACCOUNTING-ROADMAP, not invented by this programme. Any inability to satisfy it must be reported honestly at release; do not claim an immediate public launch while it remains unmet.

## Immediate Next Batch

Phase 2: expand current access and currency call chains, implement the player-only Diamond entitlement/policy boundary, and keep private chip-club membership enforcement intact. The inherited member-wallet funding functions are inspection/retirement targets. No new Diamond table opens until the proper diamond-only money path has been implemented and verified.
