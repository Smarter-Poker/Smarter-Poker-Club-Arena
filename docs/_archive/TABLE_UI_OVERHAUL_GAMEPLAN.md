# Club Arena — Table UI Overhaul Game Plan

**Date:** March 10, 2026
**Goal:** Transform our broken, generic poker table into a professional-grade mobile experience that matches PokerBros, ClubGG, and WPT Global quality.

---

## PART 1: WHAT THE PROS DO (AND WE DON'T)

### The Gold Standard: PokerBros + ClubGG + WPT Global

All three apps share these core design principles:

1. **Portrait-first, mobile-optimized** — Table always vertical, hero ALWAYS at bottom center
2. **Three-button action bar** — Fold (red, left), Check/Call (green/blue, center), Raise (yellow/orange, right) in a single horizontal row
3. **Raise mode with slider + presets** — Horizontal slider with 1/2 Pot, Pot, 2x, 3x, All-In preset buttons
4. **Compact player seats** — Small circular/rounded avatars with name + stack underneath, positioned tight to the table edge
5. **Central pot with chip visualization** — Animated chip stacks in the center, clear numeric display
6. **Community cards dead-center** — 5 cards in a clean horizontal row, middle of the felt
7. **Minimal top bar** — Back button, table info, menu — nothing else
8. **Rich sound design** — Every action has a sound: deal, check, call, raise, fold, all-in, win, timer warning
9. **Smooth animations everywhere** — Card dealing, chip movement, pot distribution, showdown reveal

### What's Wrong With Ours (Brutally Honest)

Looking at our current table screenshot:

1. **SEAT LABELS ARE AMATEUR** — "SEAT 1", "SEAT 2" etc. in plain text with dashed borders. No real poker app shows seat numbers like this. Empty seats should be a subtle "+" or small "Sit" button, not labeled boxes.

2. **GOLD SIT BUTTONS LOOK CHEAP** — Big gold "SIT" buttons with dashed outlines look like a prototype, not a product.

3. **NO HEADER BAR** — There's no back button, no table name, no blinds display, no menu. Just a floating "+" button and the BBJ badge.

4. **BOTTOM AREA IS A MESS** — "You are watching" text, a random avatar, "STRADDLE 4", "Observing" toggle, and "TIME BANK" with dots are all crammed together with no visual hierarchy.

5. **ACTION BUTTONS ARE A 2x2 GRID** — Professional apps use a single horizontal row of 3 buttons. Our 2x2 grid wastes space and looks like a calculator.

6. **TABLE FELT IS OK BUT SEATS ARE WRONG** — The green felt and gold rail look decent, but seats positioned WITH labels outside the table boundary look terrible.

7. **"PREFLOP" AND "NLH" TEXT IN CENTER** — No professional app puts giant text labels in the middle of the felt. The game type and stage should be tiny or in the header.

8. **NO PLAYER AVATARS** — Empty seats show no placeholder art. Occupied seats use basic rectangles instead of rounded avatar circles.

9. **NO SOUND EFFECTS** — The SoundService exists but sounds are minimal/broken.

10. **COMMUNITY CARDS TOO SMALL** — When cards are dealt, they're undersized relative to the table.

---

## PART 2: SIDE-BY-SIDE COMPARISON

