# TOURNAMENT SYSTEM — Master Status & Tracking Document

**Last Updated**: 2026-03-24
**Architecture**: Server on Railway (Node.js) + Client on Vercel (React/Vite SPA)
**Railway URL**: https://smarter-poker-game-server-production.up.railway.app
**Health Check**: GET /health

---

## ARCHITECTURE OVERVIEW

### Server (Railway) — AUTHORITATIVE
- **File**: `server/src/index.ts` → `GameServer` class
- **Role**: ALL game logic runs here 24/7. No browser dependency.
- **Components**:
  - `GameServer` — Main orchestrator (table discovery, tournament discovery, synchronized breaks)
  - `TournamentManager` — Per-tournament lifecycle (start, resume, blind timer, eliminations, finish)
  - `ServerTableEngine` — Per-table poker engine (deals hands, manages betting)
  - `HorseFleetManager` — AI player (horse) creation & table seating
  - `TournamentRecurringService` — Creates new tournaments on 24/7 schedule
  - `HorseLifecycleManager` — Stuck horse detection, cleanup
  - `AutoRebuyService` — Wallet funding for horses

### Client (Vercel) — DISPLAY ONLY
- **File**: `src/pages/TablePage.tsx`, `src/pages/tournament/*.tsx`
- **Role**: Renders game state from Supabase. Sends player actions via GameServerAPI.
- **Communication**: Supabase Realtime channels + HTTP REST to Railway
- **IMPORTANT**: Client-side `TournamentEngine.ts` and `TournamentTimerService.ts` are LEGACY code from the browser-based dealer page era. The server's TournamentManager is the real engine.

### Supabase
- **URL**: https://kuklfnapbkmacvwxktbh.supabase.co
- **Role**: Database (PostgreSQL), Realtime channels, RPC functions for wallet operations
- **Key Tables**: tournaments, tournament_players, tournament_bounties, tables, table_seats, wallet_transactions, rake_records, profiles

---

## TOURNAMENT TYPES (All Implemented)

| Type | Variant | Server Support | Client UI | Notes |
|------|---------|---------------|-----------|-------|
| MTT | freezeout, rebuy, addon | ✅ | ✅ | Full lifecycle |
| SNG | sng | ✅ | ✅ | Auto-starts when full |
| Spin & Go | spin | ✅ | ✅ | Multiplier wheel, hyper-turbo |
| Bounty (KO) | bounty | ✅ | ✅ | Fixed bounty on knockout |
| PKO | pko | ✅ | ✅ | 50/50 split progressive |
| Mystery Bounty | mystery_bounty | ✅ | ✅ | Random tier bounty reveal |
| XMTT | union MTT | ✅ | ✅ | Cross-club union tournaments |
| Satellite | satellite | ✅ | ✅ | Awards seats, not cash |

---

## FEATURE STATUS

### ✅ FULLY WORKING (Server-Side)
1. **Tournament Creation** — TournamentRecurringService creates on schedule
2. **Registration** — Wallet deduction, refunds on cancel
3. **Start Conditions** — MTT: time + min players. SNG/Spin: when full.
4. **Auto-Cancel** — 30min past start with < 3 players → refund all
5. **Blind Level Advancement** — Recursive timeout, per-level duration
6. **Auto-Extend Blinds** — Doubles last level when structure exhausted
7. **Break Skipping** — Ignores `isBreak` entries in blind structure
8. **Synchronized Hourly Breaks** — All MTTs pause at top of every hour for 5 min
9. **Elimination Detection** — Every 5s, finds 0-chip players
10. **Prize Distribution** — Position-based from payout_structure percentages
11. **Bounty Collection** — KO (fixed), PKO (50/50), Mystery (random tier)
12. **Table Balancing/Merging** — Merges tables with < 3 players
13. **Hand-For-Hand Bubble** — Pauses all tables, syncs hand completion
14. **Final Table Detection** — Announces at ≤9 players
15. **Heads-Up Detection** — Announces at 2 players
16. **Spin Multiplier** — Weighted random roll (2x-240x)
17. **Late Registration** — Level-based cutoff, prize pool recalculation
18. **Rebuy** — During rebuy_levels period
19. **Add-On Period** — Level-based trigger, broadcast to clients
20. **Prize Pool Finalization** — After late reg/addon closes
21. **Payout Normalization** — Ensures payouts sum to exactly 100%
22. **Tournament Finish** — Winner prize, rake settlement (union or club)
23. **Stale Data Cleanup** — On server restart, safe cashout + horse reset
24. **Resume on Restart** — Picks up RUNNING tournaments automatically
25. **Resume Completion** — ≤1 player on resume → finish immediately
26. **Guarantee Support** — Math.max(calculated, guaranteed) for prize pool

