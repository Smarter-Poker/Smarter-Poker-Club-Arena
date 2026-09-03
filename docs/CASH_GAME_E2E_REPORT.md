# Club Arena — Cash Game E2E Test Report

**Date:** March 10, 2026
**Tester:** Claude Agent (Automated E2E)
**Application:** Club Arena (PokerBros Clone)
**URL:** https://club-arena.vercel.app/hub/club-arena/
**Vercel Project:** `prj_iMqVCML4mpVnuBLIuEvvflAoKKBm`

---

## 1. CODEBASE OVERVIEW (Fresh Assessment)

### Scale

- **Total source files:** ~1,180+
- **Pages:** 54 TSX pages + 53 CSS files
- **Components:** 850 files across 99 subdirectories
- **Services:** 59 service modules
- **Engines:** 11 (9 primary + 2 financial)
- **Hooks:** 6 custom React hooks
- **Stores:** 8 Zustand state stores
- **Routes:** 65+ registered routes in App.tsx

### Tech Stack

- React 18 + Vite + TypeScript
- Supabase (Auth, Realtime, Postgres)
- Zustand (state management)
- React Router v6 (BrowserRouter with basename `/hub/club-arena`)
- Vercel (deployment + SPA rewrites)
- Metal UI (custom design system)

### Architecture

- SPA with lazy-loaded routes
- AuthGuard/GuestGuard/TOSGuard wrappers
- TablePage renders standalone (no AppLayout shell — full-screen immersive)
- All other pages render inside AppLayout with navigation
- Real-time via Supabase channels (postgres_changes, presence)
- WebSocket table connection via `useTableWebSocket` hook

---

## 2. COMPLETED WORK (Previous Sessions)

### Bug Fixes Applied

1. **Blinds "undefined/undefined" on empty tables** — Fixed null checks on real-time subscription and initial load in TablePage.tsx
2. **INP Performance Blocking (5-27 second delays)** — Wrapped all `HandController.performAction()` calls in `React.startTransition()` for fold, check, call, raise, and all-in handlers
3. **Git author identity** — Configured for commits

### Features Implemented

1. **Pot Display BB/Chips Toggle** — Full implementation:
   - Added `PotDisplayMode` type ('chips' | 'bb')
   - Added `formatBB()` utility function
   - Extended `PotDisplayProps` with `bigBlind`, `displayMode`, `onToggleDisplayMode`
   - Main pot, side pots, total, and increase indicator all support BB mode
   - Clickable pot with hover effects and cursor styling
   - Wired into TablePage.tsx with state management and callback

### Files Modified

- `src/pages/TablePage.tsx` — Blinds fix, INP fix, pot toggle state
- `src/components/table/PotDisplay.tsx` — BB toggle feature
- `src/components/table/PotDisplay.css` — Clickable styles
- `src/components/table/index.ts` — PotDisplayMode export

### Verified Working (Live E2E)

- Table navigation and loading
- Card dealing and rendering (PremiumCard 3D cards)
- Community cards (flop/turn/river reveal animations)
- Action buttons: Fold, Check, Call, Raise with slider
- Hand strength indicator display
- Pot display with chip animation and counting
- Bad Beat Jackpot ticker display
- Straddle toggle (cash games only)
- Time Bank display
- Horse AI bot opponents
- Session timer
- Buy-in modal
- Table creation page (7 game types: NLH, FLH, 6+, Omaha, FLO, Mixed, OFC)
- Blinds display (after fix)

---

## 3. FULL PAGE INVENTORY

### Standalone Routes (No Shell)

| Route                 | Page                      | Status   |
| --------------------- | ------------------------- | -------- |
| `/`                   | HomePage                  | Untested |
| `/auth`               | AuthPage (GuestGuard)     | Working  |
| `/table/:tableId`     | TablePage (full-screen)   | Tested   |
| `/share/hand/:handId` | HandReplayerPage (public) | Untested |

### Club Routes

