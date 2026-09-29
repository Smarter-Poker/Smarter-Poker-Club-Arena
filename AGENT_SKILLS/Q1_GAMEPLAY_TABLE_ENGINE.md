# Q1: Gameplay & Table Engine — Agent Skill

## Overview

This skill covers **everything that happens at the poker table** — the live gameplay experience, animations, sounds, multiplayer sync, tournaments, and all table utilities. This is where the money lives.

---

## Architecture Quick Reference

### Core Files

| Component                  | Path                                | Size        | Purpose                                              |
| :------------------------- | :---------------------------------- | :---------- | :--------------------------------------------------- |
| **TablePage.tsx**          | `src/pages/TablePage.tsx`           | 4,478 lines | Monolithic table orchestrator (decomposed → 5 hooks) |
| **HeadlessTableEngine.ts** | `src/engine/HeadlessTableEngine.ts` | 59KB        | Server-authoritative game loop                       |
| **TournamentEngine.ts**    | `src/engine/TournamentEngine.ts`    | 66KB        | Full MTT/SNG lifecycle                               |
| **HandController.ts**      | `src/engine/HandController.ts`      | 29KB        | Hand-level game logic                                |
| **PokerEngine.ts**         | `src/engine/PokerEngine.ts`         | 25KB        | Deck, evaluation, pot calc                           |
| **HorseLogic.ts**          | `src/engine/HorseLogic.ts`          | 27KB        | Horse (bot) decision AI                              |

### Card Rendering (Custom PNG Deck)

**CRITICAL**: The custom 52-card PNG deck lives at `public/cards/` with 2-color and 4-color variants plus 8 card back designs at `public/cards/backs/`.

| Renderer               | Path                                        | Usage                                                               |
| :--------------------- | :------------------------------------------ | :------------------------------------------------------------------ |
| `CardImage.tsx`        | `src/components/table/CardImage.tsx`        | Primary card renderer — uses `/cards/{deckStyle}/{suit}_{rank}.png` |
| `PremiumCard.tsx`      | `src/components/table/PremiumCard.tsx`      | Premium renderer with 3D flip + shine effects                       |
| `CardBack`             | Exported from `CardImage.tsx`               | Card back renderer with theme selection                             |
| `CommunityCards.tsx`   | `src/components/table/CommunityCards.tsx`   | Board cards (uses `CardImage`)                                      |
| `SeatSlot.tsx`         | `src/components/table/SeatSlot.tsx`         | Hole cards at seats (uses `CardImage` + `CardBack`)                 |
| `CardReveal.tsx`       | `src/components/table/CardReveal.tsx`       | Showdown card flip (uses `CardImage` + `CardBack`)                  |
| `HandReplayPlayer.tsx` | `src/components/table/HandReplayPlayer.tsx` | Replay viewer (uses `CardImage`)                                    |

> **Rule**: ALL card rendering MUST use `CardImage` or `PremiumCard`. Never use Unicode suit symbols (♠♥♦♣) or CSS-generated cards. This was a past bug that was fixed.

### Sensory Layer

| Service               | Path                                      | Purpose                                   |
| :-------------------- | :---------------------------------------- | :---------------------------------------- |
| `SoundService.ts`     | `src/services/SoundService.ts`            | 14 procedural sounds via Web Audio API    |
| `PremiumSFX.ts`       | `src/services/PremiumSFX.ts`              | Premium sound effects layer               |
| `ChipAnimation.tsx`   | `src/components/table/ChipAnimation.tsx`  | Bezier-curve chip flights                 |
| `ConfettiCanvas.tsx`  | `src/components/table/ConfettiCanvas.tsx` | Winner celebration canvas                 |
| `ParticleSystem.tsx`  | `src/components/table/ParticleSystem.tsx` | Gold sparks, chip burst, confetti modes   |
| `SoundPackService.ts` | `src/services/SoundPackService.ts`        | Themed sound volumes (casino/minimal/etc) |
| `ScreenShake.ts`      | `src/utils/ScreenShake.ts`                | Screen shake utility (light/medium/heavy) |
| `ThrowAnimation.tsx`  | `src/components/table/ThrowAnimation.tsx` | Object throwables                         |

### Multiplayer & Sync