### ✅ UI COMPONENTS (Client-Side)
1. **TournamentLobbyPage** — Discover/join tournaments
2. **TournamentDetails** — Tabs: blinds, chips, payouts, entries, rankings
3. **TournamentResultsPage** — Completed tournament results with filtering
4. **TournamentClock** — Projector-ready blind clock with countdown
5. **BlindTimer** — Compact blind display with progress bar
6. **TournamentStandings** — Live chip leaderboard
7. **TournamentRegistration** — Registration list with admin controls
8. **EliminationOverlay** — Knockout animation
9. **FinalTableOverlay** — Final table announcement
10. **HeadsUpOverlay** — Heads-up announcement
11. **TournamentBreakScreen** — Full-screen break timer with standings
12. **TournamentWinnerOverlay** — Winner celebration
13. **HandForHandBanner** — Bubble play banner
14. **SpinAndGoLobby** — Spin lobby with multiplier display
15. **RebuyModal** — Rebuy purchase dialog
16. **AddOnModal** — Add-on purchase dialog
17. **MysteryBountyReveal** — Mystery bounty animation
18. **PayoutStructure** — Prize distribution display
19. **CreateTournamentModal** — Tournament creation (TD tool)

### ✅ RECENTLY COMPLETED
1. **Deal-Making (ICM Chop)** — DealMakingModal component with ICM/Chip/Equal chop calculator + proposal flow. Server endpoints: GET /tournament/deal-state/:id, POST /tournament/execute-deal
2. **Tournament Director Panel** — TournamentDirectorPanel component with pause/resume, add time, skip/revert levels, adjust blinds, force break, cancel. ALL actions go through server HTTP endpoints (POST /tournament/pause, /resume, /add-time, /skip-level, /prev-level, /force-break, /adjust-blinds, /cancel)
3. **Disconnection Handling** — Already built: CircularTimer (SVG countdown arc around player avatar), DisconnectEngine (auto-sit-out after 3 consecutive timeouts), useTableTimer hook (countdown with urgency sounds), server auto-fold timer in ServerTableEngine

### ⚠️ NEEDS VERIFICATION (Tonight's Human Trials)
1. Real human player can register, get seated, see cards, act, play through full tournament
2. Tournament clock displays correctly during play
3. Break screen appears during synchronized breaks
4. Elimination overlay triggers on knockout
5. Add-on modal appears at correct time
6. Winner overlay shows at tournament end
7. Results page shows completed tournament data

---

## BUILD & DEPLOY PROCEDURES

### Client (Vite SPA → Vercel)
```bash
# 1. Build
cd /tmp/ca && npm install && npx vite build

# 2. Push to World Hub
git clone --sparse https://github.com/Smarter-Poker/Smarter-Poker-World-Hub.git /tmp/wh-deploy
cd /tmp/wh-deploy && git sparse-checkout set public/hub/club-arena
rm -rf public/hub/club-arena/assets public/hub/club-arena/index.html
cp -r /tmp/ca/dist/* public/hub/club-arena/
git add -A && git commit -m "message" && git push origin main

# 3. Trigger Vercel deploy
curl -X POST "https://api.vercel.com/v13/deployments?teamId=team_SVD8r7AOPH065G3usBxVvrBc" \
  -H "Authorization: Bearer lRnRVWnwQFWcFV2ny1i5XHsa" \
  -H "Content-Type: application/json" \
  -d '{"name":"hub-vanguard","project":"prj_op66GkZyZcygXQKm76iyycfVFAQx","gitSource":{"type":"github","org":"Smarter-Poker","repo":"Smarter-Poker-World-Hub","ref":"main"},"target":"production"}'
```

### Server (Node.js → Railway)
```bash
# 1. Push server changes to Club-Arena repo
cd /tmp/ca-git && cp -r /tmp/ca/server/* server/
git add -A && git commit -m "message" && git push origin main

# 2. Railway auto-deploys from GitHub (if connected)
# OR manually trigger via Railway dashboard
```

### Source Code (Club-Arena repo)
```bash
git clone https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git /tmp/ca-git
cd /tmp/ca-git && git config user.name "Claude" && git config user.email "claude@smarter.poker"
# Copy changed files, commit, push
```

---

## KEY CREDENTIALS
- **Vercel Token**: lRnRVWnwQFWcFV2ny1i5XHsa
- **Vercel Team**: team_SVD8r7AOPH065G3usBxVvrBc
- **Vercel Project (Hub)**: prj_op66GkZyZcygXQKm76iyycfVFAQx
- **GitHub PAT (Smarter-Poker Master, All Scopes, Never Expires)**: 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
- **Supabase URL**: https://kuklfnapbkmacvwxktbh.supabase.co
- **Supabase Service Key**: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs
- **Supabase Anon Key**: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc3MzA4NDQsImV4cCI6MjA4MzMwNjg0NH0.ZGFrUYq7yAbkveFdudh4q_Xk0qN0AZ-jnu4FkX9YKjo
- **Railway Server**: https://smarter-poker-game-server-production.up.railway.app

---

## STANDING DIRECTIVES
- Horses = AI players (NEVER call them bots)
- NO dollar signs anywhere
- NO rounding (Math.trunc(value * 100) / 100)
- ALL functionality on server (Railway)
- ALL wallet transactions logged
- Tournaments cancel only with < 3 players
- Tournaments displayed 72 hours out
- Mobile-first UI design