| Route                                   | Page                  | Status   |
| --------------------------------------- | --------------------- | -------- |
| `/clubs`                                | ClubCarouselPage      | Tested   |
| `/clubs/create`                         | CreateClubPage        | Untested |
| `/clubs/:clubId`                        | ClubHomePage          | Tested   |
| `/clubs/:clubId/agents`                 | AgentManagementPage   | Untested |
| `/clubs/:clubId/create-table`           | CreateTablePage       | Tested   |
| `/clubs/:clubId/create-table/:gameType` | TableConfigPage       | Tested   |
| `/clubs/:clubId/dashboard`              | ClubDashboard         | Untested |
| `/clubs/:clubId/lobby`                  | ClubLobby             | Untested |
| `/clubs/:clubId/tournaments`            | TournamentPage        | Untested |
| `/clubs/:clubId/messages`               | MessagesPage          | Untested |
| `/clubs/:clubId/cashier`                | CashierPage           | Untested |
| `/clubs/:clubId/agent-dashboard`        | SuperAgentDashboard   | Untested |
| `/clubs/:clubId/members`                | ClubMembersPage       | Untested |
| `/clubs/:clubId/jackpot`                | BadBeatJackpotPage    | Untested |
| `/clubs/:clubId/promotions`             | PromotionsPage        | Untested |
| `/clubs/:clubId/settings`               | ClubSettingsPage      | Untested |
| `/clubs/:clubId/settlement`             | SettlementPage        | Untested |
| `/clubs/:clubId/financials`             | ClubFinancialsPage    | Untested |
| `/clubs/:clubId/reports`                | ReportReviewPage      | Untested |
| `/clubs/:clubId/announcements`          | ClubAnnouncementsPage | Untested |
| `/clubs/:clubId/table-creation`         | TableCreationPage     | Untested |

### Union Routes

| Route                         | Page            | Status   |
| ----------------------------- | --------------- | -------- |
| `/unions`                     | UnionsPage      | Untested |
| `/unions/create`              | CreateUnionPage | Untested |
| `/unions/:unionId`            | UnionDetailPage | Untested |
| `/unions/:unionId/settlement` | SettlementPage  | Untested |

### Tournament Routes

| Route                        | Page                  | Status   |
| ---------------------------- | --------------------- | -------- |
| `/tournaments/:tournamentId` | TournamentDetails     | Untested |
| `/tournament-lobby`          | TournamentLobbyPage   | Untested |
| `/tournaments`               | TournamentLobbyPage   | Untested |
| `/tournament-results`        | TournamentResultsPage | Untested |

### Player Routes

| Route                                     | Page                   | Status   |
| ----------------------------------------- | ---------------------- | -------- |
| `/lobby`                                  | LobbyPage              | Untested |
| `/profile`                                | ProfilePage            | Untested |
| `/settings`                               | SettingsPage           | Untested |
| `/wallet`                                 | PlayerWalletPage       | Untested |
| `/leaderboard`                            | LeaderboardPage        | Untested |
| `/hand-history` or `/history` or `/hands` | HandHistoryPage        | Untested |
| `/notifications`                          | NotificationsPage      | Untested |
| `/messages`                               | MessagesPage           | Untested |
| `/messages/clubs`                         | ClubMessagesPage       | Untested |
| `/search`                                 | SearchPage             | Untested |
| `/help`                                   | HelpPage               | Untested |
| `/cashier`                                | CashierPage            | Untested |
| `/achievements`                           | AchievementsPage       | Untested |
| `/friends`                                | FriendsPage            | Untested |
| `/rakeback`                               | RakebackPage           | Untested |
| `/stats`                                  | PlayerStatsPage        | Untested |
| `/promotions`                             | PromotionsPage         | Untested |
| `/transactions`                           | TransactionHistoryPage | Untested |
| `/vip`                                    | VIPPage                | Untested |
| `/bonuses`                                | BonusPage              | Untested |
| `/waitlist`                               | WaitlistPage           | Untested |
| `/invite`                                 | InvitePage             | Untested |
| `/clubs-list`                             | ClubsPage              | Untested |

### Legal Routes

| Route                | Page                   | Status   |
| -------------------- | ---------------------- | -------- |
| `/legal/tos`         | TermsOfServicePage     | Untested |
| `/legal/promotions`  | ClubPromotionRulesPage | Untested |
| `/legal/fair-gaming` | FairGamingPage         | Untested |
| `/legal/privacy`     | PrivacyPolicyPage      | Untested |

