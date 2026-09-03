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

Dan, watching a live table: _"every player's action MUST GO IN TURN... their
action MUST BE DISPLAYED, an animation MUST PLAY after every decision. NO action
for any horse or player can EVER be skipped or rushed."_

The root pattern: **an event is emitted and immediately superseded by the next
event in the same synchronous tick, so its animation never gets airtime.** Seven
instances were found and fixed.

| Moment                                      | Was                 | Now                         |
| ------------------------------------------- | ------------------- | --------------------------- |
| Any action → next player on the clock       | same tick           | `actionSettleMs` 650ms      |
| Queued pre-action                           | fired at **0ms**    | `preActionVisibleMs` 900ms  |
| Board dealt → next actor                    | same tick           | `streetSettleMs` 1400ms     |
| Hand dealt → first action                   | same tick           | `handStartSettleMs` 1500ms  |
| Showdown → pot ship                         | same tick           | `showdownSettleMs` 1600ms   |
| ALL-IN banner (1800ms) vs first runout card | 1000ms              | `allInFirstPauseMs` 2000ms  |
| Bad Beat Jackpot celebration (~9s)          | **no pause at all** | `BBJ_CELEBRATION_MS` 9000ms |

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
the intended trade — Dan: _"focus more on the user experience rather than
getting more hands dealt."_

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
case — _before_ the winner state is assigned. The instant that handler
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
> fire-and-forget and are NOT serialized. Any pause you add must sit _after_
> everything it could reorder. Before adding an `await` to a handler, find every
> piece of state written below it and every later event that reads that state.

My read-only sweeps (collision scans, wiring scans, sound coverage) were safe by
construction. This was the one change that altered control flow in a
money-adjacent path, and I should have traced the dispatch model _before_ adding
the pause rather than after.

---

## 6. Section 6 is now CLOSED

Every item that was open here has been fixed and is live. Kept as a record of
what was found and what each one actually turned out to be.

| #   | Item                                        | Outcome                                        |
| --- | ------------------------------------------- | ---------------------------------------------- |
| 1   | AudioContext exhaustion                     | **Fixed** — Section 7                          |
| 2   | Hero card wrapper broke PLO4/5/6 sizing     | **Fixed** — Section 8                          |
| 3   | Haptics: double-fires + ignored toggle      | **Fixed** — Section 9                          |
| 4   | Two competing writers for sound mute        | **Fixed** — Section 9                          |
| 5   | `playThrowableImpact` fired at launch       | **Fixed** — Section 10                         |
| 6   | `MilestoneToast` played the time-bank chime | **Fixed** — Section 10                         |
| 7   | RIT per-board equity                        | **Fixed** — Section 10                         |
| 8   | 3 orphan keyframes                          | **1 was real.** Section 10                     |
| 9   | Bomb-pot pacing                             | Unreachable — 0 tables have `bomb_pot_enabled` |

Still not verifiable by me: whether the pacing _feels_ right in a seated
session. Every value is a named constant and trivially retunable.

## 7. FIXED: AudioContext exhaustion could silence a 4-table session

Every fix above is about making sounds play. This one is about them being
**able** to play at all, so it outranked the rest of Section 6.

### The arithmetic

Chrome caps concurrent `AudioContext`s at **6 per document** and throws
`NotSupportedError` on the 7th. Club Arena's real ceiling was **7**:

| Consumer                                     | Count                                | When created                         |
| -------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `useTabKeepAlive` (silent anti-throttle osc) | **1 per mounted TablePage, up to 4** | eagerly, on table open               |
| `SoundService`                               | 1                                    | **at module import** — always exists |
| `PremiumSFX`                                 | 1                                    | lazily, first premium cue            |
| `VoiceRecorder`                              | 1                                    | lazily, voice message                |

The per-table multiplier is not hypothetical: `MAX_TABLES = 4` and
`PersistentTableLayer` deliberately keeps **every** TablePage mounted so each
`EngineStateClient` socket stays live.

### Why the failure mode was so bad

The keepalive contexts are created **eagerly** at table open; SoundService's is
eager at import but `PremiumSFX` and `VoiceRecorder` build **lazily**. So the
lazy ones lose the race and the observable symptom is not "keepalive stopped
working" — it is **the table going silent**, exactly what all the sound work
above exists to prevent. Table churn made it worse: `ctx.close()` is async, so
rapidly closing and reopening tables pushed the live count transiently higher
still.

### Fix

