# Club Arena — Phase 4: Complete Premium Overhaul Plan

**Date:** March 10, 2026
**Goal:** Close every gap between Club Arena and PokerBros/ClubGG/WPT Global, fix every bug, optimize every bottleneck, and ship a table that is objectively better than all three competitors.

---

## EXECUTIVE SUMMARY

Phase 1-2 built the foundation (PokerBros-style layout, action panel, seats, community cards). Phase 3 added the "feel" layer (sounds, chip animations, card effects, all-in mode, confetti, multi-table tabs). **Phase 4 is the final push** — fixing critical bugs, refactoring for performance, adding missing competitive features, and polishing every pixel until the product is undeniably premium.

### What We Learned From Competitors

| Dimension        | PokerBros                           | ClubGG                                    | WPT Global                               | Club Arena (Current)               |
| ---------------- | ----------------------------------- | ----------------------------------------- | ---------------------------------------- | ---------------------------------- |
| Table Graphics   | 3D avatars, 6 themes, felt textures | GGPoker DNA, dark red, crisp              | Light/bright, cartoonish                 | Dark gradient, no felt texture     |
| Sound Quality    | Pre-recorded samples, customizable  | Standard inherited from GG                | Professional, low-data mode              | Procedural Web Audio (synthetic)   |
| HUD/Stats        | Career page, VPIP, heat index       | Smart HUD (VPIP/PFR/3BET), PokerCraft     | No HUD (recreational focus)              | HandStrengthIndicator only         |
| Multi-Table      | 4 max, swipe, arrow notifications   | 4 max, swiping, timer visible             | 4-7 max, tab-based                       | 4 max, swipe (basic)               |
| Animations       | Smooth 60fps, customizable speed    | GGPoker-grade, emoji throws               | Improved 2025 update, final table themes | CSS-based, no speed control        |
| Mobile UX        | Portrait-locked, one-handed, 3D     | Portrait, large buttons, BB display       | Flexible orientation, touch-optimized    | Portrait, some overflow issues     |
| Customization    | 6 themes, card backs, felt colors   | Dark red theme, deck options              | Backgrounds, card backs, themes          | Dark mode only, no themes          |
| Special Features | 14K emojis, rabbit hunt, voice chat | Smart HUD, PokerCraft, AoF mode, GG Class | Mystery Bounty, FairGame, card squeeze   | Throwables, rabbit hunt, insurance |

### Gap Count: 102 Issues Found

- **Critical bugs:** 3 (Safari timer, Firefox slider, z-index modals)
- **Performance:** 18 (missing React.memo, no lazy loading, monolithic component)
- **Missing features:** 27 (HUD, themes, equity calc, hand history export)
- **Visual polish:** 23 (dated gradients, flat styling, no felt texture)
- **UX gaps:** 15 (no landscape, no tablet optimization, no animation speed control)
- **Architecture:** 16 (3,342-line monolith, prop drilling, z-index chaos)

---

## PHASE 4 SPRINT BREAKDOWN

### Sprint 1: Critical Bug Fixes & Browser Compatibility (Day 1)

**Priority:** 🔴 CRITICAL — These bugs affect 30%+ of users

#### 1.1 Safari Timer Animation Fix

- **File:** `SeatSlot.css` lines 219-225
- **Problem:** `conic-gradient` with CSS variable calculation fails on iOS Safari
- **Fix:** Replace with explicit `background-image` with calc fallback, OR use JS-driven animation frame for Safari
- **Testing:** iPhone Safari, iPad Safari, Chrome iOS

#### 1.2 Firefox Raise Slider Fix

- **File:** `ActionPanel.css` lines 242-266
- **Problem:** Only `::-webkit-slider-thumb` styled — Firefox shows unstyled default slider
- **Fix:** Add `::-moz-range-track`, `::-moz-range-thumb`, `::-moz-range-progress` styles matching webkit
- **Testing:** Firefox desktop, Firefox Android

#### 1.3 Z-Index Modal Collision Fix

- **Files:** `TablePage.css` lines 388-414, all modal CSS
- **Problem:** Menu overlay (z:200) can obscure BuyIn/Rebuy modals, buttons become unclickable
- **Fix:** Implement z-index hierarchy system:
  ```
  --z-table: 1
  --z-seats: 10
  --z-pot: 20
  --z-header: 100
  --z-action-panel: 100
  --z-overlay: 200
  --z-side-menu: 300
  --z-modal-backdrop: 400
  --z-modal: 500
  --z-toast: 600
  --z-confetti: 700
  ```

#### 1.4 Action Panel Safe Area Fix