| Service                          | Path                                          | Purpose                    |
| :------------------------------- | :-------------------------------------------- | :------------------------- |
| `TableWebSocket.ts`              | `src/services/TableWebSocket.ts`              | Real-time game state sync  |
| `RoomService.ts`                 | `src/services/RoomService.ts`                 | WebSocket room management  |
| `RealtimeChannelService.ts`      | `src/services/RealtimeChannelService.ts`      | Supabase Realtime channels |
| `PresenceService.ts`             | `src/services/PresenceService.ts`             | Online/offline tracking    |
| `DisconnectProtectionService.ts` | `src/services/DisconnectProtectionService.ts` | Connection recovery        |

### Table Utilities (All ✅ Built)

ActionPanel, SitOutModal, WaitListModal, TimeBank, CashierModal, BuyInModal, StraddleToggle, RabbitHunt, InsuranceModal, RunItTwice, BombPotOverlay, ThrowableSelector, EmotePanel, PlayerNotesPanel, HandHistoryPanel, HandReplayPlayer, ShareHand, QuickChatPresets, SessionHUD, SessionSummary, AutoRebuyService, StreamerMode, TableTabBar, SettingsPanel, ThemeSelector

---

## Card Back Designs Available

| ID           | Name         | Type              | Path                            |
| :----------- | :----------- | :---------------- | :------------------------------ |
| black        | Black        | Default           | `/cards/backs/black.jpeg`       |
| red          | Red          | Default           | `/cards/backs/red.jpeg`         |
| blue         | Blue         | Default           | `/cards/backs/blue.jpeg`        |
| white        | White        | Default           | `/cards/backs/white.jpeg`       |
| classic      | Classic      | Premium (💎50)    | `/cards/backs/classic.jpg`      |
| burgundy     | Burgundy     | Premium (💎75)    | `/cards/backs/burgundy.jpg`     |
| navy         | Navy         | Premium (💎75)    | `/cards/backs/navy.jpg`         |
| gold         | Premium Gold | Premium (💎150)   | `/cards/backs/gold.jpg`         |
| holographic  | Holographic  | Exclusive (💎200) | `/cards/backs/holographic.jpg`  |
| carbon       | Carbon Fiber | Exclusive (💎175) | `/cards/backs/carbon.jpg`       |
| club-branded | Club Crest   | Exclusive (💎250) | `/cards/backs/club-branded.jpg` |
| diamond-foil | Diamond Foil | Exclusive (💎300) | `/cards/backs/diamond-foil.jpg` |

---

## Industry-Leading Overhaul — Status Tracker

### ✅ Phase 1: Custom Deck Integration — COMPLETE

- [x] `CardReveal.tsx` — replaced Unicode with CardImage+CardBack (3D flip preserved)
- [x] `HandReplayPlayer.tsx` — replaced text cards with CardImage (hole + board)
- [x] `CardBackSelector.tsx` — replaced text span with `<img>`, added 4 premium backs
- [x] Build verified: zero TypeScript errors

### ✅ Phase 2: Visual Polish — Animations & Effects — COMPLETE

- [x] Card deal arc trajectory — enhanced `cardDeal` CSS (slide from right with brightness flash)
- [x] 3D flip for turn/river — already existed (`cardTurnReveal` / `cardRiverReveal`)
- [x] Staggered flop dealing — already existed via `--card-index` \* 100ms
- [x] ParticleSystem.tsx — gold sparks, casino chips, confetti (3 modes)
- [x] ScreenShake.ts — light/medium/heavy with GPU translate3d
- [x] Chip stack sprites — already existed (`ChipStack.tsx` with denomination colors)
- [x] Chip drop animation — already existed (`chip-drop` keyframes)
- [x] Bonus: Fixed ShareHand.tsx board preview Unicode → CardImage

### ✅ Phase 3: Sensory & Immersion — COMPLETE

- [x] All-in drama mode — tension glow border, dimmed UI, super spotlight, 0.9s slow dealing
- [x] Sound pack selection — `SoundPackService.ts` (casino/minimal/tournament/silent)
- [x] Table felt fabric texture — SVG weave data URI
- [x] Rail leather stitching — inner dashed ring
- [x] Center watermark — 'S' logo at 1.8% opacity
- [x] Theme-configurable felt color — 6 themes via `data-felt-theme` CSS variable

### ✅ Phase 4: New Game Modes — COMPLETE

- [x] `SpinItEngine.ts` — 3-player lottery SNG (weighted prize wheel, hyper-turbo blinds)
- [x] `SpinItWheel.tsx` + CSS — animated radial prize wheel with CSS spin deceleration
- [x] `FlashPoolEngine.ts` — fast-fold player pool with instant reassignment
- [x] `FlashTransition.tsx` + CSS — table wipe (wipe/fade/blur)

### ✅ Phase 5: Feature Parity+ — COMPLETE

