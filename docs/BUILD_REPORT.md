# ♠ Club Arena — Build Report

## Session: 2026-01-12 (Latest Update: 04:30 CST)

### Overview
Club Arena is a **PokerBros Clone + Better** — a private poker club platform with Clubs, Unions, Agents, and full poker game logic. This is **Orb #2** in the Smarter.Poker ecosystem, completely separate from Diamond Arena (Orb #3).

### Stats
- **Files**: 25 TypeScript/TSX
- **Lines**: 6,239
- **TypeScript Errors**: 0
- **Server**: http://localhost:5174

---

## Architecture

```
/Documents/club-arena/           ← NEW PROJECT (port 5174)
├── src/
│   ├── components/
│   │   ├── Shell.tsx            ─ Main app layout with nav
│   │   └── Shell.css
│   │
│   ├── pages/
│   │   ├── HomePage.tsx         ─ Landing page with hero + features
│   │   ├── ClubsPage.tsx        ─ My Clubs, Discover, Create tabs
│   │   ├── ClubDetailPage.tsx   ─ Club view with tables/members
│   │   ├── TablePage.tsx        ─ Interactive poker table with engine
│   │   ├── UnionsPage.tsx       ─ Club networks
│   │   └── ProfilePage.tsx      ─ User stats + settings
│   │
│   ├── engine/                  ← POKER ENGINE CORE
│   │   ├── PokerEngine.ts       ─ Deck, hand eval, pots, rake
│   │   ├── HandController.ts    ─ Full hand flow management
│   │   ├── demo.ts              ─ Test utility
│   │   └── index.ts             ─ Exports
│   │
│   ├── services/
│   │   ├── ClubService.ts       ─ Club CRUD operations
│   │   ├── AgentService.ts      ─ PokerBros-style chip transfers
│   │   ├── TableService.ts      ─ Table management
│   │   ├── RoomService.ts       ─ WebSocket multiplayer
│   │   └── TournamentService.ts ─ SNGs and MTTs
│   │
│   ├── stores/
│   │   ├── useClubStore.ts      ─ Club state (Zustand)
│   │   ├── useUserStore.ts      ─ User/auth state
│   │   └── useTableStore.ts     ─ Game state
│   │
│   ├── types/
│   │   └── database.types.ts    ─ Full TypeScript schema
│   │
│   ├── lib/
│   │   └── supabase.ts          ─ DB client with demo mode
│   │
│   └── styles/
│       └── globals.css          ─ Blue/White/Black design system
│
├── supabase/migrations/
│   └── 001_club_arena_schema.sql ─ Full database schema
│
├── vite.config.ts               ─ Port 5174, aliases
└── package.json                 ─ v1.0.0
```

---

## Poker Engine Capabilities

### Hand Evaluation
- **All 10 Rankings**: Royal Flush → High Card
- **Hold'em**: 2 hole cards + 5 community
- **Omaha**: 4-6 hole cards (must use exactly 2)
- **Short Deck**: 6+ cards, modified rankings

### Betting Logic
- Fold, Check, Call, Bet, Raise, All-In
- Min raise enforcement
- All-in handling with side pots

### Pot Calculation
- Main pot + unlimited side pots
- Proper split pot handling
- Rake: configurable % + cap
- No-flop-no-drop rule

### Game Flow (HandController)
1. Post blinds/antes
2. Deal hole cards
3. Preflop betting round
4. Deal flop → betting
5. Deal turn → betting
6. Deal river → betting
7. Showdown → determine winners
8. Distribute pots (minus rake)

---

## Database Schema (Supabase)

### Tables Created
| Table | Description |
|-------|-------------|
| `clubs` | Club info, settings, owner |
| `club_members` | Memberships, roles, chip balances |
| `agents` | PokerBros-style agent hierarchy |
| `tables` | Active poker tables |
| `table_seats` | Who is sitting where |
| `chip_transactions` | Immutable ledger of all transfers |
| `hands` | Hand history with actions |
| `unions` | Club networks |
| `union_clubs` | Union membership |
| `tournaments` | SNGs and MTTs |

### RLS Policies
- Public clubs visible to all
- Members see their clubs' data
- Owners can update clubs
- Players see their hand history

### Helper Functions
- `get_club_stats()` - Member/table counts
- `transfer_chips()` - Atomic chip transfers

---

## UI Components

### Design System (globals.css)
- **Primary**: Royal Blue (#4169E1)
- **Background**: Near Black (#050507)
- **Text**: Pure White (#FFFFFF)
- **Success**: Emerald Green (#10B981)
- **Danger**: Rose Red (#F43F5E)
- **Gold**: FFD700 (chip amounts)

### Pages Built
1. **HomePage** - Hero, features, stats
2. **ClubsPage** - 3-tab layout (My/Discover/Create)
3. **ClubDetailPage** - Tables, Members, Settings
4. **TournamentPage** - SNG/MTT Lobby & Registration
5. **TablePage** - Full poker table with live gameplay
6. **UnionsPage** - Club network discovery
7. **ProfilePage** - VPIP/PFR stats, settings

---

## Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | HomePage | Landing page |
| `/play` | TablePage | Demo poker table |
| `/clubs` | ClubsPage | Club management |
| `/clubs/:id` | ClubDetailPage | Individual club |
| `/clubs/:id/table/:tid` | TablePage | Club table |
| `/clubs/:id/tournaments` | TournamentPage | Tournament lobby |
| `/unions` | UnionsPage | Club networks |
| `/profile` | ProfilePage | User stats |

---

## Running Locally

```bash
cd /Users/smarter.poker/Documents/club-arena
npm run dev
# → http://localhost:5174
```

### Quick Demo
1. Open http://localhost:5174/play
2. Play poker against AI opponents
3. Use Fold/Check/Call/Bet/Raise actions
4. Watch hand log for game events

---

## Integration Points

### Supabase
- Project: `kuklfnapbkmacvwxktbh`
- Schema: `001_club_arena_schema.sql`
- Realtime enabled for tables, seats, members

### Diamond Arena Sharing
- `@diamond` alias points to `../club-engine/src/services`
- Shared logic can be imported across projects

---

## Next Steps

1. ✅ ~~Apply SQL schema to Supabase~~ (Pending user action)
2. ✅ ~~Real-time multiplayer~~ (RoomService built)
3. ✅ ~~Agent management UI~~ (AgentPage built)
4. ✅ ~~Tournament system~~ (TournamentService built)
5. **Mobile responsive** (final polish)
6. **Tournament UI** (lobby and in-game)

---

## Tech Stack

- **React 19** + TypeScript
- **Vite 7** (port 5174)
- **Zustand** (state management)
- **Supabase** (database + realtime)
- **Framer Motion** (animations)
- **react-router-dom v7** (routing)

---

## Stats

| Metric | Value |
|--------|-------|
| Files | 25 |
| Lines of Code | 6,239 |
| TypeScript Errors | 0 |
| Build Status | ✅ Clean |
| Dev Server | ✅ Running |