| Feature                | PokerBros                         | ClubGG                      | WPT Global                   | **OURS**                                     | Gap                   |
| ---------------------- | --------------------------------- | --------------------------- | ---------------------------- | -------------------------------------------- | --------------------- |
| **Orientation**        | Portrait only                     | Portrait + landscape        | Both                         | Portrait                                     | OK                    |
| **Hero Position**      | Always bottom center              | Always bottom center        | Always bottom center         | Bottom center                                | OK                    |
| **Seat Display**       | Round avatar + name + stack       | Round avatar + name + stack | Round avatar + name + stack  | **Labeled rectangles with "SIT" buttons**    | CRITICAL              |
| **Empty Seats**        | Small "+" or invisible            | Small "Sit" button          | Subtle empty indicator       | **"SEAT X" + gold SIT box + dashed border**  | CRITICAL              |
| **Action Buttons**     | 3-button horizontal row           | 3-button horizontal row     | 3-button horizontal row      | **2x2 grid**                                 | CRITICAL              |
| **Fold Color**         | Red                               | Red                         | Red/dark                     | Red gradient                                 | OK                    |
| **Call Color**         | Green/Blue                        | Blue/Green                  | Blue/Teal                    | Facebook Blue                                | NEEDS CHANGE to green |
| **Raise Color**        | Yellow/Orange                     | Yellow/Amber                | Green                        | Orange/Amber                                 | OK                    |
| **Raise Slider**       | Horizontal + presets              | Vertical + AI + presets     | Horizontal + presets         | Horizontal (hidden in sub-panel)             | NEEDS WORK            |
| **Preset Buttons**     | ½ Pot, Pot, 2x, 3x, All-In        | Customizable presets        | ½ Pot, Pot, 2x, etc.         | 2X, 3X, 4X, POT, ALL IN                      | Functional but ugly   |
| **Top Bar**            | Back + table name + blinds + menu | Back + info + HUD           | Back + table info + settings | **"+" button only, no back, no info**        | CRITICAL              |
| **Pot Display**        | Center, chip stacks + number      | Center, prominent number    | Center, large number         | Center, gold text + chip dots                | NEEDS POLISH          |
| **Community Cards**    | Center-top, large, animated       | Center, smooth animation    | Center, smooth               | Center, small, basic animation               | NEEDS SIZING UP       |
| **Player Timer**       | Circular/arc around avatar        | Bar near avatar             | Countdown + extension        | 3px bar at top of seat                       | NEEDS IMPROVEMENT     |
| **Dealer Button**      | White "D" circle                  | Standard dealer chip        | Clear dealer indicator       | 24px circle badge                            | OK but small          |
| **Straddle**           | Toggle in game controls           | Available                   | Available                    | **Floating text "STRADDLE 4" in bottom bar** | NEEDS REDESIGN        |
| **Sound Effects**      | Full suite (12+ sounds)           | Full suite                  | Full suite                   | Partial (fold, check only)                   | CRITICAL              |
| **Card Dealing Anim**  | Smooth fly-in                     | Smooth with squeeze         | Smooth                       | 3D flip (decent)                             | OK                    |
| **Chip to Pot Anim**   | Chips fly to center               | Smooth movement             | Animated                     | chipDrop animation                           | NEEDS IMPROVEMENT     |
| **Win Animation**      | Highlight + chips fly to winner   | Celebration effects         | Winner highlight             | Basic highlight                              | NEEDS IMPROVEMENT     |
| **Table Themes**       | 6 customizable themes             | Multiple themes             | Multiple themes              | 1 theme (green felt)                         | LOW PRIORITY          |
| **Avatar System**      | 3D cartoon avatars                | Customizable + NFT          | Detailed avatars             | DiceBear API fallback                        | LOW PRIORITY          |
| **Pre-Action Buttons** | Check/Fold, Call Any              | Pre-action available        | Fold/Check pre-action        | **None visible**                             | MEDIUM                |
| **BB/Chips Toggle**    | Yes (in display settings)         | Yes                         | Yes                          | **Implemented (pot only)**                   | NEEDS EXTENSION       |
| **Hand Strength**      | Not shown by default              | Smart HUD (paid)            | Not shown                    | Basic bar indicator                          | OK                    |
| **Run It Twice**       | Yes with UI                       | Yes with UI                 | Not standard                 | Code exists, UI untested                     | NEEDS TESTING         |
| **Insurance**          | Yes                               | Yes (post-flop only)        | Yes (5% commission)          | Code exists, never triggered                 | NEEDS FIXING          |
| **Bomb Pot**           | Yes with special UI               | Not standard                | Not standard                 | Badge in lobby, no special UI                | LOW PRIORITY          |

---

## PART 3: THE IMPLEMENTATION PLAN

### Priority 1: ACTION PANEL REDESIGN (Most Critical)

**Current:** 2x2 grid of buttons with raise mode sub-panel
**Target:** Single horizontal row of 3 large buttons (Fold / Check-Call / Raise)

**Files to Modify:**

- `src/components/table/ActionPanel.tsx`
- `src/components/table/ActionPanel.css`

**Changes:**

