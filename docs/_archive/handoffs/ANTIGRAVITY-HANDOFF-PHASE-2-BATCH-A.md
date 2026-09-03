# AntiGravity Handoff — 2026-04-14 — Phase 2 Batch A (T1-02, T1-08, T1-03, T1-05)

## Context

PokerBros parity batch — four spec items shipped together in one commit because they all touch the action-side UX on TablePage / ActionPanel / PreActionBar. Client `npx tsc --noEmit` exits **0**. Vite build in staging dir produced fresh `TablePage-xPN9odZp.js` (307kB) + `index-D8p9Ewd5.js` (328kB) in 5.71s.

**Stack order:** Run after the three prior handoffs (NO-GO-2 client, NO-GO-3, Phase 1.3 PR-C+D) are pushed and live. This batch is purely client-side — no server, no schema, no API change.

## What changed

### T1-02 Vertical bet slider (spec §5.2)

`src/components/table/ActionPanel.tsx`

- New `verticalSlider?: boolean` prop, defaults to `true` (spec-compliant on by default).
- Preset row swaps preflop vs postflop based on `isPreflop` prop:
  - Preflop: `2X` / `3X` / `4X` (BB multipliers)
  - Postflop: `1/2 POT` / `2/3 POT` / `POT`
- Raise-mode JSX restructured into a 2-column flex layout (`raise-layout` → `raise-main` left + `raise-slider-vertical` right). Slider shares one element via `sliderEl` so the horizontal-fallback and vertical variants stay in lockstep on min/max/step/aria.
- Vertical slider uses Firefox-native `orient="vertical"` + WebKit/Blink CSS rotation fallback. Tick marks at 25/50/75/100% of legal range. Caps show `min` (bottom) and `maxRaise` (top).

`src/components/table/ActionPanel.css`

- New `.action-panel--raise-vertical`, `.raise-layout`, `.raise-main`, `.raise-slider-vertical*` rules (~120 lines).
- Mobile (<768px) media query collapses the rail back inline above presets.

### T1-08 Pre-action toggles (spec §5.3 + §5.4)

`src/components/table/PreActionBar.tsx`

- New `<ToggleDot active>` component renders the spec-required circular dot **above** the label (was inline ✓ glyph beside label).
- New swipe-gesture handler (`onPointerDown` / `onPointerUp` on bar root): horizontal drag ≥ 40px steps the active toggle to the adjacent slot in the visible-button order. Swipe left = next, swipe right = previous. Edge-stop at the row ends.
- Visible-order array is computed from `canCheck` + `currentBet > 0` so the swipe respects whether the middle slot is `Check` or `Call <amount>`.

`src/components/table/PreActionBar.css`

- `.pre-action-btn` switched to `flex-direction: column` so the dot stacks above the label.
- `touch-action: pan-y` lets the parent intercept horizontal pans without blocking vertical scroll.
- New `.pre-action-btn__dot` + `--on` styles, plus per-action color overrides (red/green/amber/amber).
- Old `.pre-action-btn__check` left as no-op tombstone (no markup produces it anymore).

### T1-03 Tappable bet amount → numeric keyboard (spec §5.2)

`src/components/table/ActionPanel.tsx`

- New state: `amountTyping` (boolean) + `amountDraft` (string) + `amountInputRef`.
- `beginEditAmount`: focus + select the new `<input inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*">` on next paint so iOS/Android pop the numeric keypad.
- `commitAmountEdit`: parse cleaned input (strips `$`, `,`, whitespace), clamp via `roundToChip(...)` into `[minRaise, maxRaise]`. The all-in cap is implicit — `maxRaise` IS the all-in amount per the engine. Sub-min snaps to min.
- `cancelAmountEdit`: Escape key abandons changes.
- The amount display is now a `<button>` (keyboard focusable). Tapping swaps to the input.

`src/components/table/ActionPanel.css`

- `.raise-value__amount` reset to button chrome (transparent, no border/padding) but keeps gold typography.
- `:focus-visible` outline.
- New `.raise-value__input` styled to mirror the button's footprint so layout doesn't jump on swap.

### T1-05 Chip ship animation (spec §6 Pot Shipping Animation)

`src/pages/TablePage.tsx`

