# Club Arena — Animation Pacing, Collision Sweep, and the `winners` Regression (2026-08-20)

Two things happened today and they belong in one record, because the second was
caused by the first.

1. A multi-pass audit made every gameplay animation actually play out, and
   removed an entire class of CSS bug from the codebase.
2. One of those changes introduced a **production data regression** that ran for
   ~3 hours before I caught it in self-review. That post-mortem is Section 5 and
   is the most important part of this document.

---

## 1. The bug class: "superseded in its own tick"

Dan, watching a live table: *"every player's action MUST GO IN TURN... their
action MUST BE DISPLAYED, an animation MUST PLAY after every decision. NO action
for any horse or player can EVER be skipped or rushed."*

The root pattern: **an event is emitted and immediately superseded by the next
event in the same synchronous tick, so its animation never gets airtime.** Seven
instances were found and fixed.

| Moment | Was | Now |
|---|---|---|
| Any action → next player on the clock | same tick | `actionSettleMs` 650ms |
| Queued pre-action | fired at **0ms** | `preActionVisibleMs` 900ms |
| Board dealt → next actor | same tick | `streetSettleMs` 1400ms |
| Hand dealt → first action | same tick | `handStartSettleMs` 1500ms |
| Showdown → pot ship | same tick | `showdownSettleMs` 1600ms |
| ALL-IN banner (1800ms) vs first runout card | 1000ms | `allInFirstPauseMs` 2000ms |
| Bad Beat Jackpot celebration (~9s) | **no pause at all** | `BBJ_CELEBRATION_MS` 9000ms |

The key design decision: **every action path in the engine — human submit, horse
think-timer, queued pre-action, turn timeout, time-bank expiry, disconnect
auto-action — ends by advancing the turn, and they all funnel through the
`TURN_CHANGE` event.** One settle there paces all of them and no individual
caller can bypass it. `streetSettleMs` / `handStartSettleMs` reuse that same
point via timestamps stamped in the `COMMUNITY_CARDS` and `BLINDS_POSTED`
handlers.

Also: horse think-time **floor** raised 700ms → 1800ms → 2200ms. There was never
a horse-only fast path in the engine; the floor was simply below the length of
the animations an action has to show (cpSlideIn 500ms, cardFoldOut 380+55ms).

**Measured effect in production:** hands/min fell from ~200 → ~85-120. That is
the intended trade — Dan: *"focus more on the user experience rather than
getting more hands dealt."*

---

## 2. Dead and silent animations

- **The winning-hand card pop had NEVER fired.** `CommunityCards` computed
  `highlightPop` and applied `community-cards__container--highlight-pop` to the
  container; the stylesheet only ever defined
  `.community-cards__card--highlight-pop` (**card**, not container), whose own
  comment reads "applied via JS". Nothing matched. Now applied to the
  highlighted cards. Its JS window was also 400ms against a 500ms keyframe.
- **The street chip sweep played in silence** — 550ms of every bet sliding into
  the pot, no sound. Now cued.
- **The losers' muck at showdown played in silence.** Now cued.

---

## 3. Global `@keyframes` collisions

`@keyframes` is a **global** namespace. Two stylesheets defining the same name
with different bodies means load order silently decides which animation plays,
for BOTH consumers, with no warning.

Gameplay casualties found:
- `screenShake` — TablePage's big-win shake vs ThrowAnimation's, which is built
  on `var(--impact-shake-intensity)`, defined only in ITS scope. When
  ThrowAnimation won, `.table-page--shake` resolved an undefined variable inside
  `translate()/calc()` → **invalid transform → no shake at all on a 50BB+ win.**
- `card-deal` — CardImage vs club-engine, materially different transforms.
- `winnerAvatarGlow` — SeatSlot's (1.2s) vs common/Avatar's (2s infinite).

Then swept the whole app: **44 differing duplicates → 0**, across 772 keyframes.
Method: group by keyframe BODY; the **largest** group keeps the canonical name
(several files consume a name without defining one — `TipDealer`, `FAQPanel`,
`PlayerNotes`, `HandReplayerPage`, `RewardsMarketplace` — so they now resolve
deterministically instead of by load-order lottery); every **minority**
definition renamed to an owner-scoped name with its in-file consumers. Diff was
251 insertions / 251 deletions — a pure rename.

---

## 4. Verification harnesses (permanent)

- `server/src/engine/ActionPacing.test.ts` — 19 assertions on the pacing
  constants and their ordering. Written because this damage is **invisible to
  every other test**: the chips still end up in the right place.