```
BEFORE (2x2 grid):
┌─────────┬─────────┐
│  FOLD   │  CHECK  │
├─────────┼─────────┤
│  RAISE  │  CALL   │
└─────────┴─────────┘

AFTER (3-button row):
┌────────┬──────────┬────────┐
│  FOLD  │CHECK/CALL│ RAISE  │
│  (red) │ (green)  │(orange)│
└────────┴──────────┴────────┘
```

**Raise Mode (slides up from bottom):**

```
┌────────────────────────────────┐
│  [$125]  [-]  ═══●═══  [+]   │
│ [½ POT] [POT] [2x] [3x] [AI] │
│                                │
│ ┌──BACK──┐        ┌─CONFIRM─┐ │
│ │ Cancel │        │  RAISE  │ │
│ └────────┘        └─────────┘ │
└────────────────────────────────┘
```

**Specific CSS Changes:**

- Remove `grid-template-columns: 1fr 1fr`
- Switch to `display: flex; gap: 8px;`
- Each button: `flex: 1; height: 56px; border-radius: 12px;`
- Fold: `background: linear-gradient(180deg, #EF4444, #DC2626)` (true red)
- Check/Call: `background: linear-gradient(180deg, #22C55E, #16A34A)` (green)
- Raise: `background: linear-gradient(180deg, #F59E0B, #D97706)` (amber)
- All buttons: `font-size: 1rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px`
- Active state: `transform: scale(0.97); filter: brightness(0.9)`
- Show call amount as secondary text: "CALL" on top, "$4.00" below in smaller font

---

### Priority 2: SEAT DISPLAY OVERHAUL

**Current:** "SEAT 1" labels + dashed borders + gold SIT buttons
**Target:** Clean circular avatars with name/stack underneath, subtle empty seat indicators

**Files to Modify:**

- `src/components/table/SeatSlot.tsx`
- `src/components/table/SeatSlot.css`
- `src/pages/TablePage.tsx` (seat position coordinates)

**Empty Seat Changes:**

- Remove "SEAT X" label entirely
- Remove dashed border
- Replace gold "SIT" button with a small 36px semi-transparent circle with a "+" icon
- On tap: Show buy-in modal
- Subtle pulse animation on hover

**Occupied Seat Changes:**

- Avatar: 48px circle (not rectangle), with 2px colored border (green=active, gray=idle, red=sitting out)
- Name: Below avatar, 11px, white, truncated with ellipsis
- Stack: Below name, 12px bold, gold color, formatted as "1,250" or "625 BB"
- Bet amount: Float near the seat toward the center of the table, small chip icon + amount
- Active player: Glowing ring animation around avatar + timer arc
- Folded: Dimmed to 40% opacity

**Seat Position Adjustments (9-max):**

```
Current positions create gaps. New positions should hug the felt edge:
Seat 1 (hero): bottom-center, OUTSIDE the table below the felt
Seat 2: bottom-left, at felt edge
Seat 3: left, at felt edge
Seat 4: top-left, at felt edge
Seat 5: top-center, at felt edge
Seat 6: top-right, at felt edge
Seat 7: right, at felt edge
Seat 8: bottom-right, at felt edge
Seat 9: (if 9-max) additional position
```

---

### Priority 3: TOP BAR / HEADER

**Current:** No real header — just a floating "+" button and BBJ badge
**Target:** Clean, compact header bar with essential info

**Files to Modify:**

- `src/pages/TablePage.tsx`
- `src/pages/TablePage.css`

**New Header Layout:**

```
┌──────────────────────────────────────┐
│ [←] NLH 1/2 • 9-Max    [⚙] [☰]   │
│      Shark Club                      │
└──────────────────────────────────────┘
```

- Height: 44px
- Background: `rgba(0, 0, 0, 0.7)` with `backdrop-filter: blur(12px)`
- Back button (←): 32px, navigates to club home
- Table info: Game type + blinds + max players
- Club name: Small secondary text below
- Settings gear icon: Opens table settings panel
- Menu icon (☰): Opens side menu (leave table, hand history, etc.)
- BBJ badge: Moves INTO the header as a small inline badge if > 0

---

### Priority 4: BOTTOM CONTROLS CLEANUP

**Current:** Messy mix of straddle text, observing toggle, time bank dots, avatar
**Target:** Clean control strip between table and action panel

**Files to Modify:**

