# ♠ CLUB ARENA — UI DESIGN REFERENCE

## PokerBros Clone + Better | Facebook Color Scheme

> **Created**: 2026-01-12 | **Status**: ACTIVE DESIGN GUIDE  
> **Reference Source**: PokerBros App Screenshots (9 images)  
> **Color Scheme**: Facebook-inspired (Primary Blue #1877F2)

---

## 🎨 COLOR PALETTE (Facebook-Inspired)

### Primary Colors

```css
/* FACEBOOK BLUE SPECTRUM */
--fb-primary: #1877f2; /* Facebook Blue - Main Actions */
--fb-primary-hover: #166fe5; /* Hover State */
--fb-primary-dark: #1565c0; /* Pressed/Active */
--fb-primary-light: #4599ff; /* Highlights */

/* ACCENT GOLD (Chips/Currency) */
--fb-gold: #ffb800; /* Chip amounts, Premium */
--fb-gold-light: #ffd54f; /* Gold highlights */
--fb-gold-dark: #f9a825; /* Gold shadows */
```

### Background Layers

```css
/* DARK UI BACKGROUNDS */
--bg-deepest: #0a0a0f; /* App background */
--bg-deep: #0d1117; /* Table area base */
--bg-surface: #161b22; /* Cards, panels */
--bg-elevated: #1c2128; /* Modals, dropdowns */
--bg-hover: #21262d; /* Hover states */

/* TABLE FELT */
--felt-primary: #0d4f3c; /* Deep felt green */
--felt-gradient: linear-gradient(135deg, #0d4f3c 0%, #0a3d2e 100%);
--table-rail: #1a1a2e; /* Premium dark rail */
--table-rail-glow: rgba(24, 119, 242, 0.15); /* Blue glow edge */
```

### Text Colors

```css
/* TEXT HIERARCHY */
--text-primary: #ffffff; /* Main content */
--text-secondary: #8b949e; /* Labels, hints */
--text-tertiary: #6e7681; /* Disabled, muted */
--text-gold: #ffb800; /* Currency amounts */
--text-success: #3fb950; /* Positive (winnings) */
--text-danger: #f85149; /* Negative (losses), Alerts */
--text-warning: #f0883e; /* Warnings */
```

### Semantic Colors

```css
/* STATUS INDICATORS */
--status-online: #3fb950; /* Active/Online */
--status-away: #f0883e; /* Away */
--status-offline: #6e7681; /* Offline */
--status-in-hand: #58a6ff; /* In current hand */

/* ACTION BUTTONS */
--btn-fold: #6e7681; /* Fold - Gray */
--btn-check: #1877f2; /* Check - Blue */
--btn-call: #1877f2; /* Call - Blue */
--btn-bet: #ffb800; /* Bet - Gold */
--btn-raise: #ffb800; /* Raise - Gold */
--btn-allin: #f85149; /* All-In - Red */
```

### Chip Colors

```css
/* CHIP DENOMINATIONS */
--chip-white: #f5f5f5; /* $1 */
--chip-red: #dc143c; /* $5 */
--chip-blue: #1877f2; /* $10 */
--chip-green: #228b22; /* $25 */
--chip-black: #1c1c1c; /* $100 */
--chip-purple: #9b59b6; /* $500 */
--chip-yellow: #ffb800; /* $1000 */
```

---

## 📐 LAYOUT STRUCTURE

### Table View Layout (from screenshots)

```
┌─────────────────────────────────────────────────────────────┐
│ HEADER BAR                                                  │
│ ┌─────┐  ┌─────────────────────────────┐  ┌───┐ ┌───┐ ┌───┐│
│ │ ≡   │  │ JACKPOT 000,139,381 💎      │  │ ? │ │ 📋│ │ ID││
│ └─────┘  └─────────────────────────────┘  └───┘ └───┘ └───┘│
├─────────────────────────────────────────────────────────────┤
│ ┌─────┐                                                     │
│ │  +  │  SEAT RING (Oval Layout)                           │
│ └─────┘                                                     │
│           ┌───┐              ┌───┐                          │
│          [S1]                [S2]                           │
│      ┌───┐                        ┌───┐                     │
│     [S6]    ┌──────────────────┐   [S3]                    │
│             │        POT       │                            │
│      ┌───┐  │        35        │   ┌───┐                    │
│     [S5]    │   COMMUNITY      │   [S4]                    │
│             │     CARDS        │                            │
│             └──────────────────┘                            │
│                  ┌─────────┐                                │
│                  │ GAME    │                                │
│                  │  INFO   │                                │
│                  │ NLH     │                                │
│                  │ 5/10    │                                │
│                  └─────────┘                                │
│                                                             │
│                     [HERO SEAT]                             │
│                  ┌─────────────┐                            │
│                  │  HOLE CARDS │                            │
│                  │   🂡  🂱     │                            │
│                  └─────────────┘                            │
├─────────────────────────────────────────────────────────────┤
│ ACTION BAR                                                  │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│ │   FOLD   │  │  CHECK   │  │  RAISE   │                   │
│ └──────────┘  └──────────┘  └──────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🪑 SEAT COMPONENT (from Image 3 & 4)

### Seat States

```
EMPTY SEAT:
┌────────────┐
│     +      │  ← Tap to sit
└────────────┘

OCCUPIED SEAT (Active Player):
┌───────────────────┐
│   [Avatar]        │
│   username        │
│   💰 4,642.84     │  ← Gold text for stack
│   ┌────┐ ┌────┐   │
│   │ D  │ │ 10 │   │  ← Position badge + Current bet
│   └────┘ └────┘   │
└───────────────────┘

HERO SEAT (Bottom Center):
- Larger card display
- Hole cards visible
- Highlighted border (blue glow)
- Action timer visible when active

FOLDED SEAT:
- Dimmed/Grayed out (60% opacity)
- "FOLD" overlay text (optional)
- Cards hidden
```

### Position Badges (from screenshots)

```css
/* Dealer Button */
.badge-dealer {
  background: #ffffff;
  color: #0a0a0f;
  font-weight: 800;
  content: 'D';
}

/* Small Blind */
.badge-sb {
  background: #1877f2;
  color: #ffffff;
  font-weight: 700;
  content: 'SB';
}

/* Big Blind */
.badge-bb {
  background: #ffb800;
  color: #0a0a0f;
  font-weight: 700;
  content: 'BB';
}

/* New Player */
.badge-new {
  background: linear-gradient(135deg, #3fb950, #2ea043);
  color: #ffffff;
  font-size: 0.625rem;
  content: 'New';
}
```

### Avatar Display

- Circular frame with gold/blue border based on status
- 40-48px on desktop, 32-36px on mobile
- Default: First letter of username if no image
- Accessories/hats render as overlays

---

## 🃏 CARD DISPLAY (from Image 3 & 4)

### Hole Cards (Hero)

```css
.hole-card {
  width: 52px;
  height: 72px;
  border-radius: 6px;
  background: linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  transform: rotate(-5deg); /* Left card */
  /* transform: rotate(5deg); */ /* Right card */
}

/* Card overlap for hero display */
.hole-cards-container {
  display: flex;
  gap: -12px; /* Cards overlap */
}
```

### Card Face Layout (from Hand Detail screenshot)

```
┌──────────┐
│ A        │  ← Rank (top-left)
│ ♠        │  ← Suit (below rank)
│          │
│    ♠     │  ← Large center suit
│          │
│        ♠ │
│        A │  ← Inverted bottom-right
└──────────┘

COLORS:
- Hearts ♥ / Diamonds ♦: #DC143C (Red)
- Spades ♠ / Clubs ♣: #1C1C1C (Black)
```

### Community Cards (Center Table)

```css
.community-cards {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.community-card {
  width: 44px;
  height: 62px;
  border-radius: 4px;
  /* Flop cards animate in together */
  /* Turn/River animate individually */
}
```

---

## 💰 POT DISPLAY (from Image 3)

### Main Pot Component

```css
.pot-display {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);

  background: rgba(0, 0, 0, 0.7);
  padding: 6px 16px;
  border-radius: 16px;
  border: 1px solid rgba(255, 184, 0, 0.3);
}

.pot-label {
  font-size: 0.625rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.pot-amount {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--fb-gold);
  font-family: 'JetBrains Mono', monospace;
}
```

### Side Pot Layout

```
┌─────────────────┐
│ POT  35         │  ← Main pot
├─────────────────┤
│ Side 1: 120     │  ← Side pots below
│ Side 2: 85      │
└─────────────────┘
```

---

## 🎮 ACTION PANEL (from Image 3 & 5)

### Button Layout

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│  │   FOLD   │    │  CHECK   │    │  RAISE   │             │
│  │          │    │          │    │          │             │
│  └──────────┘    └──────────┘    └──────────┘             │
│                                                            │
└────────────────────────────────────────────────────────────┘

BUTTON STYLES:
- FOLD: Gray background (#6E7681)
- CHECK/CALL: Blue background (#1877F2)
- BET/RAISE: Gold background (#FFB800), dark text
- ALL-IN: Red background with pulse animation
```

### Raise Amount Selector (from Image 5)

```
┌────────────────────────────────────────────────────────────┐
│                        10                                  │
│                  ┌────────────┐                            │
│           ┌───┐  │    10      │  ┌───┐                    │
│           │ - │  │            │  │ + │                    │
│           └───┘  └────────────┘  └───┘                    │
│                                                            │
│    ┌────┐   ┌────┐   ┌────┐   ┌─────────┐                 │
│    │ 2X │   │ 3X │   │ 4X │   │ Confirm │                 │
│    └────┘   └────┘   └────┘   └─────────┘                 │
│                                                            │
└────────────────────────────────────────────────────────────┘

- Quick multiplier buttons (2X, 3X, 4X pot)
- +/- increment buttons (configurable step)
- Slider for fine control
- Confirm button (gold, prominent)
```

---

## 📊 BUY-IN MODAL (from Image 2 - Batch 2)

### Structure

```
┌────────────────────────────────────────┐
│                          ✕             │  ← Close button
│  59* (Close)                           │  ← Countdown (optional)
│  BUY-IN                                │  ← Title
│                                        │
│  ┌────────────────────────────────┐    │
│  │   12    ←───────→      25     │    │  ← Min/Max labels
│  │          [ 12 ]                │    │  ← Current value
│  │           💰                   │    │  ← Slider handle (chip icon)
│  └────────────────────────────────┘    │
│                                        │
│  ( Account Balance: 25.00 )            │  ← Balance display
│                                        │
│  ☐ Auto Rebuy                         │  ← Toggle option
│  When your stack drops to 0% of the    │
│  initial buy-in, it will be auto       │
│  replenished.                          │
│                                        │
│  ┌────────────────────────────────┐    │
│  │          Buy Chips             │    │  ← Primary action (gold)
│  └────────────────────────────────┘    │
│                                        │
└────────────────────────────────────────┘
```

### Slider Component

```css
.buy-in-slider {
  -webkit-appearance: none;
  width: 100%;
  height: 8px;
  background: linear-gradient(
    to right,
    var(--fb-primary) 0%,
    var(--fb-primary) var(--value-percent),
    var(--bg-surface) var(--value-percent),
    var(--bg-surface) 100%
  );
  border-radius: 4px;
}

.buy-in-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 32px;
  height: 32px;
  background: url('chip-icon.svg');
  background-size: contain;
  cursor: grab;
}
```

---

## 🏆 TOURNAMENT DETAILS (from Image 0 & 1 - Batch 2)

### Game Details Panel

```
┌────────────────────────────────────────────────────────────┐
│  ≪                    Game Details                         │
├────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────┐ │
│ │  Detail │ Entries │ Ranking │ Unions │ Tables │ Rewards│ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│  15K GTD✦ WEEKNIGHT✦+ 65 (11)                     🏆      │
│                                     ID:43522103            │
│                                                            │
│  15K GTD NLH WEEKNIGHT                                     │
│  65 BUY-IN                                                 │
│  RERUY / NO ADD-ON                                         │
│                                                            │
│        ┌───────────────────────────┐                       │
│        │      04:02:16             │   ← Large countdown   │
│        │    2026-01-12 19:00:00    │   ← Start time        │
│        └───────────────────────────┘                       │
│                                                            │
│   Blinds Up    Late Registration    Current Level          │
│     10:00          Level 15              0                 │
│                                                            │
│  Remaining Players    Avg Stack      Early Bird            │
│       13/13             48K        LVL 2/+20% chip         │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Game Type:    NLH(9 max)                                  │
│  Buy-in:       65(58.50 + 6.50) [Re-entry]                │
│  Prize Pool:   15K 💎 [OVERLAY]                            │
│  Entries:      13            Entries Range: 5-7K          │
│  Re-entry:     65 (x No Limit)  Add-on: No Add-on         │
│  Starting Chips: 40K         Big Blind Ante: No           │
│  Blind Structure: Standard                            (?) │
├────────────────────────────────────────────────────────────┤
│  ┌──────────────┐        ┌──────────────┐                 │
│  │    Share     │        │   Register   │                 │
│  └──────────────┘        └──────────────┘                 │
└────────────────────────────────────────────────────────────┘
```

### Tournament Countdown Display

```css
.tournament-countdown {
  font-family: 'Digital-7', 'JetBrains Mono', monospace;
  font-size: 3rem;
  font-weight: 700;
  color: var(--fb-gold);
  text-shadow: 0 0 20px rgba(255, 184, 0, 0.4);
  letter-spacing: 0.1em;
}

.tournament-start-time {
  font-size: 0.875rem;
  color: var(--text-secondary);
}
```

---

## 📜 HAND HISTORY / REPLAY (from Image 3 - Batch 2)

### Hand Detail Layout

```
┌────────────────────────────────────────────────────────────┐
│  HAND DETAIL                  ⭐ (i) 📋                   │
│  2026-01-12 14:51:23   5/10   SN: 2049983074              │
│                                    Share 📤               │
│                                                ID: ...    │
├────────────────────────────────────────────────────────────┤
│                           Main Pot: 2,265                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  -KingFish-                              -10.00           │
│  [UTG] 🂡🂴 🂢🂵 🂹🂲                        Main pot       │
│                                                            │
│  soul king                                0.00            │
│  [BTN] 🂡🂴 🂢🂵 🂹🂲                        Main pot       │
│                                                            │
│  cubby2426                               -5.00            │
│  [SB] 🂡🂴 🂢🂵 🂹🂲                       Main pot 🔍      │
│                                              -75          │
│                                                            │
│  Im gna CUM         One Pair          -1,125.00           │
│  [BB] 🂡🂴 🂢🂵 🂹🂲                        Main pot       │
│                                                            │
│  Wizurd                                   0.00            │
│  [MP] 🂡🂴 🂢🂵 🂹🂲                        Main pot       │
│                                                            │
│  monkey88          Two Pair         +1,137.73 ✓ WINNER    │
│  [CO] 🂡🂴 🂢🂵 🂹🂲                        Main pot       │
│                                                            │
├────────────────────────────────────────────────────────────┤
│              1/1          ◀ ───●─── ▶              💬     │
├────────────────────────────────────────────────────────────┤
│  ┌──────────────┐        ┌──────────────┐                 │
│  │ Hand Summary │        │ Hand Detail  │    [all my]     │
│  └──────────────┘        └──────────────┘                 │
└────────────────────────────────────────────────────────────┘
```

### Result Color Coding

```css
/* Winnings (positive) */
.result-win {
  color: #3fb950; /* Green */
  font-weight: 600;
}

/* Losses (negative) */
.result-loss {
  color: #f85149; /* Red */
  font-weight: 600;
}

/* Break even */
.result-neutral {
  color: var(--text-secondary);
}

/* Hand rank label */
.hand-rank {
  color: var(--fb-gold);
  font-weight: 500;
  font-size: 0.75rem;
}
```

---

## 📱 SIDE MENU (from Image 1 - Batch 1)

### Menu Structure

```
┌────────────────────────────────────────┐
│  💳  Cashier                        >  │
│  💎  Top Up                         >  │
│  ⚙️  Table Settings                 >  │
│  🔊  Sounds                         >  │
│  📳  Vibrations                 [ON]   │  ← Toggle
│  📤  Share                          >  │
│  👑  VIP                            >  │
│  🚪  Exit                           >  │
│                                        │
│                                        │
│                                        │
│          Version: 1.11038(123)         │
└────────────────────────────────────────┘
```

### Menu Item Component

```css
.menu-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  gap: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  transition: background 0.15s ease;
}

.menu-item:hover {
  background: var(--bg-hover);
}

.menu-icon {
  font-size: 1.25rem;
  color: var(--fb-gold);
  width: 24px;
  text-align: center;
}

.menu-label {
  flex: 1;
  font-size: 0.9375rem;
  color: var(--text-primary);
}

.menu-arrow {
  color: var(--text-tertiary);
}
```

---

## 📊 REAL-TIME STATS PANEL (from Image 2 - Batch 1)

### Table Info Display

```
┌────────────────────────────────────────┐
│  00:30:00            REAL TIME RESULT  │  ← Session timer
├────────────────────────────────────────┤
│  Game Name:      12-Jan 5🐘20🐘 6MAX...│
│  Game ID:        43553757              │
│  Table Creation: 2026-01-12 14:35:45   │
│  Table:          PLO4                  │
│  Blinds:         0.05/0.1              │
│  Restriction:    GPS&IP&PC             │
├────────────────────────────────────────┤
│                Profile Data            │
├────────────────────────────────────────┤
│  Buy-in:         0.00                  │
│  Winnings:       0.00                  │
│  Current Table VPIP: -%                │
├────────────────────────────────────────┤
│              Observers (1)             │
├────────────────────────────────────────┤
│  👤 Player1...                         │
│                                        │
└────────────────────────────────────────┘
```

---

## ⏱️ ANIMATIONS & TIMING

### Chip Animations

```css
/* Chip moving to pot */
@keyframes chipToPot {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 1;
  }
  80% {
    transform: translate(var(--pot-x), var(--pot-y)) scale(0.8);
    opacity: 1;
  }
  100% {
    transform: translate(var(--pot-x), var(--pot-y)) scale(0);
    opacity: 0;
  }
}
.chip-move {
  animation: chipToPot 0.4s ease-out forwards;
}

/* Pot scoop to winner */
@keyframes potToWinner {
  0% {
    transform: translate(0, 0) scale(1);
  }
  100% {
    transform: translate(var(--winner-x), var(--winner-y)) scale(0.8);
  }
}
```

### Card Animations

```css
/* Card deal */
@keyframes dealCard {
  0% {
    transform: translate(-200px, -100px) rotate(-180deg) scale(0.5);
    opacity: 0;
  }
  100% {
    transform: translate(0, 0) rotate(0) scale(1);
    opacity: 1;
  }
}
.card-deal {
  animation: dealCard 0.3s ease-out forwards;
}

/* Card flip */
@keyframes cardFlip {
  0% {
    transform: rotateY(180deg);
  }
  100% {
    transform: rotateY(0deg);
  }
}

/* Card reveal (showdown) */
@keyframes cardReveal {
  0% {
    transform: rotateY(180deg);
    filter: brightness(0.5);
  }
  50% {
    transform: rotateY(90deg);
    filter: brightness(1.2);
  }
  100% {
    transform: rotateY(0deg);
    filter: brightness(1);
  }
}
```

### Timing Standards

```
Card deal:         200-300ms ease-out
Chip movement:     300-400ms ease-out
Pot scoop:         400-500ms ease-in-out
Action timer:      60fps linear countdown
Button hover:      150ms ease
Modal transition:  250ms cubic-bezier(0.4, 0, 0.2, 1)
Fold overlay:      200ms fade-in
```

---

## 📱 RESPONSIVE BREAKPOINTS

```css
/* Mobile First */
@media (min-width: 480px) {
  /* Small phones → Large phones */
}

@media (min-width: 768px) {
  /* Tablets */
  .seat {
    width: 100px;
  }
  .hole-card {
    width: 48px;
    height: 68px;
  }
}

@media (min-width: 1024px) {
  /* Desktop */
  .seat {
    width: 120px;
  }
  .hole-card {
    width: 56px;
    height: 78px;
  }
  .action-panel {
    flex-direction: row;
  }
}

@media (min-width: 1440px) {
  /* Large Desktop */
  .table-container {
    max-width: 1200px;
  }
}
```

---

## 🎯 IMPLEMENTATION CHECKLIST

### Phase 1: Core Table

- [ ] Table felt with premium rail glow
- [ ] Seat positions (6-max & 9-max oval layout)
- [ ] Seat component with all states
- [ ] Position badges (D, SB, BB, New)
- [ ] Pot display with side pots
- [ ] Community card area

### Phase 2: Cards & Actions

- [ ] Card components (face/back)
- [ ] Hole card display (hero enlarged)
- [ ] Card deal animations
- [ ] Action panel with Fold/Check/Call/Raise
- [ ] Raise slider with multipliers

### Phase 3: Modals & Panels

- [ ] Buy-In modal with slider
- [ ] Tournament details panel
- [ ] Sign-up confirmation modal
- [ ] Side menu drawer
- [ ] Settings panel

### Phase 4: Replay System

- [ ] Hand detail view
- [ ] Player result rows
- [ ] Timeline scrubber
- [ ] Share functionality

---

## 📁 REFERENCE IMAGES LOCATION

All PokerBros reference screenshots are stored at:

```
/Users/smarter.poker/.gemini/antigravity/brain/0a6ef17e-e0ca-427c-82bb-bc22ebc45d87/

Batch 1 (Table UI):
- uploaded_image_0_1768251335806.png  → Empty table, jackpot banner
- uploaded_image_1_1768251335806.png  → Side menu
- uploaded_image_2_1768251335806.png  → Real-time stats panel
- uploaded_image_3_1768251335806.png  → Active table with players
- uploaded_image_4_1768251335806.png  → Raise amount selector

Batch 2 (Tournament/Modals):
- uploaded_image_0_1768256667158.png  → Tournament game details
- uploaded_image_1_1768256667158.png  → Sign-up modal
- uploaded_image_2_1768256667158.png  → Buy-In modal
- uploaded_image_3_1768256667158.png  → Hand detail/replay
```

---

_This document is the definitive UI reference for Club Arena development. All components should match these specifications with the Facebook blue color scheme._