- `tests/components/GameplayAnimations.simulation.test.tsx` — 42 simulations
  across 20 animations; each asserts it TRIGGERS, its SOUND fires, and it is not
  suppressed. Includes horse-parity cases.
- `tests/e2e/live-animations.spec.ts` — real Chrome against the LIVE production
  CSS, reading `document.getAnimations()` after each beat of a full hand. jsdom
  cannot prove an animation plays or for how long; this can.

**Horse parity is structural:** `SeatSlot` never receives an `isHorse` prop, so
a horse cannot be rendered differently from a human.

---

## 5. POST-MORTEM: the `winners` regression (READ THIS)

### What broke
`hand_history.winners` was empty for **~52% of hands over ~3 hours**
(13:00–16:04 UTC). Baseline before: **0.00% for 29 straight hours.**

### Root cause — mine
`handleHandEvent` is dispatched **fire-and-forget**
(`void this.handleHandEvent(...)` in `ServerTableEngineDealing`), and
`HandController.completeHandInner()` emits `WINNERS` and `HAND_COMPLETE`
back-to-back in the **same synchronous call**.

I placed `await this.sleep(showdownSettleMs)` at the **top** of the `WINNERS`
case — *before* the winner state is assigned. The instant that handler
suspended, the `HAND_COMPLETE` handler overtook it and ran to completion first.
`HAND_COMPLETE` reads `currentHandWinnerIds` for the hand_complete payload, the
payouts, the BBJ evaluation and the 7-2 bounty — and for 1600ms those held the
previous hand's values.

**A purely cosmetic pause became a state-ordering hazard.**

### Blast radius (checked, not assumed)
- **Money: unaffected.** Chip payouts happen inside `HandController` via
  `applyStackDeltas`, independent of this engine-level state. Rake and average
  pot size were normal throughout; BBJ paid at a normal rate (12.9% of hands in
  the window vs 10.8% before).
- **Damage: the history record.** ~10k hands with an empty `winners` column.
  Dan's call: **test data, leave it.** Not backfilled by decision, recorded here
  so anyone who finds the hole knows its cause and its exact window.

### The fix
The settle is purely **visual**, so it belongs immediately before the `pot_win`
broadcast that actually moves the chips — not before the state commit. Order is
now, by source position in `ServerTableEngineHandEvents.ts`:

```
:515  this.currentHandWinnerIds = ...     <- state commits synchronously
:620  await this.sleep(showdownSettleMs)  <- visual beat
:630  emitEvent({ type: 'pot_win' })      <- chips move
```

### Recovery, verified
`16:05 → 16:42`: **3,487 hands, 0 missing winners (0.00%)**, BBJ and rake
normal.

### Guard
`ActionPacing.test.ts` gains a test asserting that ORDER by source position
(assign < settle < pot_win). It was confirmed to genuinely catch this — it
**FAILED against the shipped code** and passes after the fix.

### THE LESSON FOR THE NEXT AGENT
> **In this engine, an `await` inside an event handler does not just delay that
> handler — it lets every later event overtake it.** Handlers are dispatched
> fire-and-forget and are NOT serialized. Any pause you add must sit *after*
> everything it could reorder. Before adding an `await` to a handler, find every
> piece of state written below it and every later event that reads that state.

My read-only sweeps (collision scans, wiring scans, sound coverage) were safe by
construction. This was the one change that altered control flow in a
money-adjacent path, and I should have traced the dispatch model *before* adding
the pause rather than after.

---

## 6. Known remaining work (not done, deliberately)

Ordered by user impact:

1. **Three extra `AudioContext`s**, one created **per table mount**
   (`useTabKeepAlive`). Chrome caps ~6 per document, so **4+ simultaneous tables
   can exhaust them and silence all audio.** Highest-impact item left.
2. **Hero card wrapper breaks `:nth-child`** sizing for PLO4/5/6 hole cards
   (pre-existing, from the per-card show feature).
3. **~17 double-firing haptics**; **three inconsistent haptic implementations**,
   two of which ignore the in-table vibration toggle; **two competing writers**
   for sound mute (settings panel can silently undo a table mute).
4. `playThrowableImpact` fires at launch, not impact (~1s early).
5. `MilestoneToast` plays the time-bank chime instead of `playAchievement`.
6. RIT per-board equity; 3 orphan keyframes (`activeAvatarPulse`,
   `announcePulse`, `spectatorFloating` — all from removed features); bomb-pot
   announcement pacing (unreachable: 0 tables have `bomb_pot_enabled`).
7. **Not verifiable by me:** whether the pacing *feels* right in a seated
   session. Every value is a named constant and trivially retunable.