- **File:** `TablePage.css` line 289
- **Problem:** Buttons hidden behind iPhone home indicator / bottom bar
- **Fix:** Add `padding-bottom: calc(env(safe-area-inset-bottom) + 8px)` to action-panel wrapper

#### 1.5 Hero Card Overflow Fix

- **File:** `SeatSlot.css` lines 317, 332
- **Problem:** Hero cards `right: -28px` causes overflow on small screens
- **Fix:** Use `clamp(-28px, -2vw, -16px)` based on viewport

#### 1.6 Disabled Button State

- **File:** `ActionPanel.css` lines 62-66
- **Problem:** Disabled buttons only use `opacity: 0.35` — not obvious enough
- **Fix:** Add `cursor: not-allowed`, `filter: grayscale(1)`, remove box-shadow

---

### Sprint 2: Performance Optimization (Day 1-2)

**Priority:** 🟠 HIGH — 15-20% rendering improvement

#### 2.1 React.memo Critical Components

Add `React.memo` with custom equality comparators to:

- **SeatSlot** — renders 6-9 instances, only re-render when that player's data changes
- **PotDisplay** — only re-render on pot amount change
- **CommunityCards** — only re-render when board cards change
- **ActionPanel** — only re-render when available actions change
- **PreActionBar** — only re-render when pre-action options change
- **ChipStack** — only re-render when stack amount changes

```tsx
// Example: SeatSlot memoization
export default React.memo(SeatSlot, (prev, next) => {
  return (
    prev.player?.id === next.player?.id &&
    prev.player?.stack === next.player?.stack &&
    prev.player?.isTurn === next.player?.isTurn &&
    prev.player?.lastAction === next.player?.lastAction &&
    prev.timerProgress === next.timerProgress
  );
});
```

#### 2.2 useCallback for Action Handlers

Memoize all callbacks passed to child components in TablePage:

- `handleAction` (to ActionPanel)
- `handlePreAction` (to PreActionBar)
- `handleSeatClick` (to SeatSlot)
- `handleThrowableSelect` (to ThrowableSelector)

#### 2.3 Avatar Lazy Loading

- Add `loading="lazy"` to all avatar `<img>` tags in SeatSlot
- Add IntersectionObserver for off-screen seats
- Add gradient skeleton placeholder while loading
- Add error fallback (already have initials — ensure it triggers)

#### 2.4 CSS will-change Optimization

Add `will-change` hints to animated elements:

- Community card containers: `will-change: transform`
- Chip animation elements: `will-change: transform, opacity`
- Timer ring pseudo-element: `will-change: background`
- Action buttons on hover: `will-change: box-shadow`

#### 2.5 prefers-reduced-motion

Add global media query to disable/reduce animations:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

#### 2.6 Image Optimization

- Convert card PNGs to WebP with PNG fallback
- Optimize avatar images (compress, resize to 112px max for 2x retina)
- Add `<picture>` element with `srcset` for card images

---

### Sprint 3: CSS Design System & Visual Foundation (Day 2-3)

**Priority:** 🟠 HIGH — Foundation for all visual improvements

#### 3.1 CSS Custom Properties System

Create a comprehensive design token system in a new `design-tokens.css`:

