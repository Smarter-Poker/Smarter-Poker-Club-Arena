# Chat Handoff Prompt — 2026-04-17

Paste everything below the line into a new chat to resume.

---

## CONTEXT: What Just Happened

Two back-to-back sessions completed a massive upgrade sweep across Club Arena (smarter.poker poker client). Everything is deployed and verified on production.

### Session 1: CSS Animation Deep-Dive (Round 50)

Fixed 14 animation bugs that made ALL table animations non-functional. Root cause: event handler watched dead `lastEvent` (Supabase Realtime) instead of `engineLastEvent` (native WS hub). Also wired 6 orphaned CSS animation classes, fixed 3 settings defaults, and added a missing SHOWDOWN server event. Then did a full premium animation upgrade across every CSS file in the app — ActionPanel, TimerBar, PlayerCard, SeatSlot, TablePage, CardAnimations, ThrowAnimation, ThrowableSelector, celebrations, modals, pages, and global utilities. Every keyframe audited and upgraded with easing improvements, GPU acceleration, brightness/saturate filters, and spring physics.

### Session 2: Sound/Haptic/Push/AddOn/BuyIn Upgrade

- **SoundService.ts**: Added 15 new procedural Web Audio game sounds (bombPot, badBeatJackpot, insurancePurchase, insuranceDecline, straddle, chatMessage, throwableImpact, spinTick, spinResult, mysteryBountyReveal, tournamentElimination, tournamentFinalTable, achievement, chipSplash, buyInConfirm)
- **SoundService.ts**: Added 12 premium multi-pulse haptic patterns (bombPot, jackpot, insurance, straddle, spinWheel, mysteryReveal, throwImpact, chatReceived, elimination, achievement, showdown)
- **SoundSettings.tsx**: Full rewrite — removed dead Music/Voice sliders, fixed broken test sound (was referencing non-existent mp3), added Vibration Feedback toggle, added Event Sounds toggle, wired config to actually control SoundService (was disconnected)
- **PushNotificationService.ts**: Added 6 new convenience methods (notifyYourTurn, notifyClubGameStarting, notifyNewMessage, notifyDailyReward, notifyNotableHand, notifyWaitlistReady)
- **10 components wired**: BombPotOverlay, SpinItWheel, InsuranceModal, StraddleToggle, BuyInModal, RebuyModal, AddOnModal, ThrowableReaction, MysteryBountyReveal — all now call appropriate soundService methods instead of basic haptic.medium()
- **BuyInModal.tsx**: Default buy-in changed to MAX (capped by account balance) per Dan's directive. Was `minBuyIn * 2`, now `Math.min(maxBuyIn, accountBalance)`.
- **ServerTableEngine.ts (server)**: Rewrote `addChips()` to queue add-ons during active hands. New `processPendingAddOns()` runs in postHandTasks after pot distribution — caps add-ons so `stack + addOn <= maxBuyIn`, refunds excess to club wallet via `_refundAddOnToWallet()`.
- **types.ts (server)**: Added `min_buy_in` and `max_buy_in` to TableInfo interface.
- **supabase.ts (server)**: Added `min_buy_in, max_buy_in` to `loadTable()` select query.
- **Horse auto-cashout**: Updated to use DB `max_buy_in` instead of hardcoded `big_blind * 200`.

### Deployment Status (Verified 2026-04-17)

- **Vercel (frontend)**: `DEPLOY_VERIFIED:true`, `SHA_MATCHED:true`. Production bundle: `index-D_hr6aF9-v6.js`.
- **Hetzner (game server)**: Docker image rebuilt, container restarted (`4c48d8c7cb0b`). Engine health: `running: true`, 7 hands dealt, 72/hr.
- **TypeScript**: Clean on both client and server (3 TS bugs fixed during deploy: missing brace in HAND_COMPLETE case, OFCDealingOrchestrator stub not a class, duplicate `const oneHourAgo`).

### TS Bugs Fixed During Deploy

1. `TS1128` — `private` field outside class in `ServerTableEngine.ts` — missing `}` closing `case 'HAND_COMPLETE': {` block at line 2810
2. `TS2724` — `OFCDealingOrchestrator` not a class — converted stub from `const` object to proper `class` with `constructor` + `disposeAll()`
3. `TS2451` — duplicate `const oneHourAgo` in `index.ts` — renamed second declaration to `recentActivityCutoff`

---

## HOW TO LAUNCH A TEST TABLE FOR LIVE E2E TESTING

### Prerequisites

- Authenticated user session (Supabase JWT)
- Test account: `daniel@bekavactrading.com` / `<TEST_USER_PASSWORD — see .env.local, never commit>` (all features unlocked)
- Game server running (either locally on port 8080, or production at `engine.smarter.poker`)