- [x] EV Cashout tab in InsuranceModal — two-tab modal (Insurance + EV Cashout)
- [x] Paid hand reveal (HandReveal.tsx) — show/muck + diamond-gated reveal
- [x] Smart HUD visual upgrade — color-coded VPIP/PFR tiers, flame icon
- [x] SessionAnalytics.tsx — PokerCraft-style 4-tab dashboard

### ✅ Phase 6: Architecture Polish & Customization — COMPLETE

- [x] TablePage.tsx decomposition — 5 custom hooks (`useTableGameState`, `useTableChat`, `useTableAnimations`, `useTableSidePanels`, `useTableTournament`)
- [x] Card Back Store — 12 backs (4 free + 4 premium + 4 exclusive), purchase modal, `DIAMOND_SPENT` bus
- [x] Avatar Gallery — 3-tab gallery (Free 25 / VIP 50 / Upload), photo upload, Supabase persistence

### ✅ Phase 7: Hook Wiring & Store Integration — COMPLETE

- [x] Wired `useTableChat`, `useTableTournament`, `useTableAnimations` into TablePage.tsx (−75 lines)
- [x] Integrated AvatarGallery + CardBackSelector into SettingsPanel (new Customization section)
- [x] Added `SETTINGS_CHANGED` listener in useTableSettings + `DIAMOND_SPENT` listener in MasterBus

### ✅ Phase 8: Table Experience Enhancements — COMPLETE

- [x] `QuickActionsBar.tsx` — 6-button glassmorphism pill bar (auto-rebuy, chat, hand-strength, stats, sound, settings)
- [x] `SpectatorOverlay.tsx` — Viewer count badge (pulse animation), expandable viewer list, follow-player indicator
- [x] `TableReactions.tsx` — 6 animated float-up emoji reactions (👏😂😱🔥💀🍀), 3s rate limit, room broadcast
- [x] `useTableKeyboard.ts` — Keyboard shortcuts (F/C/R/A actions, 1-4 bet presets, M/H/S toggles, Escape close)

### ✅ Phase 9: Premium Table Rendering & Performance — COMPLETE

- [x] `ChipPhysics.tsx` — 7-tier denomination chip sprites with splash/slide-in/collect animations
- [x] `PremiumPot.tsx` — Animated counting (rAF), 4-tier glow (normal→monster gold pulse), side pots
- [x] `TablePerfMonitor.tsx` — Dev-only FPS/frame-time/renders/heap overlay (`?perf=1` or `P` key)
- [x] `MiniTable.tsx` — Enhanced with hero hole cards, animated pot counter, stakes label, timer arc

---

## Competitive Benchmarks

| Feature           | Us  | PokerBros | ClubGG | WPT Global |
| :---------------- | :-: | :-------: | :----: | :--------: |
| Custom PNG Deck   | ✅  |    ✅     |   ✅   |     ✅     |
| OFC (Excluded)    | ❌  |    ❌     |   ❌   |     ❌     |
| Horse AI Bots     | ✅  |    ❌     |   ❌   |     ❌     |
| GTO Advisor       | ✅  |    ❌     |   ❌   |     ❌     |
| Player Style Tags | ✅  |    ❌     |   ❌   |     ❌     |
| Equity Display    | ✅  |    ❌     |   ❌   |     ❌     |
| Spin-It           | ✅  |    ✅     |   ❌   |     ❌     |
| Flash/Fast-Fold   | ✅  |    ❌     |   ❌   |     ✅     |
| EV Cashout        | ✅  |    ❌     |   ✅   |     ❌     |

---

## Rules & Standards

1. **Custom deck ONLY** — never render cards with CSS text or Unicode symbols
2. **Haptic feedback** — use `haptic.light()/medium()/strong()` from SoundService for all user interactions
3. **Card type** — always use `Card` interface from `CardImage.tsx` (`rank: '2'-'A'`, `suit: 'h'|'d'|'c'|'s'`)
4. **4-color default** — use `deckStyle="4color"` unless user setting overrides
5. **Performance** — `TablePage.tsx` has 5 extracted hooks; prefer using these modular hooks over adding inline logic
6. **Extracted hooks** — `useTableGameState`, `useTableChat`, `useTableAnimations`, `useTableSidePanels`, `useTableTournament` live in `src/hooks/`
7. **Animations** — use `requestAnimationFrame` for smooth motion; CSS transitions for simple state changes
8. **Sound** — coordinate SoundService playback with animation timing (e.g., `playDeal()` syncs with card arc arrival)
