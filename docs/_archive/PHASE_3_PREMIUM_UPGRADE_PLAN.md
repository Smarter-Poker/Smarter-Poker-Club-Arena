# Club Arena — Phase 3: Complete Premium Upgrade Plan

**Date:** March 10, 2026
**Goal:** Transform Club Arena from a functional poker table into a world-class mobile poker experience that surpasses PokerBros, ClubGG, and WPT Global in every dimension.

---

## EXECUTIVE SUMMARY

After deep research into the three leading poker apps (PokerBros, ClubGG, WPT Global) and a full audit of our codebase, this document outlines every remaining upgrade needed. Phases 1-2 fixed the core layout (seats, action buttons, header, community cards, pre-action bar). Phase 3 covers the "feel" layer: multi-table system, sound design, animations, visual polish, and micro-interactions that make the difference between "functional" and "premium."

---

## PART 1: COMPETITIVE INTELLIGENCE SUMMARY

### What PokerBros Does Best

- **3D cartoon avatars** with themed packs (Halloween, etc.) — gold sparkle effects around avatars
- **Neon yellow timer border** that depletes around the active player's info box
- **Portrait-locked mobile design** with one-handed operation
- **Tab-based multi-table** (up to 4) with swipe navigation and action notifications
- **Animation control** — players can accelerate/disable effects for speed
- **Diamond/VIP economy** — rabbit hunt, time banks, premium themes tied to in-app currency
- **Voice chat** + quick poker phrases + emojis in chat
- **6 table themes** with customizable felt, deck, background, and buttons

### What ClubGG Does Best

- **GGPoker mobile DNA** — battle-tested interface used by millions
- **NFT avatar support** alongside standard avatars
- **Smooth bet slider** with AI-assisted sizing
- **BB display toggle** for chip stacks throughout the UI
- **Crisp hand history** with inline replay
- **Splash pot / Boom pot** special animations
- **Subscription-tier** unlocks (Standard $9.99/mo, Platinum $49.99/mo)

### What WPT Global Does Best

- **Card squeeze feature** — interactive card reveal at showdown/all-in
- **Hand replayer on every table** — watch previous hands inline
- **Chunky touch-optimized buttons** — 48px+ touch targets
- **4-color deck** option for suit distinction
- **Desktop + mobile parity** with cross-platform consistency
- **Hotkey support** — keyboard shortcuts for actions

### Industry Best Practices (2024-2026)

- **44-48px minimum touch targets** for mobile buttons
- **130-140ms card flip animations** for satisfying feel
- **Haptic feedback** increases session length by 11%
- **Adaptive layouts** increase user satisfaction by 29%
- **Clutter reduction** — overloaded screens cause 44%+ abandonment
- **Pre-rendered animations** reduce frame drops by 26%
- **One-handed operation** — 63% of mobile poker sessions are one-handed

---

## PART 2: WHAT WE HAVE vs WHAT WE NEED

### Already Done (Phases 1-2)

| Feature                                           | Status |
| ------------------------------------------------- | ------ |
| Circular avatars with custom avatar library       | DONE   |
| Dark info boxes with name + stack                 | DONE   |
| Neon yellow conic-gradient timer border           | DONE   |
| 3-button action panel (Fold/Check-Call/Raise)     | DONE   |
| Raise mode with slider + presets                  | DONE   |
| Proper header bar with back + info + menu         | DONE   |
| Community cards sized up (64×92px)                | DONE   |
| Winning hand highlighting (gold glow)             | DONE   |
| Hand name display (seat + community cards)        | DONE   |
| Pre-action bar (pill toggles with checkmarks)     | DONE   |
| Control strip (straddle, time bank, rabbit, chat) | DONE   |
| Clean spectator mode                              | DONE   |
| Empty seat "+" indicators                         | DONE   |
| Hero cards fanned PokerBros-style                 | DONE   |

### Still Missing (Phase 3 Scope)