### Architecture: How Tables Come Alive

The table lifecycle works like this:

1. **Table record exists in Supabase `tables` table** with `status = 'waiting'` or `'running'`
2. **Player sits down** via the UI (clicks empty seat -> BuyInModal -> confirm)
3. **Seating executes** `supabase.rpc('atomic_table_buyin', { p_user_id, p_table_id, p_seat_number, p_amount })` — atomic RPC that debits wallet + inserts `table_seats` row in one transaction
4. **Game server discovers the table** — `GameServer.discoverCashTables()` polls Supabase every 5 seconds for cash tables (`tournament_id IS NULL`, `status IN ('waiting', 'running')`) with 2+ seated players
5. **Engine starts** — creates `ServerTableEngine(tableId)`, calls `.start()` which loads table info via `loadTable()`, loads seated players, starts the dealing loop
6. **Client connects via WebSocket** — `EngineStateClient` connects to `wss://engine.smarter.poker/ws/table/:tableId` with JWT auth. Receives authoritative state snapshots + events.
7. **Hands auto-deal** when 2+ non-sitting-out players are seated

### Method 1: Use Production (Fastest)

```
1. Go to https://smarter.poker/hub/club-arena/
2. Log in with test account (daniel@bekavactrading.com / <TEST_USER_PASSWORD — see .env.local, never commit>)
3. Navigate to a club (JAQK Club is the seed club: a0000000-0000-0000-0000-000000000001)
4. Open any table from the club's table list
5. Click an empty seat -> Buy-In Modal opens (defaults to MAX) -> Confirm
6. Engine auto-detects within 5 seconds and starts dealing when 2+ players seated
```

The horse fleet (AI players) auto-fills tables, so you likely already have opponents.

### Method 2: Create a Fresh Test Table via Supabase

If you need a clean table with specific settings:

```sql
-- Insert a test table directly into Supabase
INSERT INTO tables (
  id, club_id, name, game_type, game_variant, stakes,
  small_blind, big_blind, min_buy_in, max_buy_in,
  max_players, current_players, status, settings
) VALUES (
  gen_random_uuid(),
  'a0000000-0000-0000-0000-000000000001',  -- JAQK Club
  'Test Table',
  'cash',
  'nlh',
  '1/2',
  1, 2, 80, 400,
  9, 0, 'waiting',
  '{"straddle_enabled": true, "run_it_twice": true, "action_time_seconds": 15, "time_bank_seconds": 30}'
);
```

Then navigate to it and sit down. Engine discovers it automatically.

### Method 3: Run Game Server Locally for Development

```bash
cd ~/Documents/club-arena/server

# Create .env file with required vars:
cat > .env << 'EOF'
SUPABASE_URL=https://kuklfnapbkmacvwxktbh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<get from Supabase dashboard or Vercel env>
SUPABASE_ANON_KEY=<get from Supabase dashboard>
PORT=8080
MAINTENANCE_MODE=false
EOF

# Build and run
npm run build    # tsc -> dist/
npm run start    # node --env-file=.env dist/index.js

# OR for hot-reload during dev:
npm run dev      # tsx watch --env-file=.env src/index.ts
```

The client auto-connects to `localhost:8080` in dev mode (see `GameServerAPI.ts` line 28):

```typescript
const GAME_SERVER_URL =
  import.meta.env.VITE_GAME_SERVER_URL ||
  (import.meta.env.PROD ? 'https://engine.smarter.poker' : 'http://localhost:8080');
```

### Method 4: Seed Data Tables (Already in Database)

The seed script (`supabase/run_seed_v2.mjs`) creates 8 pre-configured tables:

| Table ID (suffix) | Name               | Stakes        | Buy-In Range | Max Players |
| ----------------- | ------------------ | ------------- | ------------ | ----------- |
| ...001            | JAQK Micro         | 0.25/0.50     | 20-50        | 9           |
| ...002            | JAQK Low           | 0.50/1.00     | 40-100       | 9           |
| ...003            | JAQK Mid           | 1/2           | 80-200       | 9           |
| ...004            | JAQK High          | 2/5           | 200-500      | 6           |
| ...005            | JAQK PLO Action    | 0.50/1.00 PLO | 40-200       | 6           |
| ...006            | JAQK PLO High      | 1/2 PLO       | 80-400       | 6           |
| ...007            | JAQK Short Deck    | 1/2 SD        | 80-200       | 6           |
| ...008            | JAQK VIP Nosebleed | 5/10          | 500-2000     | 6           |

Full IDs: `f0000000-0000-0000-0000-00000000000X` where X = 1-8.
Club ID: `a0000000-0000-0000-0000-000000000001` (JAQK Club).

### Game Server HTTP Endpoints (for manual testing)