---

## 4. TABLE COMPONENT INVENTORY (114 files)

### Core Gameplay

| Component              | File               | Status            |
| ---------------------- | ------------------ | ----------------- |
| PokerTable             | PokerTable.tsx     | Tested            |
| ActionPanel            | ActionPanel.tsx    | Tested            |
| SeatSlot               | SeatSlot.tsx       | Tested            |
| PotDisplay             | PotDisplay.tsx     | Tested + Enhanced |
| CommunityCards         | CommunityCards.tsx | Tested            |
| PlayerCard / HoleCards | PlayerCard.tsx     | Tested            |
| PremiumCard            | PremiumCard.tsx    | Tested            |
| ChipStack              | ChipStack.tsx      | Tested            |
| TimerBar               | TimerBar.tsx       | Tested            |
| BuyInModal             | BuyInModal.tsx     | Tested            |

### History & Replay

| Component        | File                 | Status   |
| ---------------- | -------------------- | -------- |
| HandHistory      | HandHistory.tsx      | Untested |
| HandReplayPlayer | HandReplayPlayer.tsx | Untested |
| ReplayActions    | ReplayActions.tsx    | Untested |
| HandNotation     | HandNotation.tsx     | Untested |
| ShareHand        | ShareHand.tsx        | Untested |

### Table Features

| Component           | File                    | Status   |
| ------------------- | ----------------------- | -------- |
| RealTimeResults     | RealTimeResults.tsx     | Untested |
| TableChat           | TableChat.tsx           | Untested |
| TableMenu           | TableMenu.tsx           | Untested |
| SettingsPanel       | SettingsPanel.tsx       | Untested |
| PlayerStats         | PlayerStats.tsx         | Untested |
| LeaderboardPanel    | LeaderboardPanel.tsx    | Untested |
| EmotePanel          | EmotePanel.tsx          | Untested |
| EmojiPicker         | EmojiPicker.tsx         | Untested |
| SessionStatsTracker | SessionStatsTracker.tsx | Untested |
| QuickActionBar      | QuickActionBar.tsx      | Untested |
| ThemeSelector       | ThemeSelector.tsx       | Untested |

### Modals & Overlays

| Component             | File                      | Status   |
| --------------------- | ------------------------- | -------- |
| WaitListModal         | WaitListModal.tsx         | Untested |
| SitOutModal           | SitOutModal.tsx           | Untested |
| CashierModal          | CashierModal.tsx          | Untested |
| InsuranceModal        | InsuranceModal.tsx        | Untested |
| GameRulesModal        | GameRulesModal.tsx        | Untested |
| TournamentBreakScreen | TournamentBreakScreen.tsx | Untested |

### Special Features

| Component        | File                | Status        |
| ---------------- | ------------------- | ------------- |
| RabbitHunt       | RabbitHunt.tsx      | Tested        |
| RunItTwice       | RunItTwice.tsx      | Code-reviewed |
| BadBeatJackpot   | BadBeatJackpot.tsx  | Tested        |
| StraddleToggle   | StraddleToggle.tsx  | Tested        |
| TimeBank         | TimeBank.tsx        | Tested        |
| TimeBankDisplay  | TimeBankDisplay.tsx | Untested      |
| TipDealer        | TipDealer.tsx       | Untested      |
| VIPTableSettings | TableSettings.tsx   | Untested      |

---

## 5. ENGINE & SERVICE INVENTORY

### Game Engines

| Engine              | File                                     | Status                  |
| ------------------- | ---------------------------------------- | ----------------------- |
| PokerEngine         | engine/PokerEngine.ts                    | Code-reviewed           |
| HandController      | engine/HandController.ts                 | Code-reviewed + INP fix |
| OFCPineappleEngine  | engine/OFCPineappleEngine.ts             | Code-reviewed           |
| TournamentEngine    | engine/TournamentEngine.ts               | Untested                |
| HeadlessTableEngine | engine/HeadlessTableEngine.ts            | Untested                |
| BotLogic            | engine/BotLogic.ts                       | Code-reviewed           |
| HorseBrainAdapter   | engine/HorseBrainAdapter.ts              | Code-reviewed           |
| RakeWaterfallEngine | engines/financial/RakeWaterfallEngine.ts | Code-reviewed (STUB)    |