- `src/pages/TablePage.tsx`
- `src/pages/TablePage.css`

**New Bottom Controls Layout:**

```
When observing:
┌──────────────────────────────────────┐
│         Click a seat to join         │
└──────────────────────────────────────┘

When seated (above action buttons):
┌──────────────────────────────────────┐
│ [STR] [⏱ 3]  [Pot: 24.50]  [🐰] [💬]│
└──────────────────────────────────────┘
```

- Straddle: Small toggle pill, only when applicable
- Time Bank: Clock icon + count, only when seated
- Pot info: Quick glance pot amount (mirrors center display)
- Rabbit Hunt: Small icon button
- Chat: Small icon button
- All icons: 28px, semi-transparent, subtle

---

### Priority 5: COMMUNITY CARDS SIZING + CENTERING

**Current:** Cards are undersized, "PREFLOP" and "NLH" text clutters the center
**Target:** Larger cards, clean center area

**Files to Modify:**

- `src/components/table/CommunityCards.tsx`
- `src/components/table/CommunityCards.css`

**Changes:**

- Card size: Increase from 48×72px to 56×84px (mobile), 64×96px (tablet)
- Remove "PREFLOP" stage label from center of table (move to header or remove entirely)
- Remove "NLH" and "Blinds: X/Y" text from center (already in header)
- Add subtle separator lines between flop|turn|river groups
- Ensure cards are vertically centered in the top half of the felt

---

### Priority 6: SOUND EFFECTS

**Current:** SoundService exists but sounds are sparse
**Target:** Full sound suite matching PokerBros quality

**Files to Modify:**

- `src/services/SoundService.ts`
- Add sound files to `public/sounds/`

**Sounds Needed:**

| Event             | Sound                 | Duration  | Notes                  |
| ----------------- | --------------------- | --------- | ---------------------- |
| Card Deal         | Soft card slide       | 0.3s      | Play per card dealt    |
| Check             | Single chip tap       | 0.2s      | Subtle                 |
| Call              | Chips clink (small)   | 0.3s      | Match amount feel      |
| Bet/Raise         | Chips stack (larger)  | 0.4s      | More chips = louder    |
| Fold              | Card toss / swoosh    | 0.3s      | Dismissive             |
| All-In            | Dramatic chip push    | 0.6s      | With reverb            |
| Win Pot           | Chips sweep / collect | 0.5s      | Satisfying             |
| Turn Notification | Soft ding             | 0.2s      | "It's your turn"       |
| Timer Warning     | Tick-tock             | 0.3s loop | At 5 seconds remaining |
| Community Card    | Card flip / snap      | 0.2s      | Per card revealed      |
| Showdown          | Dramatic reveal       | 0.4s      | Cards flipping         |
| Button Click      | UI tap                | 0.1s      | For any button press   |

**Implementation:** Use Web Audio API for low-latency playback. Preload all sounds on table mount. Volume control in settings.

---

### Priority 7: ANIMATIONS UPGRADE

**Files to Modify:**

- `src/pages/TablePage.tsx`
- `src/components/table/ChipStack.tsx`
- `src/components/table/PotDisplay.tsx`
- `src/components/table/SeatSlot.tsx`

**Animation Upgrades:**

1. **Chip-to-pot animation:** When a player bets, animate small chip icons flying from their seat to the pot center (currently just appears instantly)

2. **Pot-to-winner animation:** When someone wins, animate chips flying from pot to winner's stack (currently none)

3. **Card dealing sequence:** Stagger card delivery — deal one card at a time to each player with a 100ms delay between each (currently all appear at once)

4. **Active player glow:** Stronger, more visible pulsing glow around the active seat — use a ring/arc timer that counts down visually

5. **Showdown card reveal:** Dramatic sequential card flip for each player at showdown

6. **Fold animation:** Cards should visually fly toward the muck/center and fade

---

### Priority 8: PRE-ACTION BUTTONS

**Files to Modify:**

- `src/pages/TablePage.tsx`
- New: `src/components/table/PreActionBar.tsx`

**Implementation:**

- Show when it's NOT your turn
- Options: "Fold", "Check/Fold", "Call Any", "Check"
- Small pill buttons above the action panel
- Semi-transparent, don't obstruct the table view
- Selected pre-action highlights with a small indicator
- Auto-executes when turn comes (with cancel option)