All POST endpoints require `Authorization: Bearer <supabase-jwt>` header.

```
GET  /health          — Server status (running, tables, hands dealt, uptime)
GET  /ws-metrics      — WebSocket connection counts
GET  /metrics         — Prometheus text format metrics
POST /action          — { tableId, action, amount? } — fold/check/call/bet/raise/all_in
POST /addchips        — { tableId, amount } — add chips (queued if hand active)
POST /sitout          — { tableId, sitOut: boolean }
POST /straddle        — { tableId, enabled: boolean }
POST /timebank        — { tableId } — activate time bank
POST /preaction       — { tableId, action, maxCallAmount? } — set pre-action
POST /leave           — { tableId } — leave table (auto-fold + cashout)
POST /rit             — { tableId, accepted: boolean } — Run It Twice response
POST /insurance       — { tableId, accepted: boolean, coveragePercent? }
GET  /insurance-preview?tableId=X&coveragePercent=Y
POST /heartbeat       — { tableId } — keep connection alive
GET  /state/:tableId  — Full table state snapshot
GET  /actions/:tableId/me — Player's available actions
```

### WebSocket Connection (Real-time State)

```
wss://engine.smarter.poker/ws/table/:tableId
```

Protocol: Send JWT as first message after connect. Server sends:

- `SNAPSHOT` — full table state on connect and periodically
- `PATCH` — JSON Patch diffs for incremental updates
- `EVENT` — discrete game events (insurance_offers, rit_offers, bbj_hit, etc.)

Client implementation: `src/services/EngineStateClient.ts`

### Verifying a Test Hand

After sitting down, watch for these in browser console:

```
[EngineStateClient] Connected to wss://engine.smarter.poker/ws/table/...
[EngineStateClient] SNAPSHOT received (seq: 1)
```

And in the game server logs:

```
[ServerTableEngine:<tableId>] Starting...
[ServerTableEngine:<tableId>] Hand #1 starting with 2 players
```

---

## HOW TO DEPLOY THE GAME SERVER ON HETZNER

### Server Infrastructure