| Feature                                | Priority      | Effort |
| -------------------------------------- | ------------- | ------ |
| **Multi-table tab bar with swipe**     | P0 — CRITICAL | HIGH   |
| **Sound effects full suite**           | P0 — CRITICAL | MEDIUM |
| **Chip-to-pot animation**              | P1 — HIGH     | MEDIUM |
| **Pot-to-winner animation**            | P1 — HIGH     | MEDIUM |
| **Card dealing stagger animation**     | P1 — HIGH     | LOW    |
| **Fold card fly-to-muck animation**    | P1 — HIGH     | LOW    |
| **Showdown card squeeze/reveal**       | P1 — HIGH     | MEDIUM |
| **All-in dramatic mode**               | P1 — HIGH     | MEDIUM |
| **Confetti/celebration on big wins**   | P2 — MEDIUM   | LOW    |
| **Timer warning tick-tock sound**      | P2 — MEDIUM   | LOW    |
| **Haptic feedback (mobile vibration)** | P2 — MEDIUM   | LOW    |
| **Table theme system**                 | P3 — LOW      | HIGH   |
| **Card deck customization**            | P3 — LOW      | MEDIUM |
| **Voice chat integration**             | P3 — LOW      | HIGH   |
| **Card squeeze interaction**           | P3 — LOW      | HIGH   |

---

## PART 3: THE BUILD PLAN

### 3.1 — MULTI-TABLE TAB SYSTEM (P0)

**What:** PokerBros-style top tab bar allowing up to 4 concurrent tables with tab switching and horizontal swipe navigation.

**Reference (from screenshot):**

```
┌──────────────────────────────────────────┐
│ [PLO4 Hi] [PLO4 Hi] [+] [+]  🏆 JACKPOT│
│  active    inactive  add add   72,159    │
└──────────────────────────────────────────┘
```

**Architecture:**

- New wrapper page: `MultiTablePage.tsx` — orchestrates multiple `TablePage` instances
- New component: `TableTabBar.tsx` — horizontal tab strip at top
- Each tab = one table connection (WebSocket, state, etc.)
- Swipe gesture: CSS `scroll-snap` + touch events for horizontal scrolling between tables
- Maximum 4 tables enforced
- "+" button opens lobby/table selector modal
- Active tab has bright background; inactive tabs are dimmer
- Pulsing indicator on tabs where it's your turn
- Timer countdown shown on tab when action is on you at another table
- Auto-switch to table when timer < 5s (already in useMultiTable hook)

**Files to Create:**

- `src/pages/MultiTablePage.tsx` — Main wrapper
- `src/pages/MultiTablePage.css` — Styles
- `src/components/table/TableTabBar.tsx` — Tab strip component
- `src/components/table/TableTabBar.css` — Tab strip styles

**Files to Modify:**

- `src/pages/TablePage.tsx` — Accept `tableId` prop, remove own routing
- `src/App.tsx` — Route `/table/:tableId` through MultiTablePage
- `src/components/multitable/MultiTableManager.tsx` — Enhance existing hook

**Swipe Implementation:**

```
Container: overflow-x hidden, display flex
Each table: width 100vw, flex-shrink 0
CSS: scroll-snap-type: x mandatory
     scroll-snap-align: start
Touch: onTouchStart/Move/End for swipe detection
Threshold: 50px horizontal swipe to switch
Animation: transform translateX with 300ms ease-out transition
```

**Tab Bar Design:**