---

### Priority 9: PLAYER TIMER UPGRADE

**Current:** 3px thin bar at top of seat
**Target:** Circular arc timer around the avatar (like PokerBros)

**Files to Modify:**

- `src/components/table/TimerBar.tsx`
- `src/components/table/SeatSlot.tsx`

**Changes:**

- Replace linear bar with SVG circular arc around the player's avatar
- Green (>50% time) → Yellow (25-50%) → Red (<25%)
- Pulsing animation when below 10%
- Time bank activation: Shows "+X" badge when time bank kicks in
- Countdown number in center of avatar when <5 seconds

---

## PART 4: FILE CHANGE SUMMARY

| File                                      | Type          | Changes                                                         |
| ----------------------------------------- | ------------- | --------------------------------------------------------------- |
| `src/components/table/ActionPanel.tsx`    | Major Rewrite | 3-button row, raise mode redesign                               |
| `src/components/table/ActionPanel.css`    | Major Rewrite | Flex layout, new colors, raise panel                            |
| `src/components/table/SeatSlot.tsx`       | Major Rewrite | Circular avatars, remove labels, compact design                 |
| `src/components/table/SeatSlot.css`       | Major Rewrite | Circle layout, active glow, bet float                           |
| `src/pages/TablePage.tsx`                 | Significant   | New header, bottom controls, remove center text, seat positions |
| `src/pages/TablePage.css`                 | Significant   | Header bar styles, bottom controls, layout adjustments          |
| `src/components/table/CommunityCards.tsx` | Moderate      | Larger cards, remove stage label                                |
| `src/components/table/CommunityCards.css` | Moderate      | Size increase, spacing                                          |
| `src/components/table/TimerBar.tsx`       | Moderate      | Circular SVG arc variant                                        |
| `src/components/table/PotDisplay.tsx`     | Minor         | Already good, minor polish                                      |
| `src/services/SoundService.ts`            | Moderate      | Add all sound events                                            |
| `src/components/table/PreActionBar.tsx`   | NEW           | Pre-action button component                                     |
| `src/components/table/PreActionBar.css`   | NEW           | Pre-action styling                                              |
| `public/sounds/*.mp3`                     | NEW           | 12 sound effect files                                           |

---

## PART 5: EXECUTION ORDER

**Phase 1 — Core Layout (Do First)**

1. Action Panel → 3-button horizontal row
2. Seat Display → Circular avatars, remove labels
3. Top Header → Add proper navigation bar
4. Remove center clutter (PREFLOP label, NLH text, blinds text)

**Phase 2 — Polish** 5. Bottom Controls → Clean strip with icons 6. Community Cards → Size up, better spacing 7. Timer → Circular arc variant 8. Pre-action buttons → New component

**Phase 3 — Feel** 9. Sound effects → Full suite 10. Animations → Chip movement, card dealing, win effects 11. Testing → Full E2E on mobile viewport

---

## PART 6: DESIGN TOKENS (New Standard)

```css
/* Colors */
--color-fold: #ef4444;
--color-fold-dark: #dc2626;
--color-call: #22c55e;
--color-call-dark: #16a34a;
--color-raise: #f59e0b;
--color-raise-dark: #d97706;
--color-allin: #8b5cf6;
--color-allin-dark: #7c3aed;
--color-gold: #ffd700;
--color-gold-dark: #d4a84b;
--color-felt: #0d2820;
--color-felt-light: #1a3d2e;
--color-surface: rgba(0, 0, 0, 0.7);
--color-surface-light: rgba(255, 255, 255, 0.1);

/* Sizing */
--avatar-size: 48px;
--avatar-size-hero: 56px;
--card-width: 56px;
--card-height: 84px;
--button-height: 56px;
--header-height: 44px;
--seat-name-size: 11px;
--seat-stack-size: 12px;

/* Animations */
--anim-fast: 150ms;
--anim-normal: 300ms;
--anim-slow: 600ms;
--easing-out: cubic-bezier(0.16, 1, 0.3, 1);
--easing-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
```

---

_This document serves as the complete blueprint. Every change listed here needs to happen to bring our table UI from "broken prototype" to "professional poker app."_