```css
:root {
  /* Spacing Scale */
  --space-2xs: 2px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;
  --space-3xl: 48px;

  /* Border Radius Scale */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 9999px;
  --radius-circle: 50%;

  /* Typography Scale */
  --font-xs: clamp(0.625rem, 1.2vw, 0.6875rem);
  --font-sm: clamp(0.6875rem, 1.4vw, 0.75rem);
  --font-md: clamp(0.75rem, 1.6vw, 0.875rem);
  --font-lg: clamp(0.875rem, 2vw, 1rem);
  --font-xl: clamp(1rem, 2.5vw, 1.25rem);
  --font-2xl: clamp(1.25rem, 3vw, 1.5rem);

  /* Z-Index Layers */
  --z-table: 1;
  --z-seats: 10;
  --z-pot: 20;
  --z-header: 100;
  --z-action-panel: 100;
  --z-overlay: 200;
  --z-side-menu: 300;
  --z-modal-backdrop: 400;
  --z-modal: 500;
  --z-toast: 600;
  --z-confetti: 700;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-glow: 0 0 20px rgba(37, 99, 235, 0.4);

  /* Animation Timing */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --duration-fast: 150ms;
  --duration-normal: 300ms;
  --duration-slow: 500ms;

  /* Animation Speed Multiplier (user-adjustable) */
  --animation-speed: 1;

  /* Theme Colors - Dark (Default) */
  --bg-primary: #0a0e17;
  --bg-secondary: #111827;
  --bg-surface: #1a2234;
  --bg-elevated: #1f2937;
  --text-primary: #f3f4f6;
  --text-secondary: #9ca3af;
  --text-muted: #6b7280;
  --border-default: rgba(255, 255, 255, 0.08);
  --border-active: rgba(255, 255, 255, 0.15);

  /* Table Theme Colors */
  --felt-color: #0f5132;
  --felt-texture: url('/textures/felt-green.webp');
  --rail-color: linear-gradient(180deg, #4a3728 0%, #2c1d12 50%, #1a0f08 100%);
  --rail-highlight: rgba(255, 255, 255, 0.08);

  /* Action Colors */
  --color-fold: #dc2626;
  --color-check: #16a34a;
  --color-call: #16a34a;
  --color-raise: #f59e0b;
  --color-allin: #7c3aed;

  /* Status Colors */
  --color-success: #22c55e;
  --color-warning: #f59e0b;
  --color-danger: #ef4444;
  --color-info: #3b82f6;
}

/* Light Theme Override */
[data-theme='light'] {
  --bg-primary: #f8fafc;
  --bg-secondary: #f1f5f9;
  --bg-surface: #ffffff;
  --bg-elevated: #ffffff;
  --text-primary: #1e293b;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --border-default: rgba(0, 0, 0, 0.08);
  --border-active: rgba(0, 0, 0, 0.15);
  --felt-color: #1a7a4a;
  --rail-color: linear-gradient(180deg, #8b6914 0%, #5c4512 50%, #3a2c0e 100%);
}

/* Blue Theme */
[data-theme='blue'] {
  --felt-color: #1e3a5f;
  --felt-texture: url('/textures/felt-blue.webp');
  --rail-color: linear-gradient(180deg, #374151 0%, #1f2937 50%, #111827 100%);
}

/* Red Theme (ClubGG style) */
[data-theme='red'] {
  --felt-color: #7f1d1d;
  --felt-texture: url('/textures/felt-red.webp');
  --rail-color: linear-gradient(180deg, #451a03 0%, #2c0d00 50%, #1a0800 100%);
}

/* Purple Theme */
[data-theme='purple'] {
  --felt-color: #4c1d95;
  --felt-texture: url('/textures/felt-purple.webp');
}

/* Black Theme */
[data-theme='black'] {
  --felt-color: #18181b;
  --felt-texture: url('/textures/felt-black.webp');
  --rail-color: linear-gradient(180deg, #27272a 0%, #18181b 50%, #09090b 100%);
}
```

#### 3.2 Replace All Hardcoded Values

Sweep through ALL table CSS files and replace hardcoded values with design tokens:

- `TablePage.css` — padding, gaps, font sizes, z-indexes
- `SeatSlot.css` — all spacing, border-radius, font sizes
- `ActionPanel.css` — button sizing, shadows, spacing
- `PreActionBar.css` — spacing, radius, font
- `CommunityCards.css` — gaps, card sizes, placeholder opacity
- `PotDisplay.css` — chip sizes, spacing
- `TableTabBar.css` — heights, padding, colors

#### 3.3 Responsive Breakpoint Overhaul

Add missing breakpoints and use fluid typography:

```css
/* Mobile-first responsive scale */
@media (min-width: 380px) {
  /* Small phones */
}
@media (min-width: 480px) {
  /* Standard phones */
}
@media (min-width: 640px) {
  /* Large phones / small tablets */
}
@media (min-width: 768px) {
  /* Tablets portrait */
}
@media (min-width: 1024px) {
  /* Tablets landscape / small desktop */
}
@media (min-width: 1280px) {
  /* Desktop */
}
@media (min-width: 1440px) {
  /* Large desktop */
}

/* Orientation */
@media (orientation: landscape) and (max-height: 500px) {
  /* Landscape phone optimization */
}

/* Foldable devices */
@media (horizontal-viewport-segments: 2) {
  /* Fold-aware layout */
}
```

#### 3.4 Table Felt Texture

- Create/source subtle woven fabric texture (WebP, ~20KB)
- Apply as repeating background to table surface element
- Add subtle noise grain overlay for depth
- Add CSS `background-blend-mode: multiply` for felt + gradient combo

#### 3.5 Table Rail 3D Effect

Upgrade rail from flat gradient to 3D embossed:

```css
.table-surface {
  border: 4px solid transparent;
  background-clip: padding-box;
  box-shadow:
    inset 0 2px 4px rgba(255, 255, 255, 0.08),
    /* inner highlight */ inset 0 -2px 4px rgba(0, 0, 0, 0.3),
    /* inner shadow */ 0 4px 8px rgba(0, 0, 0, 0.4),
    /* outer shadow */ 0 0 0 4px var(--rail-color); /* rail edge */
}
```

---

### Sprint 4: Table Theme System (Day 3)

**Priority:** 🟡 MEDIUM — Competitive feature, engagement driver

#### 4.1 Theme Selector Component

Create `ThemeSelector.tsx`:

- 6 themes: Green (default), Blue, Red, Purple, Black, Gold
- Live preview thumbnail for each theme
- Persist selection to localStorage and Supabase user preferences
- Apply via `data-theme` attribute on root element

#### 4.2 Card Back Selector

Create `CardBackSelector.tsx`:

- 4-6 card back designs
- Preview each design as mini card
- Persist selection
- Render custom card back in `CardImage.tsx` when face-down

#### 4.3 Animation Speed Control

Add to SettingsPanel:

- Slider: 0.5x → 1x → 1.5x → 2x → Off
- Applies `--animation-speed` CSS variable
- All animation durations multiply by this variable
- "Off" sets `--animation-speed: 0` (instant)

#### 4.4 Four-Color Deck Enhancement

- Already have 4-color toggle — ensure it's working
- Add deck style selector: Classic, Modern, Jumbo Index
- Different card face rendering per style

---

### Sprint 5: Action Panel Premium Upgrade (Day 3-4)

**Priority:** 🟡 MEDIUM — Direct gameplay impact

#### 5.1 Modern Button Styling

Replace dated 3D box-shadows with modern elevation:

```css
.action-btn {
  box-shadow: var(--shadow-md);
  border: 1px solid rgba(255, 255, 255, 0.1);
  text-transform: none; /* Remove ALL CAPS */
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: all var(--duration-fast) var(--ease-out);
}
.action-btn:active {
  transform: scale(0.96);
  box-shadow: var(--shadow-sm);
}
```

#### 5.2 Bet Preset Enhancement

Show actual chip amounts in preset labels:

```
Instead of: "½ POT"  "POT"  "2×"  "3×"
Show:        "½ POT ($250)"  "POT ($500)"  "2× ($1000)"  "3× ($1500)"
```

#### 5.3 Animated Bet Counter

When bet amount changes (slider drag), animate the number with digit-roll effect:

- Each digit rolls up/down independently
- Use CSS `transform: translateY()` with overflow hidden
- 100ms transition per digit

#### 5.4 Slider Gesture Support

- Double-tap slider: toggle between min and max bet
- Arrow keys (←/→): increment/decrement by 1 BB
- Shift+Arrow: increment by 5 BB
- Touch velocity: faster drag = larger jumps

#### 5.5 All-In Confirmation

When "Confirm All-In" is enabled in settings:

- First tap: button changes to "CONFIRM ALL-IN?" with pulsing red border
- Second tap: executes
- 3-second auto-cancel back to normal

#### 5.6 Pre-Action Bar Expansion

Add missing pre-actions:

- "Check/Call" (check if possible, call otherwise)
- "Fold to Any Bet"
- Keep existing: "Fold", "Check", "Call Any"
  Total: 5 options matching ClubGG

---

### Sprint 6: Seat Display Premium Polish (Day 4-5)

**Priority:** 🟡 MEDIUM — Visual quality lift

#### 6.1 Stack Color Dynamics

Dynamic stack amount color based on BB ratio:

- ≥100 BB: White (healthy)
- 50-99 BB: Green (normal)
- 20-49 BB: Amber/Yellow (warning)
- 10-19 BB: Orange (danger)
- <10 BB: Red (critical) + subtle pulse

#### 6.2 Animated Number Transitions

When stack changes, animate the transition:

```css
.seat__stack {
  transition: color 0.3s;
}
```

Plus JS: tween the displayed number from old value to new over 500ms

#### 6.3 Sitting Out Visual

Replace simple `opacity: 0.55` with:

- "SITTING OUT" text badge overlaying avatar
- Gray filter on avatar: `filter: grayscale(0.8) brightness(0.6)`
- Crossed-out icon overlay
- "Away" timer showing how long they've been sitting out

#### 6.4 Position Chip 3D Effect

Upgrade D/SB/BB chips from flat circles to 3D rendered:

```css
.position-badge {
  background:
    radial-gradient(circle at 35% 35%, #fff3 0%, transparent 60%),
    linear-gradient(135deg, var(--badge-color-light), var(--badge-color-dark));
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.15);
}
```

