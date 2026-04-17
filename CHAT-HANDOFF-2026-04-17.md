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
engine.smarter.poker                     # Hetzner game server
```

## DEPLOY COMMANDS (the ONLY deploy path)

```bash
# 1. Build Club Arena
cd ~/Documents/club-arena && npm run build

# 2. Sync to World Hub
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub

# 3. Deploy (auto-verifies)
cd ~/Documents/Smarter-Poker-World-Hub && bash scripts/git-safe-push.sh "commit message"

# 4. Server deploy (if engine changes)
ssh root@<HETZNER_IP> "cd /opt/poker-engine && git pull && npm run build && pm2 restart poker-engine"
```