The keepalive context's job is _"keep THIS TAB unthrottled"_ — a
**per-document** concern, not a per-table one. Four of them accomplish nothing
that one does. Both the context and the keepalive Worker are now **refcounted
module singletons**: first mount creates, last unmount tears down, with a
`heldRef` so StrictMode's double-invoke cannot leak a count.

Ceiling: **7 → 4**. Permanently clear of the cap even with voice messages.

Also fixed alongside: every keepalive table open leaked a blob URL for the life
of the document (`createObjectURL` with no matching revoke, in both the
keepalive worker and the timer worker). Now revoked immediately after
construction — the Worker keeps its own handle.

Construction failure is deliberately non-fatal: if the cap is somehow reached
anyway, the tab keeps its Worker-based throttle protection, which is what
actually guards horse think-timers.

### Guard

`tests/hooks/useTabKeepAlive.test.tsx` — 6 tests with a fake AudioContext that
**enforces the real cap of 6 and throws the real `NotSupportedError`**.
Confirmed to catch the regression: against the pre-fix code **4 of 6 fail**,
`expected 4 to be 1`, and the cap test reproduces the live DOMException. All 6
pass after the fix. Full client suite: 181 passed, `tsc --noEmit` 0 errors.

---

## 8. FIXED: the hero card row, and why a wrapper broke it silently

PLO6 rendered **264px wide against an intended 159px** — 66% too wide, running
off a 341px felt. The failure is worth recording because nobody wrote a bug:

The row is sized `w + (n-1) * step`, which was correct only while `.seat__card`
**was the flex child**. The per-card "show this after the hand" feature wrapped
every hero card in a `<span class="seat__card-pick">`, and that broke both
halves of the layout without touching one line of CSS:

1. `.seat__card:first-child` began matching **every** card — each is now the
   only child of its own wrapper — so the negative margin was cancelled on all
   of them and the overlap vanished entirely.
2. `:has(.seat__card:nth-child(4|5|6))` stopped matching **anything**, so
   PLO4/5/6 never got their reduced tokens and fell back to the 44px heads-up
   size.

The wrapper's own comment reads _"Keep the hero fan geometry identical to
before the wrapper existed."_ The intent was right; the mechanism could not
deliver it, and nothing failed loudly enough to say so.

**Fix:** geometry is written against `> *` — the row's child, whatever element
that happens to be. Six dead `transform: none` guards keyed to `:first-child`
and `:nth-child(2..6)` collapsed into the single rule they all shared.

**Guard:** `tests/components/HeroCardRowGeometry.test.tsx` (7). A CSS-source
test on purpose — jsdom implements neither `:has()` nor custom properties, so a
render test would have passed against the broken stylesheet.

---

## 9. FIXED: one gate for sound, one for vibration

Two settings, six implementations, and **neither switch actually worked**.

### Vibration — 6 implementations, 3 ignoring the switches

`utils/haptic` honoured NEITHER key. `HapticService` honoured only one.
`NumericKeypad`, `CashoutRequestModal` and `DepositWithdrawModal` each carried
a **private copy** calling `navigator.vibrate` directly. With two switches in
the UI (`vibrationsEnabled`, `ca_vibration_enabled`), whether "off" worked
depended on which switch you used and which code path happened to fire.

**Also: 16 sites double-fired.** Each calls an explicit haptic AND a
`soundService.play*()`, and every play method ends with its own haptic.

Deleting the explicit calls was the obvious fix and would have been **wrong**:
the internal haptic sits _after_ `shouldPlay()`, so it is silently coupled to
sound — muting sound would have taken vibration with it. The explicit calls are
what keep haptics alive for someone who plays muted. So both stay, and
`src/utils/vibrationGate.ts` coalesces a 60ms window with the **stronger**
intent winning.

### Sound — two switches, neither muted the app

Settings writes `club_arena_sounds`, read only by PremiumSFX, and **never calls
`setEnabled`** — so the main engine (every card, chip, fold, all-in and pot
sound) kept playing. The in-table toggle calls `setEnabled` but PremiumSFX
never reads its key, so premium cues kept playing. And `useTableSound`
re-applies its key on every mount, so opening a table silently undid a mute set
in Settings.

`src/utils/soundGate.ts`: either switch off silences everything, and
`setEnabled` persists both keys so they cannot drift. Removed a third key,
`table_sound_muted`, which TableMenu read and nothing has ever written.

**Guard:** `tests/utils/vibrationGate.test.ts` (14).

---

## 10. FIXED: sounds that described the wrong moment

- **Throwable impact fired at LAUNCH**, ~1200ms before the object hit anything
  — and from the _picker_, which only the sender opens, so every other player
  watched it land in silence. Impact moved into `FlyingEmoji` (renders for
  everyone) 60ms before the flight ends; the launch gets a new rising whoosh.