- Height: 48px
- Background: rgba(10, 12, 18, 0.95) with blur(12px)
- Each tab: pill shape, 120px wide, rounded-full
- Active tab: solid background (e.g., #2563EB blue or table theme color)
- Inactive tab: semi-transparent (rgba(255,255,255,0.08))
- "+" tab: dashed border, muted icon
- Turn indicator: pulsing green dot + optional timer text
- Jackpot: inline badge on right side of tab bar

---

### 3.2 — SOUND EFFECTS FULL SUITE (P0)

**Current State:** SoundService uses procedural Web Audio API synthesis (oscillators). Works but sounds robotic/artificial.

**Upgrade Path:** Keep procedural synthesis as fallback but add MP3/OGG samples for richer audio.

**Sound Inventory:**

| Event                     | Method             | Sound Description                       | Duration  |
| ------------------------- | ------------------ | --------------------------------------- | --------- |
| `playDeal()`              | Existing + enhance | Card slide/flip — soft paper sound      | 0.15s     |
| `playCheck()`             | Existing           | Double table tap                        | 0.1s      |
| `playChips()`             | Existing           | Chip clink for bet/call                 | 0.2s      |
| `playFold()`              | Existing           | Card swoosh to muck                     | 0.2s      |
| `playAllIn()`             | NEW                | Dramatic chip push + bass thud          | 0.5s      |
| `playWin()`               | Existing           | Major arpeggio (C major)                | 0.5s      |
| `playTurnAlert()`         | Existing           | Bell/ding — your turn                   | 0.3s      |
| `playTimerWarning()`      | NEW                | Tick-tock pulse, loops at <5s           | 0.3s loop |
| `playCommunityCard()`     | NEW                | Card snap/flip for board cards          | 0.15s     |
| `playShowdown()`          | NEW                | Dramatic reveal — string swell          | 0.4s      |
| `playButtonClick()`       | NEW                | Soft UI tap for any button              | 0.08s     |
| `playRaise()`             | NEW                | Larger chip stack sound                 | 0.3s      |
| `playTimeBankActivated()` | NEW                | Hourglass chime                         | 0.3s      |
| `playBigWin()`            | NEW                | Extended celebration + confetti trigger | 1.0s      |

**Implementation Plan:**

1. Create `public/sounds/` directory
2. Generate procedural sounds as MP3 using Web Audio API offline rendering
3. Add `AudioSpriteManager` class for loading/caching/playing
4. Add volume control (master, effects, voice) in settings
5. Add `navigator.vibrate()` calls for mobile haptic feedback
6. Connect to all game events in TablePage.tsx

**SoundService Enhancement:**

```typescript
// New methods to add to SoundService:
playAllIn()        — Deep bass hit + chip cascade
playTimerWarning() — Tick at 440Hz, 0.05s on/0.25s off
playCommunityCard() — Quick snap (white noise + high filter)
playShowdown()      — Rising tone sequence (C4→E4→G4→C5, 80ms each)
playButtonClick()   — Quick 1500Hz blip, 0.05s
playRaise()         — Triple chip clink (3× stagger at 20ms)
playTimeBankActivated() — Two-tone bell (G5→C6)
playBigWin()        — Extended arpeggio + shimmer noise
```

---

### 3.3 — CHIP ANIMATIONS (P1)

**3.3a — Chip-to-Pot Animation**
When a player bets/calls/raises, animate chip tokens flying from their seat to the pot center.

**Implementation:**

- Detect bet action → get seat position (x,y) + pot position (center)
- Create 2-4 small chip circles (colored by amount: white<5, red<25, green<100, black<500, purple<1k)
- Animate along bezier curve from seat → pot over 400ms
- Use CSS `@keyframes` with `offset-path` or JavaScript `requestAnimationFrame`
- Stagger chips by 50ms for cascade effect
- On arrival: brief scale pulse (1.0→1.15→1.0) on pot display

**Files to Modify:**

- `src/components/table/ChipAnimation.tsx` — Enhance existing
- `src/pages/TablePage.tsx` — Trigger on bet actions
- `src/pages/TablePage.css` — Animation keyframes

**3.3b — Pot-to-Winner Animation**
When a player wins, animate chips flying from pot center to winner's seat.

**Implementation:**

- On WINNERS event → get pot position + winner seat position
- Create chip shower (6-8 chips) flying from center to winner
- Bezier curve with slight arc (upward then toward seat)
- Duration: 600ms
- On arrival: winner seat does golden pulse + stack number updates
- If multiple winners (split pot): animate to each simultaneously

**3.3c — Fold Card Animation**
When a player folds, their cards fly toward the center muck area and fade out.

**Implementation:**

- Get card element positions
- Animate: translateX toward center, translateY up slightly, rotate ±15°, opacity 1→0
- Duration: 300ms
- Remove cards from DOM after animation

---

### 3.4 — CARD DEALING STAGGER ANIMATION (P1)

**Current:** All cards appear at once or flip simultaneously.
**Target:** Sequential deal — one card per player, staggered by 80-120ms.

**Implementation:**

- On DEAL_CARDS event, don't show all cards immediately
- Queue: Card 1 to seat 1 → 100ms → Card 1 to seat 2 → 100ms → ... → Card 2 to seat 1 → etc.
- Each card: fly from dealer position (near center) to player seat
- Animation: scale 0→1, translate from center to seat, opacity 0→1
- Duration per card: 200ms
- Total deal time for 6 players: ~1.2s (2 cards × 6 players × 100ms)

**For community cards (flop/turn/river):**

- Flop: 3 cards appear sequentially (100ms apart) from center-left to center
- Turn: Single card slides in from right
- River: Single card slides in from right
- Each with a subtle paper-slide sound

---

### 3.5 — SHOWDOWN REVEAL (P1)

**Current:** Opponent cards just appear.
**Target:** Sequential dramatic reveal at showdown.

**Implementation:**

- On SHOWDOWN event, reveal cards one player at a time
- Each player's cards: 3D flip animation (rotateY 180° over 300ms)
- Stagger between players: 500ms
- Best hand (winner): Highlighted with gold glow after all reveals
- Optional: Card squeeze for hero's cards (touch and drag to slowly reveal)

---

### 3.6 — ALL-IN DRAMATIC MODE (P1)

**Current:** All-in is just another action.
**Target:** Premium dramatic all-in experience.

**When multiple players are all-in:**

1. Screen dims slightly (vignette overlay, 15% opacity dark)
2. Community cards deal one-at-a-time with extended timing (400ms between)
3. Equity percentages shown for each all-in player (requires equity calculation)
4. Cards glow/pulse as equity changes with each board card
5. Winner reveal: Bright flash + confetti + chip shower
6. Sound: Dramatic tension sound during board runout, celebration on win

**Implementation:**

- New state: `isAllInRunout: boolean` in TablePage
- When detected: apply `table--allin-mode` class
- CSS: Vignette overlay, card glow animation
- Equity display: Small percentage badge above each all-in player's cards
- Board dealing: Slower timing (override normal deal speed)

---

### 3.7 — CELEBRATION & CONFETTI (P2)

**Current:** Winner gets gold glow on seat.
**Target:** Full celebration for significant wins.

**Tiers:**
| Win Size | Effect |
|----------|--------|
| < 10 BB | Gold glow only (current) |
| 10-50 BB | Gold glow + chip shower animation |
| 50-100 BB | Above + small confetti burst |
| > 100 BB | Above + full confetti + screen shake + celebration sound |

**Confetti Implementation:**

- Canvas-based particle system (lightweight, GPU-accelerated)
- 30-50 particles, 8 colors (gold, silver, red, blue, green, white, pink, purple)
- Gravity simulation: particles fall with slight randomized horizontal drift
- Duration: 2.5s
- Triggered after pot-to-winner animation completes

---

### 3.8 — HAPTIC FEEDBACK (P2)

**Mobile vibration patterns for key events:**

| Event      | Pattern                             | Intensity |
| ---------- | ----------------------------------- | --------- |
| Your turn  | Single pulse (50ms)                 | Medium    |
| Timer < 5s | Double pulse (30ms, 30ms gap, 30ms) | Strong    |
| Win pot    | Triple pulse (40ms, 40ms, 40ms)     | Medium    |
| All-in     | Long pulse (100ms)                  | Strong    |
| Button tap | Micro pulse (10ms)                  | Light     |

**Implementation:**

```typescript
// Add to SoundService or new HapticService
function vibrate(pattern: number | number[]) {
  if ('vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
}
```

---

### 3.9 — TABLE THEMES (P3 — Future)

**Planned themes (matching PokerBros 6-theme system):**

| Theme          | Felt Color | Rail   | Background           |
| -------------- | ---------- | ------ | -------------------- |
| Classic Green  | #0D2820    | Gold   | Navy diamond pattern |
| Dark Blue      | #0A1628    | Silver | Deep blue gradient   |
| Royal Purple   | #1A0A2E    | Gold   | Purple damask        |
| Midnight Black | #0A0A0A    | Chrome | Carbon fiber texture |
| Casino Red     | #2A0A0A    | Gold   | Red velvet           |
| Ocean Blue     | #0A1E3A    | White  | Teal gradient        |

**Implementation:**

- CSS custom properties per theme
- Theme selector in settings panel
- Saved to localStorage + user profile
- Smooth theme transition (300ms cross-fade)

---

## PART 4: MULTI-TABLE SYSTEM DETAILED SPEC

### Architecture

```
┌─ MultiTablePage.tsx ──────────────────────────────────┐
│                                                        │
│  ┌─ TableTabBar.tsx ──────────────────────────────┐   │
│  │ [Table 1] [Table 2] [+] [+]   🏆 JACKPOT      │   │
│  └────────────────────────────────────────────────┘   │
│                                                        │
│  ┌─ Swipe Container (CSS scroll-snap) ────────────┐   │
│  │                                                  │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │   │
│  │  │ TablePage│ │ TablePage│ │ TablePage│        │   │
│  │  │  (id: 1) │ │  (id: 2) │ │  (id: 3) │        │   │
│  │  └──────────┘ └──────────┘ └──────────┘        │   │
│  │  ←──── swipe ────→                              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Tab Bar Behavior

1. **Tab appearance:** Each tab shows table name (e.g., "PLO4 Hi" or "NLH 1/2")
2. **Active tab:** Bright solid background, white text
3. **Inactive tab:** Transparent background with border, muted text
4. **Turn indicator:** Green pulsing dot on tabs where action is on you
5. **Timer on tab:** When action is on you at an inactive table, show countdown "8s"
6. **Close tab:** Small × button on hover/long-press (not on active table if only 1)
7. **Add tab:** "+" button opens lobby modal to select a new table
8. **Max 4 tabs:** After 4, "+" buttons disappear

### Swipe Navigation

1. **Gesture:** Horizontal swipe left/right to switch tables
2. **Threshold:** 50px horizontal movement triggers switch
3. **Animation:** 300ms ease-out translateX transition
4. **Snap:** Each table view is exactly 100vw, snaps to position
5. **Indicator:** Tab bar highlights update in sync with swipe position
6. **Keyboard:** Left/Right arrow keys also switch tables (desktop)

### State Management

```typescript
interface MultiTableState {
  tables: TableInstance[]; // Up to 4
  activeIndex: number; // 0-3
  swipeOffset: number; // For animation
}

interface TableInstance {
  id: string; // Table UUID
  name: string; // "NLH 1/2"
  stakes: string; // "1/2"
  isMyTurn: boolean;
  timeRemaining?: number;
  pot: number;
  heroStack: number;
  // Each instance has its own WebSocket connection
  // Each instance has its own TablePage state
}
```

### Auto-Switch Logic

- When `isMyTurn` becomes true on a non-active table: Show pulsing indicator on tab
- When `timeRemaining < 5` on a non-active table: Auto-switch to that table
- User preference: Can disable auto-switch in settings
- Sound: Play turn alert sound when action comes to you on any table

---

## PART 5: IMPLEMENTATION ORDER

### Sprint 1: Multi-Table Tab System (This Build)

1. Create `TableTabBar.tsx` + CSS
2. Create `MultiTablePage.tsx` wrapper
3. Implement swipe container with CSS scroll-snap
4. Wire up tab selection, add/remove, turn indicators
5. Update routing to use MultiTablePage
6. Test with 1-4 concurrent tables

### Sprint 2: Sound Effects

7. Enhance SoundService with all new methods
8. Add haptic feedback service
9. Wire all sounds to game events in TablePage
10. Add volume controls to settings

### Sprint 3: Chip Animations

11. Chip-to-pot animation (bet/call/raise)
12. Pot-to-winner animation
13. Fold card fly-to-muck
14. Confetti particle system for big wins

### Sprint 4: Card Animations

15. Deal stagger animation (sequential card delivery)
16. Community card sequential reveal
17. Showdown 3D flip reveal (one player at a time)
18. All-in dramatic mode (vignette + slow board + equity)

### Sprint 5: Polish & Testing

19. Haptic feedback on all events
20. Animation speed controls (fast/normal/slow in settings)
21. Full E2E testing on mobile viewport
22. Performance profiling (60fps target)
23. Cross-browser testing (Chrome, Safari, Firefox)

---

## PART 6: FILE CHANGE MAP

### New Files

| File                                      | Purpose                        |
| ----------------------------------------- | ------------------------------ |
| `src/pages/MultiTablePage.tsx`            | Multi-table wrapper with swipe |
| `src/pages/MultiTablePage.css`            | Multi-table layout styles      |
| `src/components/table/TableTabBar.tsx`    | Tab strip with indicators      |
| `src/components/table/TableTabBar.css`    | Tab strip styles               |
| `src/services/HapticService.ts`           | Mobile vibration wrapper       |
| `src/components/table/ConfettiCanvas.tsx` | Canvas particle confetti       |

### Modified Files

| File                                      | Changes                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `src/services/SoundService.ts`            | Add 8 new sound methods                               |
| `src/pages/TablePage.tsx`                 | Accept tableId prop, sound wiring, animation triggers |
| `src/pages/TablePage.css`                 | All-in mode, chip animation paths                     |
| `src/components/table/ChipAnimation.tsx`  | Enhance with bezier paths                             |
| `src/components/table/SeatSlot.tsx`       | Fold animation, deal stagger                          |
| `src/components/table/SeatSlot.css`       | Fold fly-out, deal-in keyframes                       |
| `src/components/table/CommunityCards.tsx` | Sequential reveal timing                              |
| `src/components/table/CommunityCards.css` | Slide-in per card                                     |
| `src/App.tsx`                             | Route through MultiTablePage                          |

---

## PART 7: DESIGN TOKENS UPDATE

```css
/* Add to existing tokens */

/* Multi-Table */
--tab-height: 48px;
--tab-bg-active: #2563eb;
--tab-bg-inactive: rgba(255, 255, 255, 0.08);
--tab-indicator-turn: #22c55e;
--tab-indicator-urgent: #ef4444;

/* Animations */
--chip-fly-duration: 400ms;
--pot-collect-duration: 600ms;
--card-deal-stagger: 100ms;
--card-flip-duration: 300ms;
--confetti-duration: 2500ms;
--fold-fly-duration: 300ms;
--allin-vignette-opacity: 0.15;

/* Sound */
--sound-master-volume: 0.7;
--sound-effects-volume: 0.5;
--sound-voice-volume: 0.8;

/* Haptic */
--haptic-light: 10ms;
--haptic-medium: 50ms;
--haptic-strong: 100ms;
```

---

## PART 8: SUCCESS METRICS

After Phase 3 implementation, the table should:

1. **Feel premium** — Every action has audio + visual + haptic feedback
2. **Match PokerBros** — Tab system, avatars, timer, animations are comparable
3. **Exceed ClubGG** — Our action panel, pre-action bar, and seat display are already cleaner
4. **Rival WPT** — Cross-platform consistency with touch-optimized controls
5. **60fps animations** — No frame drops during chip fly or confetti
6. **< 100ms response** — Button taps register instantly with sound feedback
7. **Multi-table fluid** — Swipe between 4 tables with zero lag
8. **Mobile-first** — Every interaction works with one thumb

---

_This is the complete Phase 3 blueprint. Building starts with the multi-table tab system._