- `POT_WIN` event handler in the engine event router used to only play a sound. Now also dispatches a fan of 6-8 staggered chips on a quadratic-bezier arc per winner via the existing `createPotToWinnerEvent` helper from `ChipAnimation.tsx`.
- For chopped pots: split `potAmount` evenly across `winnerIds` and fire one chip-fan per winner.
- Resolves each winner's seat from `tableStateRef.current.players` (uses `SeatPlayer.id` which is the userId).
- Uses screen px (window.innerWidth/Height × seat percentages) so the fan lands on each winner's avatar regardless of viewport.

The receiving manager (`ChipAnimationManager` mounted in TablePage at line 5478) already supports the new events without changes — the spec compliance was missing only on the producer side.

## Step 1: Pull the prior commits

```bash
cd ~/Documents/club-arena
git pull origin main
```

HEAD should be the Phase 1.3 PR-C+D commit before proceeding.

## Step 2: Client typecheck

```bash
cd ~/Documents/club-arena
npx tsc --noEmit
```

Must exit 0.

## Step 3: Sanity grep

```bash
cd ~/Documents/club-arena/src

# T1-02: verticalSlider prop + raise-slider-vertical class wired
grep -c 'verticalSlider' components/table/ActionPanel.tsx
# Expect 4+ (interface, default, layout class, conditional)
grep -c 'raise-slider-vertical' components/table/ActionPanel.css
# Expect ~10+ (selector + media query overrides)

# T1-08: toggle dot + swipe handler
grep -c 'ToggleDot' components/table/PreActionBar.tsx
# Expect 5 (1 fn def + 4 usages)
grep -c 'onPointerDown\|onPointerUp' components/table/PreActionBar.tsx
# Expect 4 (decl + usages)
grep -c 'pre-action-btn__dot' components/table/PreActionBar.css
# Expect 6+ (base + --on + 4 per-action overrides)

# T1-03: tap-to-type
grep -c 'amountTyping\|beginEditAmount\|commitAmountEdit' components/table/ActionPanel.tsx
# Expect 8+
grep -c 'raise-value__input' components/table/ActionPanel.css
# Expect 3+

# T1-05: chip ship on POT_WIN
grep -nA 5 "case 'POT_WIN'" pages/TablePage.tsx | head -20
# Should reference createPotToWinnerEvent + setChipAnimations
```

## Step 4: Vite build

```bash
cd ~/Documents/club-arena
rm -rf dist
npm run build
ls -la dist/assets/TablePage-*.js dist/assets/index-*.js
```

TablePage chunk should be ~307KB (slightly larger than the Phase 1.3 PR-C+D bundle due to the new code paths). `index-` bundle hash will change too.

## Step 5: Commit

```bash
cd ~/Documents/club-arena
git add -A
git commit -m "Phase 2 Batch A (T1-02, T1-08, T1-03, T1-05): PokerBros parity UX

Four spec items in one commit because they all touch the action-side UX:

T1-02 — Vertical bet slider on right side per spec §5.2
- ActionPanel.tsx: new verticalSlider prop (default true), raise-mode JSX
  restructured into 2-col flex (main left, slider rail right). Single
  sliderEl so horizontal fallback + vertical variant share min/max/step/aria.
- Preset row swaps preflop (2X/3X/4X BB) vs postflop (1/2 POT, 2/3 POT, POT)
  based on existing isPreflop prop fed from engine snapshot board state.
- ActionPanel.css: ~120 new lines for vertical layout + Firefox-native
  orient='vertical' + WebKit CSS-rotate fallback + tick marks + min/max caps.
- Mobile (<768px): rail collapses inline above presets so it doesn't extend
  off-screen on narrow phones.

T1-08 — Pre-action toggle dot ABOVE label + swipe gesture per spec §5.3 + §5.4
- PreActionBar.tsx: replaced inline check glyph with <ToggleDot active>
  component. Bar root now handles pointerdown/pointerup; horizontal drag
  ≥ 40px steps active toggle in visible-button order (left/right/edge-stop).
  Visible-order array respects canCheck + currentBet > 0 so swipe behaves
  correctly whether middle slot is Check or Call <amount>.
- PreActionBar.css: button switched to flex-column. New .pre-action-btn__dot
  + --on styles plus per-action color overrides (red/green/amber/amber).
  touch-action: pan-y lets parent intercept horizontal pans without
  blocking vertical scroll. Old .__check rules left as tombstone no-ops.

T1-03 — Tappable bet amount → numeric keyboard per spec §5.2
- ActionPanel.tsx: amount span replaced with <button> that swaps to
  <input inputMode='decimal' pattern='[0-9]*[.,]?[0-9]*'>. Focus + select
  on next paint so mobile keypads pop. Commit on Enter or blur — parse,
  strip $/comma/whitespace, clamp to [minRaise, maxRaise] via roundToChip.
  Over-stack auto-caps (maxRaise IS all-in). Sub-min snaps to min. Esc
  cancels.
- ActionPanel.css: button reset to transparent chrome. New .raise-value__input
  styled to mirror the button footprint so layout doesn't jump on swap.

T1-05 — Pot shipping curved-arc animation per spec §6
- TablePage.tsx POT_WIN handler: was sound-only. Now resolves each winner's
  seat from tableStateRef.current.players, splits potAmount across winners
  for chops, fires createPotToWinnerEvent for each (helper already produces
  a fan of 3-8 staggered chips on a quadratic-bezier arc, 600ms duration —
  spec match). Events appended to setChipAnimations; existing
  ChipAnimationManager mount at line 5478 renders without changes.

Verification:
- npx tsc --noEmit: exit 0
- vite build: 5.71s, fresh TablePage-xPN9odZp.js (307KB) + index-D8p9Ewd5.js (328KB)
- Producer-side grep (POT_WIN createPotToWinnerEvent): 1 hit
- Static checks: ToggleDot 5 hits, verticalSlider 4 hits, amountTyping 8+ hits"
git push origin main
```