- **`MilestoneToast` played `playTimeBankActivated`** — the urgent chime that
  means your clock ran out. Your own stress cue at the moment you unlock an
  achievement; at a table it reads as an alarm for a hand you are not in.
- **RIT showed boards and payouts but never connected them.** Each run now
  shows what it was worth, derived (equal slice, divided again on a split,
  floored per winner so the parts can never exceed the pot).
- **Orphan keyframes: 1 of 3 was real.** `announcePulse` was genuinely unused.
  `activeAvatarPulse` is used in `Avatar.css`, and `spectatorFloating` is
  applied via an **inline style** in `SpectatorBadge.tsx` — invisible to any
  scan reading only `.css` files. Deleting either would have silently killed a
  live animation. **A CSS-only search is not proof of an orphan.**

---

## 11. NEW: bounty animations (Dan's request)

The most dramatic thing in a bounty event — you took someone's head and got
paid — produced a one-line text banner and a cha-ching.

**`KnockoutAnimation`** — impact burst, rays, shockwave, KNOCKOUT slamming past
its resting size, the eliminated name struck through. Then, as a **separate
beat** 850ms later, the money. The strike and the payday are two satisfactions
and collapsing them into one frame wastes both. PKO head growth is stated
outright because players consistently miss it. `pointer-events: none` — it
fires while you may be in a hand and must never eat the fold button.

**`MysteryBountyChest`** — five beats: chest DROPS and thumps, sits LOCKED and
breathing with glowing seams and rising embers, the latch pops and the lid
swings on a real hinge with light flooding the widening gap, it BLOWS (flash,
two shockwaves, an 18-coin fountain with gravity), the amount counts UP. Built
from divs rather than a sprite specifically so it can be lit from _inside_ —
the glow is a real element growing through the gap, which is the whole point of
the beat.

**Real time.** The engine already broadcasts both events to the whole table, so
both animations are shared with no new plumbing. The chest needs one thing
more, because the winner _taps_ it: the tap broadcasts `mystery_chest_opened`
and every seat opens in step. The winner opens locally without waiting for the
round trip, so their own tap feels instant.

Only the winner sees "TAP TO OPEN"; everyone else sees "<name> is opening the
chest…". Three failure modes are closed: an AFK winner auto-opens at 9s (that
timer is owned by the **winner's client alone**, so nine spectators cannot fire
nine broadcasts); spectators hold a longer 14s failsafe so a dropped packet
cannot strand the table; and a broadcast that throws still shows the winner
their prize.

**Guard:** `tests/components/BountyAnimations.test.tsx` (27).

### Two more keyframe collisions, found checking my own work

`skeletonShimmer` (HomePage.module.css) was defined **twice with materially
different bodies** — one moving `background-position`, one moving
`translateX`. The later won for _both_ consumers, so the skeleton that sets
`background-size: 200% 100%` was given `translateX(-100% → 100%)` and **slid
the entire card across the screen** instead of shimmering. Split in two.
`leaderboardPageFadeInUp` was defined twice (12px vs 8px); duplicate deleted.

Genuine collisions across all 918 keyframes: **0**. The 3 remaining same-name
pairs are `@keyframes` inside `@media` blocks — legitimate responsive
overrides, not collisions. My 26 new keyframes are all `ko*`/`mbc*` prefixed.

---

## 12. Verification

`tsc --noEmit` 0 errors. 251 client tests pass. Production served
`ca_sha d36fe431f` at 17:50 UTC, confirmed **in the shipped minified bundle**
rather than from the build stamp: `mbc__chest` and `ko__stamp` in
`TablePage-BeOHo8ws-v6.js`, `mbcLidOpen`/`mbcCoinBurst`/`koShockwave` in
`TablePage-CTlqESx0-v6.css`, and both the `TAP THE CHEST TO OPEN` string and
the `mystery_chest_opened` event name present.

### A note for the next agent: this repo actively destroys uncommitted work

Mid-session, the host's `git reset --hard origin/main` loop wiped **9 of 15**
files I had edited but not yet committed. Nothing warned me; I found it because
edits I had just made were silently absent.

RULE 13 says commit small and often, and this is why. Two practices that made
it survivable: re-applying edits through an **idempotent** script (so a partial
wipe can be re-run safely), and building commits from a **clean origin/main
worktree** with `git hash-object` + explicit paths — so a commit can never pick
up another agent's half-finished work from the shared tree, and cannot be
undone by a reset landing mid-commit.