### Key Services

| Service                | File                               | Status          |
| ---------------------- | ---------------------------------- | --------------- |
| RakeService            | services/RakeService.ts            | Code-reviewed   |
| BBJService             | services/BBJService.ts             | Code-reviewed   |
| TableService           | services/TableService.ts           | Used in testing |
| SoundService           | services/SoundService.ts           | Working         |
| HandHistoryService     | services/HandHistoryService.ts     | Untested        |
| HandPersistenceService | services/HandPersistenceService.ts | Untested        |
| WalletService          | services/WalletService.ts          | Untested        |
| CommissionService      | services/CommissionService.ts      | Untested        |
| SettlementService      | services/SettlementService.ts      | Untested        |
| TournamentService      | services/TournamentService.ts      | Untested        |
| CashoutService         | services/CashoutService.ts         | Untested        |

---

## 6. KNOWN BUGS (From Code Review)

| #   | Bug                                                                       | Severity | File                   | Status |
| --- | ------------------------------------------------------------------------- | -------- | ---------------------- | ------ |
| 1   | Short Deck hand rankings not adjusted (straights should rank below trips) | High     | PokerEngine.ts         | Open   |
| 2   | HandController betting round completion edge cases                        | Medium   | HandController.ts      | Open   |
| 3   | RunItTwice timer never decrements                                         | Low      | RunItTwice.tsx         | Open   |
| 4   | InsuranceOffer never set/triggered                                        | Low      | InsuranceModal.tsx     | Open   |
| 5   | HandStrengthIndicator uses simplified logic                               | Medium   | TablePage.tsx          | Open   |
| 6   | Commission waterfall not implemented (STUB)                               | High     | RakeWaterfallEngine.ts | Open   |
| 7   | Table creation union guard blocks without early warning                   | Medium   | CreateTablePage.tsx    | Open   |
| 8   | Buy-in multipliers hardcoded, ignoring user config                        | Medium   | TableConfigPage.tsx    | Open   |
| 9   | RabbitHunt generates random cards (demo behavior)                         | Low      | RabbitHunt usage       | Open   |

---

## 7. NEW LIVE E2E TEST — SESSION 2 (Starting Now)

### Test Plan

1. **Authentication** — Login flow
2. **Navigation** — Home → Clubs → Club Detail
3. **NLH Cash Game** — Create table, join, play full hands, verify all features
4. **PLO Cash Game** — Create/join PLO table, verify 4-card hands
5. **Short Deck Cash Game** — Create/join 6+ table, verify removed cards
6. **OFC Cash Game** — Create/join OFC table, verify pineapple mode
7. **Table Features** — Chat, emotes, settings, menu, stats, rabbit hunt
8. **Financial Flow** — Rake calculation, BBJ contribution, cashier
9. **Hand History** — Verify hands are saved and replayable

### Test Results

_(To be filled during live testing)_

---

## 8. GAME VARIANT SUPPORT

| Variant             | Code  | Table Creation | Live Play | Engine             |
| ------------------- | ----- | -------------- | --------- | ------------------ |
| No Limit Hold'em    | NLH   | Tested         | Tested    | PokerEngine        |
| Fixed Limit Hold'em | FLH   | Seen in UI     | Untested  | PokerEngine        |
| Short Deck (6+)     | 6+    | Seen in UI     | Untested  | PokerEngine (bug)  |
| Pot Limit Omaha     | PLO   | Seen in UI     | Untested  | PokerEngine        |
| Fixed Limit Omaha   | FLO   | Seen in UI     | Untested  | PokerEngine        |
| Mixed Games         | Mixed | Seen in UI     | Untested  | PokerEngine        |
| OFC Pineapple       | OFC   | Seen in UI     | Untested  | OFCPineappleEngine |

---

_Report continues with live E2E test results below..._