| Component     | Detail                                    |
| ------------- | ----------------------------------------- |
| Provider      | Hetzner Cloud (CPX11 — Ashburn, VA)       |
| Hostname      | `engine.smarter.poker`                    |
| SSH           | `ssh root@engine.smarter.poker`           |
| Server Path   | `/srv/club-arena-server`                  |
| Container     | Docker (`club-arena-engine:latest`)       |
| Reverse Proxy | Caddy (auto-HTTPS via Let's Encrypt)      |
| Port          | 8080 (internal), 443 (external via Caddy) |

### Deploy Process (Standard)

```bash
# 1. SSH into Hetzner
ssh root@engine.smarter.poker

# 2. Pull latest code
cd /srv/club-arena-server
git pull origin main

# 3. Rebuild Docker image and restart
docker compose build engine
docker compose up -d engine

# 4. Tail logs to verify startup
docker compose logs -f engine | head -60
# Look for: "[HTTP] Health check server listening on port 8080"
# Look for: "[WS] Engine WebSocket server attached at /ws/table:tableId"
# Look for: "[GameServer] Started — discovering tables..."

# 5. Verify health
curl -s https://engine.smarter.poker/health | head -5
# Should show: { "status": "ok", "running": true, ... }
```

### Docker Compose Structure

The Docker setup uses `docker compose` (V2). The `engine` service:

- Builds from the `server/` directory
- Maps port 8080
- Passes env vars from `.env` on the Hetzner box
- Auto-restarts on crash (`restart: unless-stopped`)

### Environment Variables on Hetzner

The `.env` file on the Hetzner box at `/srv/club-arena-server/server/.env` must have:

```env
# Required
SUPABASE_URL=https://kuklfnapbkmacvwxktbh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key — bypasses RLS>
SUPABASE_ANON_KEY=<anon key>
PORT=8080

# Optional
MAINTENANCE_MODE=false     # Set to true to stop auto-spawning tables
SENTRY_DSN=<sentry dsn>   # Error reporting (optional but recommended)
```

**CRITICAL:** The `SUPABASE_SERVICE_ROLE_KEY` is required. Without it, the server crashes on startup with `[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set!`.

### Caddy Reverse Proxy

Caddy handles HTTPS termination. The Caddyfile (typically at `/etc/caddy/Caddyfile`) looks like:

```
engine.smarter.poker {
    reverse_proxy localhost:8080
}
```

Caddy auto-obtains and renews Let's Encrypt certificates.

### Monitoring & Health Checks

```bash
# Quick health check
curl -s https://engine.smarter.poker/health | python3 -m json.tool

# Check running containers
docker ps

# Check container resource usage
docker stats club-arena-engine --no-stream

# View recent logs
docker compose logs --tail=100 engine

# Check WebSocket connections
curl -s https://engine.smarter.poker/ws-metrics

# Prometheus metrics
curl -s https://engine.smarter.poker/metrics
```

### Emergency Procedures

```bash
# Force restart
docker compose restart engine

# Full rebuild from scratch
docker compose down
docker compose build --no-cache engine
docker compose up -d engine

# View crash logs
docker compose logs --tail=500 engine | grep -i "error\|fatal\|crash"

# Enter container for debugging
docker compose exec engine sh
```

### Maintenance Mode

Set `MAINTENANCE_MODE=true` in `.env` to prevent the server from auto-discovering and starting table engines. Only `/health` and `/action` endpoints remain active. Useful for:

- Database migrations
- Debugging without new tables spinning up
- Controlled shutdown

---

## WHAT'S NEXT

The sound/haptic/push/animation/add-on sweep is COMPLETE. All changes are deployed to both Vercel and Hetzner. Here are the open items for future sessions:

### Server-Authoritative Migration (CLAUDE.md Section 3)

The migration is at STEP 4-5 (porting core + supporting engines). Read `MIGRATION-LAW.md` and `MASTER-MIGRATION-DOCUMENT.md` Section 8 before any engine work.

### Known Production Issues

- **HIGH**: supabaseKey missing in Horse/Content crons (~216 failed invocations/day). See `CRON-ERROR-REPORT.md`.
- **MEDIUM**: Commander admin uses client-side PIN gate (HTML visible without auth).
- **LOW**: V8 Bible at ~40% compliance — continuing compliance fixes.

### Potential Next Features

- Consolidate 3 separate haptic implementations (SoundService inline, HapticService.ts, utils/haptic.ts) into one
- Auto-rebuy threshold slider in BuyInModal (currently hardcoded at 50%)
- Push notification opt-in flow for new users
- Tournament add-on modal: show "pending" indicator when add-on is queued during hand

---

## KEY FILES TO READ FIRST

```
club-arena/CLAUDE.md                    # Deployment pipeline, code safety, working rules
club-arena/MIGRATION-CHANGELOG.md       # Round 50 (animations) + all prior rounds
club-arena/MIGRATION-LAW.md             # 11 laws governing migration work
club-arena/MASTER-MIGRATION-DOCUMENT.md # Section 8 for current phase
Smarter-Poker-World-Hub/CLAUDE.md       # World Hub deployment + git-safe-push
```

## REPO LOCATIONS

```
~/Documents/club-arena/                  # Club Arena (Vite + React SPA)
~/Documents/Smarter-Poker-World-Hub/     # World Hub (Next.js monolith)
```

## PRODUCTION URLs

```
https://smarter.poker                    # World Hub
https://smarter.poker/hub/club-arena/    # Club Arena (served from World Hub public/)
https://engine.smarter.poker             # Hetzner game server
wss://engine.smarter.poker/ws/table/:id  # WebSocket (game state)
```

## DEPLOY COMMANDS (the ONLY deploy paths)

### Frontend (Vercel via World Hub)

```bash
# 1. Build Club Arena
cd ~/Documents/club-arena && npm run build

# 2. Sync to World Hub
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub

# 3. Deploy (auto-verifies production SHA match)
cd ~/Documents/Smarter-Poker-World-Hub && bash scripts/git-safe-push.sh "commit message"
```

### Game Server (Hetzner via Docker)

```bash
ssh root@engine.smarter.poker
cd /srv/club-arena-server
git pull origin main
docker compose build engine && docker compose up -d engine
curl -s https://engine.smarter.poker/health | head -5
```

## DATABASE

- **Supabase Project**: `kuklfnapbkmacvwxktbh.supabase.co`
- **Key Tables**: `tables`, `table_seats`, `table_hole_cards`, `hand_history`, `club_members`, `profiles`, `clubs`, `unions`
- **Key RPCs**: `atomic_table_buyin`, `atomic_table_rebuy`, `increment_player_wallet`, `increment_club_wallet`
- **Auth**: Supabase Auth — JWT tokens, shared session via `smarter-poker-auth` localStorage key

## TEST ACCOUNT

```
Email:    daniel@bekavactrading.com
Password: <TEST_USER_PASSWORD — see .env.local, never commit>
```

All features unlocked. Works on localhost and production.

## SEED DATA IDS

```
Club:   a0000000-0000-0000-0000-000000000001  (JAQK Club)
Union:  b0000000-0000-0000-0000-000000000001  (Aces United)
Tables: f0000000-0000-0000-0000-00000000000X  (X = 1-8)
Users:  11111111-1111-1111-1111-1111111111XX   (XX = 01-22)
```