#### 6.5 Avatar Status Borders

- Active (hero's turn): Bright yellow glow ring
- All-in: Red pulsing ring
- Won last hand: Gold sparkle ring (3-second celebration)
- Sitting out: Gray dashed ring pulsing orange
- Disconnected: Red broken ring icon

#### 6.6 Bounty Badge Enhancement

- Larger badge with target icon (🎯)
- Animated glow (intensify existing `bountyGlow`)
- Show bounty amount prominently
- Pulsing animation when bounty is large

---

### Sprint 7: Community Cards & Pot Polish (Day 5)

**Priority:** 🟡 MEDIUM

#### 7.1 Card Highlight Enhancement

- Increase winning card glow: `0 0 25px rgba(255, 215, 0, 0.8)` (from 0.4)
- Add gold border to winning cards
- Pulsing glow animation on winning cards
- Non-winning board cards dim slightly during showdown

#### 7.2 Pot Animation

- Animate pot number when it changes (tween from old → new)
- Add "ding" sound on pot increase
- Chip stacks in pot visually grow as pot increases
- Side pot separation with distinct colors (amber for side pot 1, blue for side pot 2)

#### 7.3 Board Card Separators

- Fix separator CSS between flop/turn/river (audit found it may not render)
- Add subtle vertical divider line between flop group and turn, turn and river
- Slight gap increase between groups: `gap: 12px` for inter-group vs `gap: 6px` intra-flop

#### 7.4 Run-It-Twice Board Display

- Clear "RUN 1" / "RUN 2" labels above each board
- Staggered card dealing animation for each run
- Show pot split per run visually
- Highlight which run each player won

#### 7.5 Pot Chip Colors

Fix chip denomination colors to match real poker standards:

- White: $1
- Red: $5
- Green: $25
- Blue: $50 (or $10)
- Black: $100
- Purple: $500
- Gold: $1,000+

---

### Sprint 8: Advanced HUD & Analytics (Day 5-7)

**Priority:** 🟠 HIGH — Major competitive differentiator

#### 8.1 Smart Mini-HUD

Create `MiniHUD.tsx` — small stats overlay on each opponent seat:

- **VPIP%** (Voluntarily Put In Pot)
- **PFR%** (Pre-Flop Raise)
- **Hands played** count
- **Run heat** color ring (4 levels: cold blue → warm yellow → hot orange → fire red)
- Toggle on/off in settings
- Data sourced from hand history / session tracking

#### 8.2 Pot Odds Calculator

Show in real-time when it's hero's turn to call:

- "Pot odds: 3.5:1 (22%)"
- "Need 22% equity to call"
- Position it subtly near the call button
- Toggle in settings (advanced mode)

#### 8.3 Equity Display (All-In)

When all-in and cards revealed:

- Show equity % next to each player's cards
- Update live as community cards are dealt
- Animated equity bar that shifts
- Color-coded: green (favored), red (behind)

#### 8.4 Session Statistics Tracker

Enhance existing SessionTimer with:

- Hands played this session
- Win rate (BB/100 or $/hr)
- Biggest pot won/lost
- VPIP/PFR for this session
- Graph of stack over time (mini sparkline)
- Accessible from header menu

#### 8.5 Hand History Panel

Create `HandHistoryPanel.tsx`:

- List of last 50 hands
- Each entry shows: hand #, cards, result, pot size
- Click to expand: full street-by-street replay
- Export button: download as .txt or .json
- Share button: create shareable hand link

---

### Sprint 9: Multi-Table Enhancement (Day 7-8)

**Priority:** 🟡 MEDIUM

#### 9.1 Action Alert System

When another table needs action:

- Tab flashes green → orange → red based on urgency
- Optional sound alert for action needed
- Auto-switch to table when time <5s (already exists — verify working)
- Vibration alert on mobile

#### 9.2 Tile View Mode

Add optional 2x2 tile view for multi-tabling:

- Each table rendered at 50% scale in a 2x2 grid
- Tap a tile to expand to full screen
- Mini action buttons visible in tile view
- Active table highlighted with border

#### 9.3 Keyboard Shortcuts

- `1/2/3/4`: Switch to table 1-4
- `Ctrl+1-4`: Same on desktop
- `Tab`: Cycle to next table
- `Shift+Tab`: Cycle to previous

#### 9.4 Table Info in Tabs

Enhance TableTabBar with:

- Current pot size shown in tab
- Player count at table
- Your current stack
- Game variant icon (H for Hold'em, O for Omaha)

---

### Sprint 10: Mobile Excellence (Day 8-9)

**Priority:** 🟡 MEDIUM — 63% of sessions are one-handed

#### 10.1 Landscape Mode

Add landscape-specific layout:

```css
@media (orientation: landscape) and (max-height: 500px) {
  .table-page {
    flex-direction: row;
  }
  .table-area {
    width: 60%;
  }
  .action-area {
    width: 40%;
    flex-direction: column;
  }
}
```

- Table on left (60%), controls on right (40%)
- Horizontal seat arrangement
- Compact header

#### 10.2 Tablet Layout

For screens ≥768px:

- Larger table with more spacing
- Side panel for chat/stats (instead of overlay)
- Bigger cards, bigger avatars
- Remove `max-width: 420px` constraint on table scaler

#### 10.3 One-Handed Mode

- Bottom-sheet style action panel (swipe up for more options)
- All critical buttons reachable by thumb
- Quick fold gesture: swipe left on cards
- Quick check gesture: double-tap table
- These are optional, toggle in settings

#### 10.4 Fullscreen Mode

- Add fullscreen button in header
- Use `document.documentElement.requestFullscreen()`
- Hide address bar on mobile
- Show custom status bar (time, battery indicator via CSS)

#### 10.5 Touch Target Audit

Ensure all interactive elements meet 44px minimum:

- Header buttons (currently may be 36px)
- Chat emoji buttons
- PreAction toggle buttons
- Slider thumb (must be 44px)
- Raise preset buttons

---

### Sprint 11: Sound System Upgrade (Day 9)

**Priority:** 🟡 MEDIUM — Premium feel

#### 11.1 Audio Sample Hybrid

Replace pure procedural sounds with hybrid approach:

- Record/source high-quality samples for: card deal, chip clink, fold swoosh
- Keep procedural for: timer ticks, UI clicks, win arpeggios
- Encode samples as base64 AudioBuffer (no external files)
- Use Web Audio API nodes for reverb/EQ processing

#### 11.2 Table Ambience

Add subtle background ambience:

- Low-volume "poker room" atmosphere (murmur, chip sounds)
- Optional toggle in settings
- Use AudioBuffer loop with gentle crossfade

#### 11.3 Volume Normalization

- Implement loudness metering across all sounds
- Ensure consistent perceived volume
- Master/Effects/Ambience separate volume sliders in settings

#### 11.4 Audio Context Safety

Add proper error handling:

```typescript
private ensureContext(): boolean {
    if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
        return false;
    }
    return this.ctx.state === 'running';
}
```

#### 11.5 Sound Customization

Let players choose sound packs:

- Classic (current sounds)
- Minimal (soft clicks only)
- Casino (realistic chip/card sounds)
- Silent (all sounds off, haptics only)

---

### Sprint 12: Specialized Component Polish (Day 9-10)

**Priority:** 🟢 LOW — Feature completeness

#### 12.1 Insurance Modal Upgrade

- Render actual card images (not text) for hero/opponent cards
- Add EV calculation: "Expected value of insurance: +$X"
- Larger countdown timer with red urgency when <5s
- Improve equity explanation tooltip

#### 12.2 Run-It-Twice Visual

- "RUN 1" / "RUN 2" header labels
- Staggered card dealing per run
- Show pot split per run with animation
- Color-code winner per run

#### 12.3 Tournament UI Enhancement

- **Break Screen:** Highlight current user in standings, add chip chop calculator
- **Winner Overlay:** Integrate ConfettiCanvas, show prize amount prominently
- **Rebuy Modal:** Visual distinction from addon, show rebuy timer countdown
- **Blind Level Display:** Animated transition when blinds increase

#### 12.4 Table Chat Upgrade

- Replace mixed emoji+text quick buttons with proper SVG icons
- Add player mute option
- Collapsible/expandable chat panel
- Message persistence (last 50 messages in localStorage)
- Profanity filter toggle

#### 12.5 Throwable System Polish

- Replace emoji category icons with SVG icons from ThrowableIcons
- Add preview pane before selection
- Show cost badge on premium throwables
- Improve throw trajectory animation (arc + spin)
- Add sound effects per throwable type

#### 12.6 Time Bank Enhancement

- Pulsing effect when time running low
- "Use Time Bank?" auto-prompt at 3 seconds remaining
- Larger, clearer chip display for remaining banks
- Sound: `soundService.playTimeBankActivated()` already exists — ensure wired

#### 12.7 Leaderboard Enhancement

- Add win rate, hands played, ROI columns
- Mini sparkline graph for trend
- Share/export button
- Highlight current user row

---

### Sprint 13: Architecture Refactor (Day 10-12)

**Priority:** 🟠 HIGH for maintainability — Can be parallelized

#### 13.1 TablePage Decomposition

Split the 3,342-line monolith into:

```
src/pages/TablePage.tsx (200 lines — orchestrator)
src/hooks/
├── useTableGame.ts        — Game state, hand controller, engine
├── useTableWebSocket.ts   — WebSocket connection, reconnect logic
├── useTableActions.ts     — Player action handling, pre-actions
├── useTableModals.ts      — All modal state (buyIn, rebuy, insurance, etc.)
├── useTableSettings.ts    — Sound, theme, animation preferences
├── useTableTimer.ts       — Action timer, time bank, auto-fold
├── useTableChat.ts        — Chat messages, throwables
└── useTableTournament.ts  — Tournament-specific state
src/components/table/
├── TableArea.tsx           — Table surface + seats
├── ControlStrip.tsx        — Timer bar, hand info, session stats
├── ActionArea.tsx          — ActionPanel + PreActionBar
├── ModalContainer.tsx      — All modals rendered together
└── OverlayContainer.tsx    — Tournament overlays, confetti, etc.
```

#### 13.2 State Management with Context

Create `TableContext`:

```tsx
const TableContext = createContext<TableState>(null);
const TableDispatch = createContext<Dispatch>(null);

// In TablePage:
<TableContext.Provider value={state}>
  <TableDispatch.Provider value={dispatch}>
    <TableArea />
    <ActionArea />
    <ModalContainer />
  </TableDispatch.Provider>
</TableContext.Provider>;
```

#### 13.3 CSS Module Migration

Convert scattered CSS files to CSS Modules or structured approach:

- Each component has co-located CSS
- Shared tokens imported from `design-tokens.css`
- No global class name conflicts

---

### Sprint 14: Final Polish & QA (Day 12-13)

**Priority:** 🟢 — Validation

#### 14.1 Cross-Browser Testing

- Chrome (desktop + mobile)
- Safari (desktop + iOS)
- Firefox (desktop + Android)
- Samsung Internet
- Edge

#### 14.2 Performance Profiling

- React DevTools profiler: identify remaining re-render issues
- Lighthouse audit: target >90 performance score
- Chrome Performance tab: verify 60fps during animations
- Memory profiling: ensure no leaks from WebSocket/AudioContext

#### 14.3 Accessibility Audit

- Screen reader testing with VoiceOver/NVDA
- Keyboard navigation through all controls
- Color contrast ratio ≥ 4.5:1 for all text
- `aria-label` on all interactive elements
- Focus indicators visible

#### 14.4 E2E Visual Regression Tests

- Screenshot comparison for each theme
- Mobile and desktop viewport sizes
- All modal states
- Animation states (deal, showdown, win)

---

## IMPLEMENTATION ORDER (RECOMMENDED)

| Day       | Sprint         | Focus                                 | Effort        |
| --------- | -------------- | ------------------------------------- | ------------- |
| 1         | Sprint 1       | Critical bug fixes                    | 4 hours       |
| 1-2       | Sprint 2       | Performance optimization              | 6 hours       |
| 2-3       | Sprint 3       | CSS design system + visual foundation | 8 hours       |
| 3         | Sprint 4       | Theme system (6 themes)               | 4 hours       |
| 3-4       | Sprint 5       | Action panel premium upgrade          | 6 hours       |
| 4-5       | Sprint 6       | Seat display polish                   | 6 hours       |
| 5         | Sprint 7       | Community cards & pot polish          | 4 hours       |
| 5-7       | Sprint 8       | HUD & analytics (biggest feature)     | 12 hours      |
| 7-8       | Sprint 9       | Multi-table enhancement               | 6 hours       |
| 8-9       | Sprint 10      | Mobile excellence                     | 8 hours       |
| 9         | Sprint 11      | Sound system upgrade                  | 4 hours       |
| 9-10      | Sprint 12      | Specialized component polish          | 6 hours       |
| 10-12     | Sprint 13      | Architecture refactor                 | 12 hours      |
| 12-13     | Sprint 14      | Final QA & polish                     | 8 hours       |
| **TOTAL** | **14 Sprints** | **Complete premium experience**       | **~94 hours** |

---

## FILE CHANGE MAP

| File                                                | Changes                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `src/pages/TablePage.tsx`                           | Decompose into hooks + sub-components, memoization                |
| `src/pages/TablePage.css`                           | Design tokens, z-index fix, landscape, tablet, felt texture       |
| `src/components/table/SeatSlot.tsx`                 | React.memo, lazy avatar, stack color, sitting-out badge           |
| `src/components/table/SeatSlot.css`                 | Safari timer fix, design tokens, position chip 3D, status borders |
| `src/components/table/ActionPanel.tsx`              | Bet counter anim, preset amounts, all-in confirm, gesture support |
| `src/components/table/ActionPanel.css`              | Firefox slider fix, modern shadows, disabled state, design tokens |
| `src/components/table/PreActionBar.tsx`             | Add Check/Call and Fold-to-Any options                            |
| `src/components/table/CommunityCards.tsx`           | React.memo, highlight enhancement                                 |
| `src/components/table/CommunityCards.css`           | Separator fix, glow increase, design tokens                       |
| `src/components/table/PotDisplay.tsx`               | React.memo, animated numbers, standard chip colors                |
| `src/components/table/ChipAnimation.tsx`            | Integration with pot updates                                      |
| `src/components/table/TableTabBar.tsx`              | Pot, stack, player count in tabs, action alerts                   |
| `src/pages/MultiTablePage.tsx`                      | Tile view mode, keyboard shortcuts                                |
| `src/services/SoundService.ts`                      | Audio samples, ambience, normalization, error handling            |
| `src/components/table/SettingsPanel.tsx`            | Theme selector, card backs, animation speed, sound pack           |
| **NEW** `src/styles/design-tokens.css`              | Complete design token system                                      |
| **NEW** `src/components/table/ThemeSelector.tsx`    | 6-theme selector with preview                                     |
| **NEW** `src/components/table/CardBackSelector.tsx` | Card back design picker                                           |
| **NEW** `src/components/table/MiniHUD.tsx`          | VPIP/PFR/heat overlay per seat                                    |
| **NEW** `src/components/table/PotOddsDisplay.tsx`   | Real-time pot odds calculator                                     |
| **NEW** `src/components/table/EquityDisplay.tsx`    | All-in equity percentages                                         |
| **NEW** `src/components/table/HandHistoryPanel.tsx` | Hand history list + export                                        |
| **NEW** `src/hooks/useTableGame.ts`                 | Extracted game state hook                                         |
| **NEW** `src/hooks/useTableActions.ts`              | Extracted action handling hook                                    |
| **NEW** `src/hooks/useTableModals.ts`               | Extracted modal state hook                                        |
| **NEW** `src/hooks/useTableTimer.ts`                | Extracted timer hook                                              |
| **NEW** `src/hooks/useTableSettings.ts`             | Extracted settings hook                                           |
| **NEW** `src/contexts/TableContext.tsx`             | Table state context provider                                      |

---

## SUCCESS METRICS

| Metric                  | Current       | Target                 |
| ----------------------- | ------------- | ---------------------- |
| Lighthouse Performance  | ~70           | 90+                    |
| Time to Interactive     | ~3s           | <1.5s                  |
| Animation Frame Rate    | 45fps avg     | 60fps consistent       |
| Re-renders per action   | ~15           | <5                     |
| CSS Bundle Size         | ~2000 lines   | ~1200 lines            |
| TablePage.tsx Lines     | 3,342         | <200 (+ hooks)         |
| Cross-browser bugs      | 3 critical    | 0                      |
| Touch target compliance | ~70%          | 100% (44px min)        |
| Theme options           | 1 (dark)      | 6                      |
| Sound variety           | 15 procedural | 20+ (hybrid)           |
| HUD stats               | 0             | VPIP/PFR/heat/pot odds |
| Responsive breakpoints  | 3             | 7                      |

---

## COMPETITIVE ADVANTAGE AFTER PHASE 4

After completing all 14 sprints, Club Arena will surpass competitors in:

1. **Theme variety** — 6 themes vs PokerBros' 6 (parity) + light mode (unique)
2. **HUD analytics** — VPIP/PFR/heat + pot odds + equity (matches ClubGG Smart HUD)
3. **Animation quality** — Hybrid sounds + CSS animations + Canvas confetti
4. **Mobile UX** — Landscape support + one-handed gestures + fullscreen (exceeds all three)
5. **Performance** — React.memo + lazy loading + will-change = 60fps butter smooth
6. **Architecture** — Clean hooks + context = maintainable and extensible
7. **Accessibility** — prefers-reduced-motion + high contrast + keyboard nav (unique advantage)
8. **Multi-table** — Tile view + keyboard shortcuts + action alerts (exceeds PokerBros)

**Final Rating Projection: 95/100** — Premium poker table experience that competes with or exceeds the $100M+ budget apps.