## Step 6: World Hub bundle sync + push

```bash
cd ~/Documents/club-arena
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub

cd ~/Documents/Smarter-Poker-World-Hub
npx tsc --noEmit
bash scripts/git-safe-push.sh "Phase 2 Batch A bundle: vertical slider + dot toggles + numeric keypad + pot shipping"
```

## Step 7: Hub-vanguard deploy hook (if Vercel doesn't auto-deploy in 60s)

```bash
curl -X POST "https://api.vercel.com/v1/integrations/deploy/prj_op66GkZyZcygXQKm76iyycfVFAQx/Tw4O1eDeVc"
```

## Step 8: Live verification

After Vercel reports READY, sit down at a real (or test) table:

1. **T1-02:** Tap Raise. Slider rail should appear on the right edge in
   desktop view (collapsed inline above presets on <768px width). Drag the
   thumb from bottom (min) to top (all-in). Preflop should show 2X/3X/4X;
   postflop should show 1/2 POT, 2/3 POT, POT.
2. **T1-08:** When NOT your turn, you should see three pill toggles with a
   small empty circle ABOVE each label. Tap one — circle fills with the
   per-action color (red/green/amber). Swipe left across the bar — selection
   moves right by one slot. Swipe right — selection moves left. Edge stops.
3. **T1-03:** While Raise is open, tap the gold amount number. Numeric
   keypad pops on mobile (desktop: text input focused, digits accepted).
   Type a value > your stack — should auto-cap to all-in. Type < min —
   should snap to min. Press Enter or tap outside to commit.
4. **T1-05:** Stay through a showdown. When pot is awarded, a fan of 6-8
   gold chips should arc from the pot center to each winner's seat over
   ~600ms (multiple winners on a chop = multiple fans). Sound still plays.

## Step 9: Log Phase 2 Batch A in after-action log

Append to `~/Documents/Smarter-Poker-World-Hub/.memory/context/after-action-log.md`:

```
## Phase 2 Batch A — 2026-04-14 — PokerBros parity UX shipped

### Atomic units
- T1-02: vertical bet slider right-side + preflop/postflop preset swap
- T1-08: pre-action toggle dot ABOVE label + horizontal swipe gesture
- T1-03: tap-to-edit numeric keyboard for exact bet amount
- T1-05: pot shipping curved-arc chip fan on POT_WIN

### Ship
- Commit CA <SHA>: ActionPanel.tsx/css, PreActionBar.tsx/css, TablePage.tsx
  (POT_WIN handler).
- Commit WH <SHA>: bundle sync.
- Hub-vanguard deploy: live index hash <hash>.
- Spot-check on real table confirmed all 4 items render + behave per spec.

### Verification
- client tsc: exit 0
- vite build: 5.71s
- 4 sanity greps all return expected counts
- live bundle hash spot-check: matches dist
```

## Next task queued

Load test 50 tables. The platform now has:

- Single-engine WS authoritative state (NO-GO-2)
- DeadlineScheduler as sole timer authority (NO-GO-3)
- Server-rejection toast UX (Phase 1.3 PR-C+D)
- Spec-compliant action-side UX (Batch A)

Time to confirm 50 concurrent tables still hold under realistic action +
disconnect + rejoin churn.
