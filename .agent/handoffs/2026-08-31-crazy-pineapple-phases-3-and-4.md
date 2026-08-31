# HANDOFF — CRAZY PINEAPPLE DISCARD OVERHAUL

## Phases 1 & 2 shipped and verified in production. You are starting Phase 3 of 4.

**Written:** 2026-08-31, by the agent who did Phases 1 and 2.
**Primary repo:** `Smarter-Poker-Club-Arena` (Club Arena, the Vite + React SPA + the Node engine under `server/`).
**Also touched for verification:** `Smarter-Poker-World-Hub` (the Next.js host that publishes the CA bundle), Supabase project `kuklfnapbkmacvwxktbh`.
**Main HEAD when written:** `7d8fba1`. It moves every ~2 minutes — see §9.

**READ BEFORE TOUCHING ANYTHING:** `AGENT-PLAYBOOK.md`, then `CLAUDE.md` — specifically **§5.7** (popups), **§5.8** (never push a red test), **§10.5** (HORSES ARE PLAYERS), **§10.6** (ANIMATION LAW — this is Phase 3's governing law), **§11.5** (never spend real chips), **§12** (clone hygiene).

---

# TABLE OF CONTENTS

1. What Dan reported, and what it actually was
2. Everything shipped — PR by PR, with the reasoning
3. The money bug, in full (#2072) — and the open decision only Dan can make
4. **PHASE 3 OF 4 — your job. Complete spec.**
5. PHASE 4 OF 4 — spec, so you can see where 3 is heading
6. Found, triaged, NOT in any phase
7. Still unresolved from Dan's original report (and why I did not "fix" it)
8. My own audit — what I broke, and what caught me
9. Estate-level findings outside Pineapple
10. Environment traps that cost me real hours
11. How to verify a deploy — this repo's rules
12. Copy-paste working setup
13. House laws that will bite you
14. Your first session, step by step
15. Complete file index

---

# 1. WHAT DAN REPORTED, AND WHAT IT ACTUALLY WAS

Verbatim, from a live Crazy Pineapple seat:

> I JUST JOING A PINEAPPLE TABLE THAT HAD NO PLAYERS AND IT DEALT ME IN WITH NO
> OTHER PLAYER PLAYING SMH. 2ND HAND "AUTO FOLDED MY HAND, EVEN THOUGH IT
> DIDN'T, IT JUST MADE MY CARDS DISAPPEAR. THE DISCARD, POP UP SHOULDN'T TAKE
> OVER THE ENTIRE SCREEN, IT SHOULD BE A SIMPLE DISCARD POP UP WHERE YOU SELECT
> WHICH CARD YOU WANT TO DISCARD, IT CURRENTLY BLOCKS THE HOLE FLOP SO YOU CAN'T
> SEE WHAT YOU CONNECTED WITH OR NOT, AND IT DOESN'T REMOVE THE CARD FROM YOU
> HAND AFTER YOU DISCARD IT.

Four complaints. What each turned out to be:

| Dan said                                 | Actual cause                                                                                                                                             | Status          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| "doesn't remove the card from your hand" | **TWO** independent bugs: the wrong card was being discarded (index mismatch), and the felt never repainted (INSERT-only subscription missed the UPDATE) | **FIXED** #2033 |
| "blocks the whole flop"                  | `inset: 0` + 72% scrim + blur, centred over the felt                                                                                                     | **FIXED** #2033 |
| "auto folded my hand"                    | The countdown was a client-side guess anchored to first sight of the stage; a reconnect restarted it from full over a half-spent server deadline         | **FIXED** #2074 |
| "dealt me in with no other player"       | **NOT REPRODUCED.** No DB evidence the engine dealt short. See §7.                                                                                       | **OPEN**        |

Then Dan asked what else could be improved, which produced a 12-item list. That list became four phases. **Along the way I found a money bug nobody had reported** — see §3.

---

# 2. EVERYTHING SHIPPED — PR BY PR

All merged to `main`. All CI-green. All deploy-verified.

| PR    | Merge SHA  | Merged (UTC) | Title                                                                       |
| ----- | ---------- | ------------ | --------------------------------------------------------------------------- |
| #2033 | `e2278b43` | 08:24        | discard the card you picked, take it off the felt, stop covering the flop   |
| #2051 | `684367a2` | 08:43        | docs(changelog)                                                             |
| #2072 | `66b0d898` | 09:24        | **a showdown is two hole cards on EVERY runout path**                       |
| #2074 | `b49fc137` | 10:39        | Phase 1 — the discard clock is the server's, per seat, and it can buy time  |
| #2131 | `8ed52334` | 11:25        | Phase 1 follow-up — duration wiring + document the empty bank callback      |
| #2146 | `1f9be149` | 11:48        | Phase 2 — the forced discard keeps the best HAND; equity never from 3 cards |
| #2171 | `c721142d` | pending      | this handoff document                                                       |

**#2061 was CLOSED as superseded, not abandoned.** #2074 was stacked directly on its branch and contains every commit — `git merge-base --is-ancestor 14ca7dd 7bc78e5` passes. It could not go green alone because its copy of the test file predated the two CI-gate fixes that landed with #2074 (see §8.1). Leaving a permanently-red PR in a 102-deep queue helps nobody.

## 2.1 #2033 — three defects in one PR

### (a) The wrong card was discarded

`GameServerAPI.submitDiscard(tableId, cardIndex)` sends an index into `player.cards` — **the engine's delivery order**. `HandController.performDiscard` does `player.cards.splice(cardIndex, 1)`.

The picker was handed `hero.holeCards`, which `cards_pre_sort` (Bible V8 §11.1, **ON BY DEFAULT**) has already re-sorted rank-high-to-low in `handleHoleCardPayload`. **Two different arrays, one index.**

On Dan's screenshot hand (`A♥ 7♠ 6♣` displayed) all three display positions mapped to a different engine card. Whatever he tapped, something else was thrown.

**Fix:** `heroEngineCardOrderRef` in `TablePage.tsx` records the unsorted delivery order as `${rank}${suit}` strings **before** `sortCardsByRank` runs. `handlePineappleDiscard` translates the clicked card back into that order **by identity**, falling back to the display index only when the record is missing.

> **Two entry points, one rule.** The realtime path (`handleHoleCardPayload`) and the mid-hand recovery poll (`fetchExistingHand`) BOTH write the ref now. The first cut only did the realtime path, so a refresh mid-hand still discarded the wrong card — caught in the self-audit, fixed in #2061's branch (delivered via #2074).

### (b) The felt never repainted after a discard

`insert_hole_cards` is an **upsert**:

```sql
INSERT INTO public.table_hole_cards (...) SELECT ...
ON CONFLICT (table_id, hand_number, user_id) DO UPDATE SET cards = EXCLUDED.cards;
-- supabase/migrations/20260312_secure_hole_cards_fix.sql
```

The deal is the INSERT. The engine's re-push of the remaining two cards after `performDiscard` splices one out hits the same unique key and is therefore an **UPDATE**. `TablePage` subscribed with `event: 'INSERT'` — so the client was **never told**, and the discarded card sat in hand for the rest of the hand.

**This was also silently swallowing every other hole-card re-push** — RESYNC, reconnect, the FIX-2 re-delivery path. Nobody had noticed because the only visible symptom was in a variant almost nobody played correctly.

**Fix:** `event: '*'`, plus optimistic local removal the instant the engine accepts (removing the card is also what closes the picker, since `heroPineappleCards` requires exactly three).

### (c) It covered the board

The panel shipped as `position: fixed; inset: 0` with `rgba(0,0,0,0.72)` and `backdrop-filter: blur(3px)`, centred over the felt. **The discard in this variant is made with the flop visible — that is the entire variant** — and the one input the decision needs was the thing being hidden.

**Fix:** compact bottom-docked panel; `pointer-events: none` on the wrapper so the felt stays live; no scrim, no blur; a `@media (max-height: 480px)` block that shrinks it for landscape rather than letting it climb back over the board.

### (d) A lie in the copy

The hint read _"If The Timer Runs Out The Table Discards Your Last Card For You."_ That has been false since **2026-08-21**, when Dan made a missed discard a **FOLD** (`foldForMissedDiscard`; the `autoDiscard` the text described is deprecated). It now says _"Miss The Timer And Your Hand Is Folded."_ — directly relevant to Dan's "auto folded" complaint.

## 2.2 #2074 + #2131 — PHASE 1, the clock

### The clock lied, three ways

The round was ONE flat table-wide `setTimeout` and the engine published **nothing** about it. The client counted down from its own copy of `action_time_seconds` (defaulting to 15), anchored with `prev ?? Date.now() + ...` to **the first frame it saw the stage in**.

1. The client's `15` was a **client** default. `action_time_seconds` is a per-table column — a table configured otherwise showed a number the engine never used.
2. A **reconnect** mid-round re-mounted the effect and restarted the countdown from full, over a server deadline that was already half spent. **You watch "12s" and get folded.**
3. Switching to the table from another tab re-anchored it again.

**This is almost certainly Dan's "2nd hand auto folded my hand, even though it didn't."**

### What the engine publishes now

```
discard_deadlines   : Record<user_id, epoch_ms>   -- per seat; a time bank moves ONE
discard_deadline_ms : epoch_ms                    -- the round's unextended deadline
discard_duration_ms : number                      -- round length, for ring geometry
```

All three are `null`/`{}`/`0` outside the round, so a dead countdown cannot linger between hands. Published from `ServerTableEngine.pineappleDiscardSnapshotFields()` into **both** `getTableState()` and the broadcast payload, and explicitly nulled in the idle payload.

The client maps them in `mapEngineSnapshot` (hero's own entry wins over the round default) and counts against **`serverNow()`** — the existing helper that subtracts device clock skew using the `server_time_ms` sample the turn ring already uses. **What the panel shows and what folds you are one number.**

### The discard could not buy time

A missed discard **folds the hand**, yet every other decision on the table can spend a time bank. The entire time-bank path is written against `currentPlayerSeat`, and the discard round **has no turn** — every seat decides at once. So `activateTimeBank` returned **"Not Your Turn"**, and the single action most likely to make a player hesitate was the only one with no way to think.

`ServerTableEngineTurns.activateTimeBank` now branches on `state.stage === 'pineapple_discard'` → `extendPineappleDiscard(userId)`, which applies the _same_ rules as a turn:

- the ordinary clock must be **genuinely exhausted** first (`TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS`); a press with time left **arms**, costs nothing, redeems at expiry (Dan 2026-08-23);
- the pool and the per-street cap are `TimeBankEngine`'s, not a second set of accounting;
- the grant is **what the bank actually released** — a player down to 6 seconds of pool gets 6, not a hard-coded 20 — and the deadline published is the deadline enforced.

### Why per-seat, and the reconciliation that makes it safe

The flat timeout became `armPineappleDiscardSweep()` — a **re-arming sweep** that fires at the earliest outstanding deadline, folds only the seats genuinely past theirs, then re-arms for the rest. That is what lets one seat's extension exist without touching anybody else's. Deadlines are absolute, so a sweep that runs late is still correct.

**The map is a cache and it can drift**, because there are three ways a seat leaves the round _without_ passing through `submitDiscard`:

- a **horse** discards by calling `performDiscard` directly (HorseLogic picks, the runout submits);
- an **all-in** seat is resolved by `resolvePendingPineappleDiscards` when the flop lands;
- a seat folded for missing the round is already gone.

So `HandController.owesPineappleDiscard(seat)` was added as the public authority, and `pruneSettledPineappleDeadlines()` reconciles the map against it **before every sweep and before every publish**. The engine can never announce or enforce a deadline for a seat with nothing left to decide.

### #2131 follow-up

- `discard_duration_ms` was published **and read by nobody**. Now drives the urgency threshold, which had been a hard-coded 5s — most of a 6-second round, a blink of a 30-second one. Clamped: `min(8, max(3, round(durationMs/3000)))`.
- The time bank's **empty `onExpire` callback** looked like an unfinished stub. It is deliberate and is now documented: on a turn, `TimeBankEngine`'s countdown _is_ the enforcement deadline so its `onExpire` must act; in the discard round the enforcement deadline is the per-seat map swept by `armPineappleDiscardSweep`, re-armed to the very deadline the grant produces. Folding from both would be two deadlines under different keys racing on one decision — the exact bug `TimeBankEngine`'s own history records. **One enforcer: the sweep.**

## 2.3 #2146 — PHASE 2, the choice and the equity

### (a) The forced discard threw away draws

`resolvePendingPineappleDiscards` chooses for a seat that was already all-in when the flop landed, so it never got to choose. It scored the flop-**made** hand:

```ts
const evaluated = evaluateHand(keep, flop);
const score =
  evaluated.ranking * 1e6 + (evaluated.kickers[0] || 0) * 1e3 + (evaluated.kickers[1] || 0);
```

That is backwards in the only situation it runs. An all-in has **two cards to come and no more betting** — precisely when a draw is worth the most it will ever be worth.

**Measured, not assumed.** I wrote a throwaway probe comparing the old rule against an equity chooser across candidate hands. Divergence found on `2s 2d A♥` / `K♥ J♥ T♥`:

| rule | throws  | keeps                                                            |
| ---- | ------- | ---------------------------------------------------------------- |
| old  | **A♥**  | a pair of deuces, drawing nearly dead on a three-heart KJT board |
| new  | a deuce | **nut flush draw + Broadway gutshot** (any Q plays A-K-Q-J-T)    |

A pair outranks ace-high on the flop, and the flop was the only thing it looked at.

It **also disagreed with `HorseLogic.decideDiscard`**, which has always priced by equity. That is CLAUDE.md §10.5 broken: the horse got the good rule and the human's forced discard got the bad one.

**Fix:** `server/src/engine/pineappleDiscardChoice.ts` → `bestPineappleDiscard(cards, communityCards, gameVariant, iterations = 400)`. Uses `simulateEquity(keep, board, 1, variantInfo('nlh'), iters)` with a flop down, `holdemPreflopScore` without. `HorseLogic.decideDiscard` now delegates to it. **Not the same answer — the same function.**

### (b) All-in equity was priced from a hand nobody may hold

A player holds **three** cards until the flop lands, and the equity solver has no rule for that:

- `omaha: false` → `evaluateHand` scores **best-5-of-8** — the same illegal advantage that was paying impossible flushes at showdown until #2072;
- `omaha: true` → `evaluateOmahaHand` hits `if (holeCards.length < 4)` and falls through to `evaluateHand(holeCards.slice(0, 2), ...)` — silently pricing the **first two** cards.

Both numbers are confident, wrong, and go on the felt as percentages players trust.

**There is no honest third number.** The true preflop equity depends on a discard that has not happened, and simulating it would need a nested sim inside the worker. So `broadcastAllInEquity` now **returns early** when any live player holds >2 cards and the hand is not Omaha. Equity appears from the flop — which is where Dan's own rule already points (_"equity only AFTER the street lands"_, quoted in that file) and, in this variant, the first moment the numbers mean anything. The discard resolves as the flop lands (#2072), and the per-street refresh (`ServerTableEngineRunout` lines ~895 and ~2164) prices every street after.

**Omaha is explicitly excluded** — four hole cards are the whole point there.

---

# 3. THE MONEY BUG (#2072) — READ THIS EVEN IF YOU SKIM EVERYTHING ELSE

## What was wrong

An all-in hand never opens the discard round (betting is over), so the discard must be resolved **on the deal**. There are two runout paths:

| path                     | used when                                                                           | had the resolve?                     |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------ |
| `runOutCommunityCards()` | instant runout                                                                      | **yes** — since AUDIT V2, 2026-07-23 |
| `dealNextStreet()`       | per-street pacing, i.e. whenever the table has **insurance** or **run-it-twice** on | **NO**                               |

The comment on the path that had it names the failure exactly:

> "players still held THREE hole cards at showdown and evaluateHand scored best-5-of-8, an illegal extra-card advantage"

And every live pineapple table has one or both features enabled:

```
Pineapple 1.00/2.00 #2   insurance=true   rit=true
Pineapple 1.00/2.00      insurance=false  rit=true  (run_it_twice_enabled=true)
Pineapple 1.00/2.00 #3   insurance=true   rit=true
```

**So the unfixed path is the one production actually takes.** The fix that already existed was on the branch nobody was walking.

## The proof

Hand **`#3831745`**, table `0be5fa47-c676-4bef-938f-81a28e3630e4`, 2026-08-31 07:21:52 UTC. Board `2h 3c 5d Qc 4h`:

```
seat A   Jh Ah Kh   -> awarded "Flush"     22.57 of a 34.00 pot
seat B   Ad Kc 5h   -> "Straight"           7.53
```

The board holds **exactly two hearts**. No legal two-card hold makes a flush there — seat A needed _all three_ of its own cards. That is the illegal extra card, and it **beat an honest straight that should have scooped**.

## The scale — run this yourself, it still works

```sql
select count(*) as three_card_showdowns,
       min(created_at) as earliest, max(created_at) as latest,
       sum(pot_size)   as chips_in_those_pots
from hand_history h
where h.game_variant = 'pineapple'
  and h.hole_cards is not null and jsonb_typeof(h.hole_cards) = 'object'
  and h.created_at > now() - interval '7 days'
  and exists (select 1 from jsonb_each(h.hole_cards) e
              where jsonb_array_length(e.value) = 3);
```

At the time of writing: **1,975 hands · 491,187.36 chips in those pots · earliest 2026-08-24.**

> **2026-08-24 is the `hand_history` retention floor for horse-only hands (7 days,
> `hand_history_retention_policy.horse_retention_days`), NOT the start of the bug.**
> The defect is as old as the per-street runout path. The evidence is simply gone.

## THE OPEN DECISION — DAN'S, NOT YOURS

- **All 1,975 were evaluated illegally.**
- **Not all 1,975 were mis-settled** — the extra card only changes the outcome when it actually improves the hand (as it did in #3831745, turning nothing into a flush). Establishing that subset needs a re-evaluation pass over each hand. **I did not run it.**
- **I did not touch a single chip.** CLAUDE.md §11.5: an agent does not move money on its own judgment. Flagged as a comment on #2072 with the real numbers attached.

If Dan asks you to repair them: re-evaluate each hand with the legal 2-of-3 constraint, diff the winner set, and produce a report **before** proposing any ledger movement. Probe inside a transaction you ROLL BACK. Helpers in `pg_temp`, never `public`. **Never DELETE a `table_seats` row** — it skips the refund and destroys chips.

---

# 4. PHASE 3 OF 4 — YOUR JOB. COMPLETE SPEC.

**Title: "the discard you can see and hear."** Three defects, governed by CLAUDE.md **§10.6 (Animation Law)** and **§10.5 (horses are players)**.

## 4.0 THE SECURITY CONSTRAINT — READ FIRST, IT IS EASY TO GET WRONG

**In Crazy Pineapple the discarded card is NEVER revealed to opponents.** Not on the discard, not at showdown.

Hole cards on this platform do **not** travel on the public broadcast at all. They go through the RLS-protected `table_hole_cards` table (`ServerTableEngineHandEvents.ts`, `case 'CARDS_DEALT'` — _"Do NOT broadcast state here — cards are delivered securely via table_hole_cards"_). That table exists because of a **god-mode vulnerability** (Bible V8 §4.6, migration `20260312_secure_hole_cards_fix.sql`).

Therefore:

- The villain discard animation **must be a face-DOWN card.** Never carry a villain's discarded card identity on the `player_action` event, which is a public broadcast.
- The hero may see their own — they already know it.
- Phase 4's history is subject to the same rule (see §5.1).

**If you put a card rank/suit on the public `player_action` event, you have re-opened the god-mode hole.** This is the single most dangerous mistake available in Phase 3.

## 4.1 Nobody can see anyone discard — THE BIG ONE

### Current state, exactly

Engine, `server/src/engine/HandController.ts` (in `performDiscard`, ~line 958):

```ts
this.emit({ type: 'PLAYER_ACTION', seat, action: 'discard', amount: 0 });
this.emit({ type: 'CARDS_DEALT', seat, cards: [...player.cards] }); // private, RLS
```

Engine → WS, `server/src/engine/ServerTableEngineHandEvents.ts` (`case 'PLAYER_ACTION'`, ~line 503, emit at ~554):

```ts
this.hub?.emitEvent(this.tableId, {
  type: 'player_action',
  table_id: this.tableId,
  hand_number: this.handCount,
  seat: event.seat,
  user_id: actingPlayer?.user_id ?? '',
  action: event.action, // 'discard'
  amount: event.amount ?? 0, // 0
  stage,
  timestamp: Date.now(),
});
```

Client, `src/pages/TablePage.tsx` — **`case 'PLAYER_ACTION': {` at line 12605.** Inside it, the sound block (~12678-12684):

```ts
const isHeroEcho = actionSeat > 0 && actionSeat === tableStateRef.current.heroSeat;
if (soundService.isEnabled() && ambientSoundsAllowed && !isHeroEcho) {
  if (action === 'all_in' || action === 'allin') soundService.playAllIn();
  else if (action === 'bet' || action === 'raise' || action === 'call') soundService.playChips();
  else if (action === 'check') soundService.playCheck();
  else if (action === 'fold') soundService.playFold();
}
```

**There is no `discard` arm.** No sound, and no animation anywhere in that handler. A discard renders _nothing_: no card leaves a seat, no villain card-count changes, no cue.

> Note the `isHeroEcho` guard — the hero's own feedback is fired locally at click time and the echo is suppressed to avoid a double-sound (AUDIT-2 FIX 2026-08-20). Your discard cue must respect the same split: **hero fires locally in `handlePineappleDiscard`; villains fire from this echo.**

### Why this is worse than cosmetic — §10.5

Horses discard on a deliberate humanlike delay. `ServerTableEngineRunout.handlePineappleDiscard`:

```ts
const delay = 1200 + Math.random() * Math.min(4000, Math.max(1500, timeoutMs * 0.3));
setTimeout(() => { ... this.handController.performDiscard(seat, idx); }, delay);
```

That 1.2s–5.2s delay exists **to make a horse indistinguishable from a human**. But since nothing renders, the table just _pauses and then jumps_. The pause is there and the thing it was hiding is not. Dan's law is explicit that **timing is part of the treatment** and the tell is the RHYTHM, not one hand.

### What to build

A per-seat "one card leaves the hand toward the muck" animation, fired for **every** seat identically — hero and villain, human and horse.

**Reuse the existing mechanism; do not invent a second one.** `src/components/table/SeatSlot.css` already has the muck animation:

```css
.seat__cards--folding .seat__card {
  animation: cardFoldOut calc(0.38s * var(--animation-speed, 1)) cubic-bezier(0.4, 0, 0.2, 1)
    forwards;
  will-change: transform, opacity, filter;
}
@keyframes cardFoldOut {
  /* lift 15% -> launch 40% -> away, with brightness + blur */
}
```

Note it is **already speed-scaled** by `--animation-speed`, which §10.6 requires (speed scaling is the only sanctioned control). There is a documented gotcha in that file: a `:nth-child(2)` selector was wrapper-blind in the hero row, so "the satisfying 1-2 toss" never fired for hero — read the comment at `SeatSlot.css` ~2900 before you copy the selector shape.

Relevant `SeatSlot.tsx` anchors: `isMucked?: boolean` (~198), the muck/reveal ordering note (~382), and the ANIMATION AUDIT 2026-08-19 window note (~1098) explaining that the JS removal window must outlast the CSS duration.

**Design constraints:**

- ONE card, not two. `cardFoldOut` currently animates `.seat__card` (all of them) — you need a single-card variant.
- Face **down** for villains (§4.0).
- Must survive reduced-motion per §10.6: _reduced-motion collapses motion but never meaning_ — use `data-motion="keep"` for duration-carrying animation.
- Must not be disableable by any new toggle.

## 4.2 The discard plays the FOLD sound

`src/pages/TablePage.tsx` line **2452**, at the end of `handlePineappleDiscard`:

```ts
soundService.playFold();
```

Wrong action, wrong cue — and under §10.6 a discard is owed **its own** cue.

`src/services/SoundService.ts` structure you need:

- Cues are hand-built Web Audio (`playFold()` is a noise burst through a sweeping bandpass — read it, ~line 22 doc + the body; `playDeal()` ~737, `playCheck()` ~884).
- Every cue opens with `if (!this.shouldPlay('<priority>', '<category>') || !this.ensureContext()) return;`
- `shouldPlay` (~544) enforces a **50ms frame-priority window**: `if (rank <= this.currentFramePriority) return false`. Pick a priority that will not lose to whatever else fires in the same frame — this is exactly how `playPotCollect` came to be permanently silent (there is a law pin about it).
- Most cues end with a `haptic.*()` call.

**Add `playDiscard()`** and wire it in both places (hero-local in `handlePineappleDiscard`; villain echo in the `PLAYER_ACTION` arm from 4.1).

> ⚠️ **§10.6 corollary, and there is a law pin enforcing it:** _"a sound cue with a literal volume of 0 is a bug by definition."_ The pin is:
> `expect(SOUND).not.toMatch(/this\.playTone\(\s*[^,]+,\s*[^,]+,\s*0(\.0*)?\s*,/)`
> Thirteen cues once shipped silent because volume and delay were swapped. **Do not ship a silent stub.**

## 4.3 The street snaps to the turn

`server/src/engine/HandController.ts` ~line 1051:

```ts
private checkPineappleDiscardsComplete(): void {
  if (this.pineappleDiscardsRemaining.size === 0) {
    this.advanceStage();   // straight to flop betting. No beat.
  }
}
```

Every other cadence on this platform is a **named constant** in `server/src/config/handCompletionSpec.ts`:

```
BETS_SWEEP_MS: 700     MUCK_MS: 600           DEAL_MS: 700
POT_PUSH_MS: 2200      BOARD_CLEAR_FOLD_MS: 500
SHOWDOWN_REVEAL_STAGGER_MS: 300               BUTTON_MOVE_MS: 700
ALL_IN_STREET_REVEAL_MS: 1250                 POST_PUSH_PAUSE_MS: 1000
```

Add a `DISCARD_*` beat there (e.g. `DISCARD_SETTLE_MS`, and consider a `DISCARD_STAGGER_MS` if you stagger multiple seats' discards the way `SHOWDOWN_REVEAL_STAGGER_MS` does) and let the last discard breathe before the turn opens — otherwise the animation you just built is cut off by the next street.

## 4.4 Phase 3 acceptance criteria

- [ ] Every seat's discard **animates and sounds, every time**, for its full duration, at the player's chosen Animation Speed.
- [ ] A **horse's** discard is indistinguishable from a human's (§10.5) — same animation, same cue, same timing.
- [ ] A **villain's** discarded card is never revealed (§4.0). Verify nothing card-shaped rides `player_action`.
- [ ] Hero fires locally, villains fire from the echo — **no double sound** (the `isHeroEcho` split).
- [ ] The street does not advance until the beat has elapsed.
- [ ] No new toggle can disable any of it (§10.6).
- [ ] Reduced motion collapses the motion but keeps the meaning.
- [ ] New pins added to **`tests/animations-always-play.law.test.ts`** (currently 731 lines, 45 pins).

### How to write the pins

That file reads source and asserts on its shape, deliberately (_"These are source-shape pins on purpose: they run in CI's required vitest check on every pull request, so nothing merges past them."_). Its header loads modules as constants:

```ts
const SOUND = read('src/services/SoundService.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const SEAT_TSX = read('src/components/table/SeatSlot.tsx');
const SEAT_CSS = read('src/components/table/SeatSlot.css');
```

Every pin's comment explains **the bug that shipped**. Copy that discipline. And obey §8.1: **no byte-count windows** — use `tests/helpers/sourceWindow.ts`.

> **If you replace a mechanism rather than add one, MOVE the existing pin to the new mechanism in the same commit and say so in the PR.** That is the file's own rule, and there is precedent in it (the KnockoutAnimation → SeatKnockout migration).

---

# 5. PHASE 4 OF 4 — SPEC

## 5.1 The replay says "Discard" but not WHICH card

Already present and working:

- `src/utils/handReplay.ts:167` — `'discard'` is a `ReplayVerb`;
- `handReplay.ts:287` — `{ key: 'pineapple_discard', label: 'Discard', boardTo: 0 }`, a **real street**, with a comment noting **74,631 discard actions exist in production**;
- `handReplay.ts` `VERB_LABEL` — `discard: 'Discard'`;
- `src/components/table/HandHistoryPanel.tsx:182` — colours a discard `#94a3b8`.

**Missing:** the event carries `amount: 0` and **no card identity**, so reviewing a Pineapple hand you cannot see what anyone threw away — the only decision the variant adds.

**Work:** carry the discarded card through to the hero's own history and render it. Persist it in `hand_history` (the `players`/`actions` JSONB, or `hole_cards` — decide and document).

> **§4.0 applies with full force here.** Your own discard: always yours to see. An opponent's: **not revealed, even at showdown**, under Crazy Pineapple rules. Scope the storage and the render so a client can never read another player's discarded card. If you persist all discards server-side for audit, gate the read the way `table_hole_cards` gates hole cards (RLS on `auth.uid() = user_id`).

## 5.2 The felt calls it the wrong game

Tables are named `Pineapple 1.00/2.00`. The engine implements **Crazy Pineapple** — discard _after_ the flop. In plain Pineapple you discard _before_ it. Anyone who knows the difference is being told the wrong game.

**Work:** rename in the lobby, the felt header and the table naming.

> ⚠️ **Check with Dan before mass-renaming live `tables` rows.** It is player-visible copy, there are three live tables, and §5.7 (Title Case, no em dashes) applies to anything that reaches a popup.

---

# 6. FOUND, TRIAGED, NOT IN ANY PHASE

1. **`auto_start_players = 2` on every pineapple table.** Directly relevant to Dan's "no players" report: one human + one horse is a _legal_ deal, and `minPlayersToDeal()` returns 2 unless `auto_start_players > 2`. **This is a config row, not code — Dan's knob.** Do not change it unilaterally. If he wants pineapple to look busier, this is the lever.

2. **The client's odds / hand-strength surfaces ignore the variant.** `src/utils/pokerOdds.ts` and `src/utils/handEvaluator.ts` contain **no mention of pineapple**. During the discard — the one moment you need it — anything showing equity or hand strength is computing from 2 of your 3 cards, or from all 3. Neither is your actual decision.
   **Server-side equity is fixed (#2146). The client is not.** This is a natural Phase 5 or a Phase 3 stretch goal.

3. **`resolvePendingPineappleDiscards` uses 400 Monte Carlo iterations** (the `bestPineappleDiscard` default, inherited from HorseLogic). That is a horse's per-decision latency budget. For a one-off forced resolve on an all-in you could afford far more and be more accurate. Not wrong — just cheap. Consider raising the iteration count on that call site only.

---

# 7. STILL UNRESOLVED FROM DAN'S ORIGINAL REPORT

**"Dealt me in with no other player"** and **"auto folded, cards just disappeared"**.

The clock half is fixed by #2074. The **empty roster** half is not reproduced. What I established:

- **No `table_seats` row** for `kingfish` (`47965354-0e56-43ef-931c-ddaab82af765`) on _any_ pineapple table that day. His most recent seats were NLH/PLO tournament tables the previous evening.
- **No `table_hole_cards` row** for him that day either.
- The three live pineapple tables ran **5-6 handed throughout** — I pulled their `table_seats` and `hand_history` rows. `minPlayersToDeal()` was **not** bypassed.
- **Both screenshots show the banner "Reconnecting To The Table"** (`TableConnectionBanner.tsx:79`).

That points at the **client painting a confident, wrong roster underneath the reconnect pill**, not at the engine dealing short. Supporting evidence: the snapshot merge in `TablePage.tsx` has explicit never-shrink guards for the **board** (`nextCards.length < prev.communityCards.length`) and the **stage** (`STAGE_RANK`), but **none for the player roster** — `nextPlayers` is `mapped.players.map(...)` applied verbatim.

> ## I deliberately did NOT add a "never shrink the roster" guard.
>
> It is the obvious patch and it is **wrong**: it would strand a ghost seat on the felt every time somebody legitimately stands up. The correct fix needs to know _why_ the roster is empty, which needs a repro.
>
> **If Dan hits it again, capture at that moment:** `engineWsStatus`, the raw `engineSnapshot` object, `tableState.players`, and the table id. Then the guard can be scoped to "do not apply a roster from a snapshot received while the socket is down", which is narrow enough to be safe.

---

# 8. MY OWN AUDIT — WHAT I BROKE, AND WHAT CAUGHT ME

Dan explicitly asked me to re-audit Phase 1 before moving on. I found **three real defects in my own work** and **two CI gates I had broken**. All fixed and shipped. I am telling you this so you calibrate: the guards in this repo are good, and they will catch you too.

1. **The deadline map could drift** (horses / all-in seats bypass `submitDiscard`) → `owesPineappleDiscard()` + `pruneSettledPineappleDeadlines()`.
2. **A discard time bank borrowed the TURN presentation.** `timeBankActive` drives the hero seat ring and the multi-table tab's `1:<deadline>` string, and the effect that owns it cancels the instant `currentPlayerSeat !== heroSeat`. The discard round has no current player, so a press painted a ring for one frame, published a bogus deadline to the tab strip, then cancelled itself. Now returns early.
3. **My first fix for (2) added a toast and turned an existing test red — correctly.** `tests/unit/timeBankSeatFeedbackAndCards.test.ts` pins Dan's 2026-08-24 rule: _"it gives you this generic pop up, instead of resetting the countdown clock on the hero's box."_ I honoured the rule rather than gaming the test: the handler returns `{ armed }` and the picker's own button becomes the notice. **That test slices from the first `if ((result as { armed?: boolean }).armed) {` to `setTimeBankActive(true);` — if you add a branch containing that string earlier in the callback, you will move its window and trip it.**
4. **`discard_duration_ms` was published and read by nobody** → now drives urgency.
5. **The bank's empty `onExpire` looked like a stub** → documented (see §2.2).

## 8.1 THE TWO CI GATES THAT WILL CATCH YOU

### (a) `scripts/ci/report-source-grep-tests.mjs --ratchet`

Runs inside the **TypeScript Check** job as _"Test Quality — no NEW text-only pin on a pure src/utils module."_

204 of 710 test files assert on source TEXT without importing the unit. That is tolerated in general — but **not for a `src/utils` module**, which is pure and importable. The count is **ratcheted at 5/5 with zero headroom**:

```
tests/member-count-truth.test.ts            pins src/utils/memberCount.ts
tests/unit/deadLobbyIsGone.test.ts          pins src/utils/ChunkPreloader.ts
tests/unit/discardedErrorReadRatchet.test.ts pins settlementLock.ts, unionScope.ts
tests/unit/postBBAskedOnce.test.ts          pins src/utils/mapEngineSnapshot.ts
tests/unit/timeBankSeatFeedbackAndCards.test.ts pins src/utils/mapEngineSnapshot.ts
```

I tripped this by text-pinning `mapEngineSnapshot.ts`. **Fix: import the module and assert what it DOES.** `tests/unit/tabSlots.test.ts` is the reference shape. Run it locally:

```bash
node scripts/ci/report-source-grep-tests.mjs --ratchet
```

### (b) `tests/unit/noFixedSizeSourceWindows.test.ts`

Fails any test that bounds a source-pin window with a **magic byte count** (`src.slice(i, i + 700)`). I tripped it three times.

The rule exists because a 7000-char window in `tournamentRakeAndBreaks` drifted when comments were added, four pins went red, the code had not changed by a character, **and because a red client suite skips `sync-to-world-hub`, NOTHING PUBLISHED FOR THE WHOLE ESTATE for 39 minutes.**

Use `tests/helpers/sourceWindow.ts`:

```ts
(blankNonCode,
  sliceMethod,
  sliceCall,
  sliceEnclosingBlock(src, needle, (occurrence = 0), (levels = 1)),
  sliceBlockAfter,
  sliceCssRule,
  sliceSqlStatement,
  sliceDollarQuoted,
  sliceStatement,
  sliceYamlBlock,
  sliceYamlEntry,
  sliceBetween);
```

**Pick the right one.** I burned two iterations because `sliceStatement` was too tight (one statement) and `sliceEnclosingBlock(..., levels: 2)` was too wide (the whole component). What worked was anchoring on a statement _inside_ the effect and taking `levels: 1`, which yields exactly the effect body.

---

# 9. ESTATE-LEVEL FINDINGS (Dan has seen these; not your job unless he says so)

## The merge queue is jammed — this is the biggest non-Pineapple problem

- **102 open PRs on Club Arena** (99 when I first measured). Auto-merge armed on ~121 of the sample; **~42 confirmed `dirty`**, most of the rest uncomputed, **exactly one `clean`**.
- **99 of them were 2–7 days old.**
- Check states across the sample: 69 SUCCESS, 33 FAILURE, 16 with no checks at all.
- **`main` took 142 commits in 24h — 26 in the last hour** — it moves every ~2 minutes, while six required checks take longer than that to run. Every PR races a target moving faster than its own CI.

Top conflict sources, measured from the dirty PRs:

| conflicts | file                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------- |
| 7         | `MIGRATION-CHANGELOG.md` — **frozen by CLAUDE.md on 2026-08-26** and agents still append to it |
| 6         | `scripts/ci/supabase-schema-manifest.json` — machine-generated, committed per PR               |
| 5         | `scripts/ci/supabase-columns-manifest.json` — same                                             |
| 5 each    | `CashierTradePage.tsx`, `ClubMembersPage.tsx`, `SeatSlot.css`                                  |

Fixing the first two removes ~13 of the top conflicts. Already filed as **World Hub #682** ("Agent Autopilot: pull requests that cannot merge on their own").

> ⚠️ **Do NOT add a new blocking CI check while the queue is stuck** — every one of the 102 open PRs would then need to satisfy it. **Drain first, enforce second.**

## Open issues worth knowing

- **CA #1634** — a `SECURITY DEFINER` writer reachable from a browser. Privilege-escalation shape; oldest open issue.
- **CA #1498** — eight Club Arena flows still push to **OneSignal**, removed 2026-08-19. Those notifications go nowhere; players are silently not being told things.
- **CA #997** — delete the vestigial `club-arena` Vercel project.
- **WH #1064** — global footer broken in production (on every page).
- **WH #820** — Solver v2 re-solve pass stopped 2026-08-15; **6.6M spots outstanding**, backlog growing.
- **WH #771** — six VIP entitlement defects behind the benefits page.
- **WH #613 / #237 / #223** — stale `ci-failure` issues from April/August; nobody can tell whether they are real, which is its own problem.

---

# 10. ENVIRONMENT TRAPS THAT COST ME REAL HOURS

Read every item. Each one bit me.

### 1. `TMPDIR` points at a FULL disk — this will look like broken tests

`TMPDIR=/sessions/<you>/tmp`, and **`/sessions` sits at 100% (2.9M free)** while `df -h /` cheerfully reports ~1GB free on `/`. Vitest, `tsc` and the pre-push hook all die with `ENOSPC: no space left on device`.

**Symptoms that are actually this:**

- `Test Files 659 failed | 27 passed` with **`Tests 1296 passed`** and zero assertion failures;
- pre-push reporting `Test Files no tests / Errors 43 errors`, then **BLOCKED**;
- `failed to load config from vitest.config.ts`.

**Fix, do it first thing every session:**

```bash
mkdir -p /tmp/tmpdir && export TMPDIR=/tmp/tmpdir
```

and pass it explicitly to pushes: `TMPDIR=/tmp/tmpdir git push ...`

### 2. The pre-push hook refuses a tree with no `node_modules`

> `[club-arena pre-push] REFUSING: no vitest in this tree and it could not be provisioned, so the test gate cannot run.`

If you borrow another clone's `node_modules` (I did, for disk), symlink **per package** and then make these **real writable directories**, or you get errors that masquerade as type/test failures:

```bash
mkdir -p node_modules && (cd /path/to/other/node_modules && ls -A) | while read x; do
  ln -sfn "/path/to/other/node_modules/$x" "node_modules/$x"; done
rm -f node_modules/.tmp node_modules/.vite node_modules/.vite-temp
mkdir -p node_modules/.tmp node_modules/.vite node_modules/.vite-temp
```

- missing `.tmp` → `TS5033: Could not write file '.../tsconfig.app.tsbuildinfo'` → hook says **"src/ does not type-check"**;
- missing `.vite*` → `EACCES .../vitest/results.json` and vitest config load failures.

### 3. `AGENT_SHARED_CLONE_OK=1` is required

A guard treats any clone as the shared one and refuses `commit`/`push`. Set the env var. **Do NOT use `--no-verify`** — it skips nine house guards, every one of which exists because something was lost.

### 4. A failed Python heredoc TRUNCATED `TablePage.tsx` TO ZERO BYTES

I recovered from the commit (`git checkout -- src/pages/TablePage.tsx`), but this is a 22,000-line, 1.1 MB file. **Use a write-to-temp-then-rename helper that refuses to write a suspiciously small file** — §12 has mine. Never `io.open(p, 'w')` on a large source file directly.

### 5. `/tmp/ca_fix` is owned by `nobody`

Another agent's tree. You cannot delete it and should not try to reclaim its space. Stale trees from finished sessions (`/tmp/ca2_2` etc.) **can** be removed if `git status --porcelain` is empty — check first.

### 6. The `.env` `GITHUB_TOKEN` cannot read check-runs or job logs

- `GET /commits/{sha}/check-runs` → **403**
- `GET /actions/jobs/{id}/logs` → **401** on the blob redirect
- GraphQL `statusCheckRollup` returns `state: FAILURE` with **zero contexts** — worse than useless, it looks green.

**What works:** `GET /actions/runs?branch=<branch>` and `GET /actions/runs/{id}/jobs?per_page=40`. Job objects carry `conclusion` and a `steps[]` array with per-step `conclusion` — that is how you find _which step_ failed. See §12.

### 7. The GitHub MCP is broken

`mcp__github__*` returned **"Authentication Failed: Bad credentials"** for the whole session. Use the REST API with the `.env` token via `python3` + `urllib`. Snippets in §12.

### 8. Clone URL

The remote is `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git`. Cloning `.../club-arena` gives **"Repository not found"**.

### 9. Never run git WRITE commands against the mounted worktree from the sandbox

CLAUDE.md §12.4: the mount cannot `unlink`, so a `.git/index.lock` it creates is stranded and then blocks git **on Dan's Mac** too. Work in a `/tmp` clone. Also: the mounted worktree's `.git` file points at a host path that does not exist in the sandbox, so `git status` there fails with _"not a git repository"_ — that is expected, not a problem to fix.

### 10. Bash tool calls hard-cap around 178 seconds

A full client suite takes ~90-170s and a `sleep`+poll loop will be killed mid-flight. Background long runs and read the log:

```bash
TMPDIR=/tmp/tmpdir nohup npx vitest run > /tmp/cl.log 2>&1 &
sleep 150; grep -aE "Test Files |Tests  " /tmp/cl.log | sed 's/\x1b\[[0-9;]*m//g' | tail -3
```

### 11. Very large command output is truncated by the tool

A raw `npx vitest run` on the server suite produced 518,299 characters and was refused. Always pipe through `grep -E "Test Files|Tests  |FAIL "`.

---

# 11. HOW TO VERIFY A DEPLOY — THIS REPO'S RULES

**"Merged" is not "deployed." "CI green" is not "deployed."** CLAUDE.md §1.4/§1.5 are explicit and Dan checks.

## Client changes (anything under `src/`)

CA `main` → `.github/workflows/build-for-world-hub.yml` → a `chore(club-arena): sync build <ca-sha>` commit on **World Hub** `main` → Vercel (`hub-vanguard`).

1. Find the newest WH sync commit and read the CA sha out of its message.
2. Confirm that sha is **at or ahead of** your commit:
   `GET /repos/Smarter-Poker/Smarter-Poker-Club-Arena/compare/<yours>...<sync-sha>` → `status` must **not** be `behind`.
   _(Expect a race: syncs frequently build from a sha slightly behind yours. Wait for the next one.)_
3. Fetch the **real** bundle and grep for a string only your change introduces:

```bash
curl -sL https://smarter.poker/hub/club-arena/index.html -o idx.html
E=$(grep -oE '/hub/club-arena/assets/index-[A-Za-z0-9_.-]+\.js' idx.html | head -1)
curl -sL "https://smarter.poker$E" -o e.js
# the entry names the lazy chunks; take the LARGEST TablePage-*.js
grep -oE 'TablePage-[A-Za-z0-9_.-]+\.js' e.js | sort -u
curl -sL "https://smarter.poker/hub/club-arena/assets/<the-big-one>" -o c.js
grep -c "YOUR UNIQUE STRING" c.js
```

I verified Phase 1 this way: `discard_deadlines`, `Time Bank Armed. It Starts When Your Clock Runs Out`, `Miss The Timer And Your Hand Is Folded` and `discard_duration_ms` all present in `TablePage-mXis1f-Q-v6.js`.

## Server changes (`server/**`)

`.github/workflows/auto-deploy-hetzner.yml` fires on push to `main`.

- Deploys sit in a **concurrency group that cancels superseded runs**, so a long list of `cancelled` is **normal, not failure**. Wait for a `success` on a sha that is `ahead`/`identical` to yours.
- The drain gate waits for hands in flight, so a deploy can legitimately take many minutes.

## NEVER use the health endpoint

`https://engine.smarter.poker/health` is **CDN + 15-min fetch cached and frozen** (CLAUDE.md §11). It will lie to you.

## DO confirm behaviourally in Supabase

```sql
select date_trunc('minute', created_at) as minute, count(*) as hands
from hand_history
where created_at > now() - interval '25 minutes'
group by 1 order by 1;
```

A restart shows as a drain-and-recover dip. Phase 1's was `205 → 164 → 145 → 102 → 118 → 143`. Phase 2's was `283 → 224 → 129 → 114 → **95** → 105 → 191 → 216`. **That dip is the proof the new code is executing.**

---

# 12. COPY-PASTE WORKING SETUP

```bash
# ── 0. TEMP DIR THAT IS NOT FULL. DO THIS FIRST, EVERY SESSION. ────────────
mkdir -p /tmp/tmpdir && export TMPDIR=/tmp/tmpdir

# ── 1. YOUR OWN CLONE (never the mounted worktree) ─────────────────────────
GT=$(grep '^GITHUB_TOKEN=' /sessions/<you>/mnt/club-arena/.env | cut -d= -f2- | tr -d '"'"'"'\r')
git clone --depth 1 "https://x-access-token:${GT}@github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git" /tmp/ca
cd /tmp/ca

# ── 2. IDENTITY — REQUIRED. RULE 3. ────────────────────────────────────────
# A commit Vercel cannot attribute goes to BLOCKED with NO BUILD LOGS AT ALL.
git config user.name  "Smarter-Poker"
git config user.email "254329056+Smarter-Poker@users.noreply.github.com"

# ── 3. DEPS ────────────────────────────────────────────────────────────────
npm ci && (cd server && npm ci)     # ~700MB; if disk is tight see §10.2

# ── 4. VERIFY BEFORE PUSHING ───────────────────────────────────────────────
npx tsc --noEmit -p tsconfig.app.json
(cd server && npx tsc --noEmit -p tsconfig.json)   # ignore @sentry/node + GameServer.ts
                                                    # noise if deps are borrowed
TMPDIR=/tmp/tmpdir npx vitest run          # client: ~718 files / ~10,086 tests
(cd server && TMPDIR=/tmp/tmpdir npx vitest run)  # server: ~273 files / ~3,092 tests
node scripts/ci/report-source-grep-tests.mjs --ratchet
TMPDIR=/tmp/tmpdir npx vitest run tests/unit/noFixedSizeSourceWindows.test.ts

# ── 5. SHIP ────────────────────────────────────────────────────────────────
AGENT_SHARED_CLONE_OK=1 git checkout -b phase3/<slug>
AGENT_SHARED_CLONE_OK=1 git add -A
AGENT_SHARED_CLONE_OK=1 git commit -F /dev/stdin <<'MSG'
feat(pineapple): <one line>

<why, with the evidence>
MSG
TMPDIR=/tmp/tmpdir AGENT_SHARED_CLONE_OK=1 git push origin HEAD:phase3/<slug>
```

## Safe file editor — use this, not raw writes (§10.4)

```python
import io, os, sys
def sub(path, old, new, expect=1):
    s = io.open(path, encoding='utf-8').read()
    n = s.count(old)
    if n != expect:
        sys.exit(f"ABORT {path}: found {n} of anchor, expected {expect}")
    out = s.replace(old, new)
    tmp = path + '.tmp'
    io.open(tmp, 'w', encoding='utf-8').write(out)
    if os.path.getsize(tmp) < 100:
        os.remove(tmp); sys.exit("ABORT: refusing to write a suspiciously small file")
    os.replace(tmp, path)
    print(f"OK {path}: {len(s)} -> {len(out)}")
```

## Open a PR and arm auto-merge (the MCP is broken — §10.7)

```python
import json, os, urllib.request
tok = os.popen("grep '^GITHUB_TOKEN=' /sessions/<you>/mnt/club-arena/.env | cut -d= -f2-").read().strip().strip('"').strip("'")
H = {'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json',
     'User-Agent':'sp-agent', 'Content-Type':'application/json'}
B = 'https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena'

d  = json.dumps({'title':TITLE, 'head':BRANCH, 'base':'main', 'body':BODY}).encode()
pr = json.load(urllib.request.urlopen(urllib.request.Request(B+'/pulls', data=d, headers=H)))
print(pr['html_url'])

def gql(q, v):
    return json.load(urllib.request.urlopen(urllib.request.Request(
        'https://api.github.com/graphql',
        data=json.dumps({'query': q, 'variables': v}).encode(), headers=H)))

pid = gql('query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)'
          '{pullRequest(number:$n){id}}}',
          {'o':'Smarter-Poker','r':'Smarter-Poker-Club-Arena','n':pr['number']}
         )['data']['repository']['pullRequest']['id']
gql('mutation($id:ID!){enablePullRequestAutoMerge('
    'input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number}}}', {'id': pid})
```

## Read CI results (the only method that works with this token)

```python
import urllib.parse
r  = json.load(urllib.request.urlopen(urllib.request.Request(
     B + f'/actions/runs?branch={urllib.parse.quote(BRANCH)}&per_page=8', headers=H)))
ci = [w for w in r['workflow_runs'] if w['name'].startswith('CI')][0]
print(ci['status'], ci['conclusion'])
jl = json.load(urllib.request.urlopen(urllib.request.Request(
     B + f"/actions/runs/{ci['id']}/jobs?per_page=40", headers=H)))
for j in jl['jobs']:
    if j['conclusion'] not in ('success', 'skipped', None):
        print('FAILED JOB:', j['name'],
              [s['name'] for s in j['steps'] if s['conclusion'] == 'failure'])
```

## The six required checks (from the live ruleset `main protection`, id 21163380)

```
TypeScript Check
Client Unit Tests (vitest)
Server Engine (typecheck + tests)
Production Build
CSS Beat E2E (multi-table + animations)
Silent Revert Guard
```

`enforcement: active`, `bypass_actors: []` — **nobody**, including a repo admin, merges around it. Squash only, 0 approvals required.

---

# 13. HOUSE LAWS THAT WILL BITE YOU

- **§10.5 HORSES ARE PLAYERS.** If you type `is_horse` to leave horses OUT of something a human gets, you are writing a bug. **Timing is part of the treatment** — the tell is the RHYTHM, not one hand. There is no "equal outcome by a different mechanism" exemption; Dan rejected that argument explicitly. This is _why_ Phase 3 must animate a horse's discard exactly like a human's.
- **§10.6 ANIMATIONS MUST ALWAYS PLAY.** Every animation and its sound, every time it is owed, for its full duration, at the player's chosen Animation Speed. **No new toggle may disable one** — speed scaling via `--animation-speed` is the only sanctioned control; `skip_animations` is dead and stays dead. Reduced motion collapses motion but never meaning (`data-motion="keep"`). **Never weaken a pin** in `tests/animations-always-play.law.test.ts`; if you replace a mechanism, move the pin in the same commit and say so.
- **§10.6 NEVER AUTO-CHANGE TABLES.** Alerts (bell, flash, haptics, tab title) yes; moving `activeIndex` without a user gesture never.
- **§5.7 POPUPS.** Title Case Every Word. **Em dashes are FORBIDDEN.** Go through the Toast layer (`src/utils/popupStyle.ts`); never hand-roll a popup, never disable the transform. Enforced by `check-ui-text` and `check-title-case` in the pre-push hook.
- **§5.8 NEVER PUSH A RED TEST.** `npx vitest run tests/` in `build-for-world-hub.yml` is what **publishes the bundle** — a red suite stops the World Hub sync for the whole estate until a human notices. Write the spec first if you like, but commit it `it.skip()` with a note, and delete the `.skip` in the implementing commit. If you find `main` already red, fixing it comes before your own work.
- **§11.5 NEVER SPEND REAL CHIPS TO TEST A RULE.** Probe money paths inside a transaction you **ROLL BACK** (`scripts/dev/probe-rpc.sql` is the pattern). What you want is the error message; `GET STACKED DIAGNOSTICS` survives a rollback. Helpers in `pg_temp`, never `public`. **Never DELETE a `table_seats` row** — it skips the refund and destroys chips. Note the correction in that section: `fn_leave_seat_and_refund` is **tournament-only** and silently refunds nothing on a cash table.
- **No emoji in source files** — breaks the SWC compiler and fails the Vercel build.
- **Commit author MUST be** `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`. Vercel will not build a commit it cannot attribute — the deployment goes to **BLOCKED with no build logs at all**, so nothing in the safety gate can even see it.
- **Write your changelog to your OWN file:** `docs/changelog/YYYY-MM-DD-<slug>.md`. **Never append to `MIGRATION-CHANGELOG.md`** — it is frozen as history and was measured as the single biggest source of merge conflict in the repo (18 of 108 conflicting PRs).
- **Deploy path:** never `vercel deploy`, never call a deploy hook, never edit `public/hub/club-arena/` in World Hub directly.

---

# 14. YOUR FIRST SESSION, STEP BY STEP

1. **`mkdir -p /tmp/tmpdir && export TMPDIR=/tmp/tmpdir`.** Clone fresh (§12). Set the git identity. Install deps.
2. **Run both full suites BEFORE changing anything.** You need to know that any red is yours. Expect ~718/10,086 (client) and ~273/3,092 (server).
3. **Read, in this order:**
   - `src/pages/TablePage.tsx` line **12605** (`case 'PLAYER_ACTION'`) through ~12712 — the whole handler, including the `isHeroEcho` split;
   - `src/pages/TablePage.tsx` line **2452** area — `handlePineappleDiscard`;
   - `src/components/table/SeatSlot.css` ~2890-2960 — `cardFoldOut` and its wrapper-blindness comment;
   - `src/services/SoundService.ts` — `playFold()`, `shouldPlay()` (~544), `playDealSequence()` (~755);
   - `server/src/engine/HandController.ts` ~930-1060 — `performDiscard`, `foldForMissedDiscard`, `owesPineappleDiscard`, `checkPineappleDiscardsComplete`;
   - `tests/animations-always-play.law.test.ts` — the first 60 lines, then two or three pins.
4. **Build 4.2 first** (`playDiscard()` in `SoundService.ts`). Small, self-contained, and 4.1 needs it.
5. **Build 4.1** (the per-seat animation). Respect §4.0 — **face down for villains**, no card identity on the public event.
6. **Build 4.3** (the settle beat: a constant in `handCompletionSpec.ts` + honour it in `checkPineappleDiscardsComplete`).
7. **Add pins** to `tests/animations-always-play.law.test.ts` using `sourceWindow` helpers.
8. **Verify:** both full suites, `tsc --noEmit` both sides, the ratchet, `noFixedSizeSourceWindows`.
9. **Ship ONE PR** titled `... [Phase 3/4]`, auto-merge armed.
10. **Verify the deploy behaviourally** (§11) — Hetzner `success` on a sha ≥ yours **and** the `hand_history` restart dip, plus the client bundle grep for the sound/animation strings.
11. **Then report to Dan in his format:**
    > **Phase 3 of 4 is done** — <what changed, what it fixes, how it was verified> — **Ready to start Phase 4 of 4.**

Dan wants evidence, not adjectives. Give him the numbers: test counts, the production string you grepped, the restart dip. He will ask you to re-audit your own work before moving on — **do it before he asks**.

---

# 15. COMPLETE FILE INDEX

## Server — engine

| File                                               | What lives there                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/engine/HandController.ts`              | `performDiscard` (~930, emits `PLAYER_ACTION` + `CARDS_DEALT` at ~958), `autoDiscard` (deprecated), `foldForMissedDiscard` (~990), **`owesPineappleDiscard`** (new, Phase 1), `checkPineappleDiscardsComplete` (**~1051 — Phase 3.3 target**), `resolvePendingPineappleDiscards` (~1560, Phase 2), `dealNextStreet` (~1322, #2072 fix), `runOutCommunityCards` (~1490), `finalizeRunout` |
| `server/src/engine/pineappleDiscardChoice.ts`      | **NEW in Phase 2.** `bestPineappleDiscard()` — the single chooser                                                                                                                                                                                                                                                                                                                        |
| `server/src/engine/ServerTableEngineBase.ts`       | `pineappleDiscardTimer`, **`pineappleDiscardDeadlines`**, `pineappleDiscardBaseDeadlineMs`, `pineappleDiscardDurationMs`, **`armPineappleDiscardSweep`**, **`pruneSettledPineappleDeadlines`**, **`extendPineappleDiscard`**, `clearLooseHandTimers`, `minPlayersToDeal` (~1318), `dealThreshold`                                                                                        |
| `server/src/engine/ServerTableEngineRunout.ts`     | `handlePineappleDiscard` (~390 — **horse delay + round open**), `submitDiscard` (~464), `broadcastAllInEquity` (~1717, Phase 2 guard), the paced runout loop (~895, ~2164)                                                                                                                                                                                                               |
| `server/src/engine/ServerTableEngineTurns.ts`      | `activateTimeBank` (~775, **discard branch at ~787**)                                                                                                                                                                                                                                                                                                                                    |
| `server/src/engine/ServerTableEngine.ts`           | **`pineappleDiscardSnapshotFields`**, `getTableState` (~181), the broadcast payload (~340), the idle payload (~617)                                                                                                                                                                                                                                                                      |
| `server/src/engine/ServerTableEngineHandEvents.ts` | `case 'PLAYER_ACTION'` (~503, **WS emit at ~554**), `case 'CARDS_DEALT'` (~312, the RLS security model)                                                                                                                                                                                                                                                                                  |
| `server/src/engine/ServerTableEngineDealing.ts`    | `persistHoleCardsWithRetry` (~2273), the deal loop + `minPlayersToDeal` gate (~636)                                                                                                                                                                                                                                                                                                      |
| `server/src/engine/HorseLogic.ts`                  | `decideDiscard` (~3698 — now delegates to `bestPineappleDiscard`)                                                                                                                                                                                                                                                                                                                        |
| `server/src/engine/HorseEval.ts`                   | `simulateEquity` (~1473), `variantInfo` (~122), `holdemPreflopScore` (~1900)                                                                                                                                                                                                                                                                                                             |
| `server/src/engine/TimeBankEngine.ts`              | `tryActivate` (~260), `arm` (~201), `getRemainingSeconds` (~412), `CLOCK_EXHAUSTED_EPSILON_SECONDS` (~115)                                                                                                                                                                                                                                                                               |
| `server/src/engine/PokerEngine.ts`                 | `evaluateHand`, **`evaluateOmahaHand` (~436 — the `length < 4` guard that silently prices two cards)**                                                                                                                                                                                                                                                                                   |
| `server/src/engine/equity/equityWorker.ts`         | `evalFn` selection on `opts.omaha` (~91)                                                                                                                                                                                                                                                                                                                                                 |
| `server/src/config/handCompletionSpec.ts`          | **All cadence constants — Phase 3.3 target**                                                                                                                                                                                                                                                                                                                                             |

## Client

| File                                                 | What lives there                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/TablePage.tsx`                            | `heroEngineCardOrderRef` (~2303), the pineapple block (~2290-2420: `heroPineappleCards`, `pineappleDeadline`, the discard-clock effect, `handlePineappleDiscard` ~2440, `soundService.playFold()` **~2452 — Phase 3.2 target**), `handleActivateTimeBank` (~16951, discard branch), **`case 'PLAYER_ACTION'` ~12605 — Phase 3.1 target**, hole-card subscription `event: '*'` (~7965), `fetchExistingHand` recovery poll (~7990), the snapshot merge + never-shrink guards (~2020-2200) |
| `src/components/table/PineappleDiscard.tsx` / `.css` | The picker; `serverNow()` countdown, `urgentAt`, the time-bank button, the docked layout                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/components/table/SeatSlot.tsx` / `.css`         | `isMucked` (~198), reveal/muck ordering (~382), removal window (~1098); **`cardFoldOut` CSS ~2896 + keyframes ~2915 — reuse for Phase 3.1**                                                                                                                                                                                                                                                                                                                                             |
| `src/components/table/TableConnectionBanner.tsx`     | `'Reconnecting To The Table'` (~79) — the §7 evidence                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/utils/mapEngineSnapshot.ts`                     | `discardDeadline` / `discardDurationMs` mapping, `recordServerTime` (~454), the seat sizing law (~310)                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/utils/serverClock.ts`                           | `serverNow()` (~117), `recordServerTime()` (~86), `clockOffsetMs()`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/services/SoundService.ts`                       | `shouldPlay` (~544), `playDeal` (~737), `playDealSequence` (~755), `playCheck` (~884), `playFold`; **add `playDiscard()` here**                                                                                                                                                                                                                                                                                                                                                         |
| `src/services/GameServerAPI.ts`                      | `submitDiscard` (~768), `activateTimeBank` (~298)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/utils/handReplay.ts`                            | `'discard'` verb (~167), `pineapple_discard` street (~287), `VERB_LABEL` — **Phase 4**                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/table/HandHistoryPanel.tsx`          | discard colour (~182) — **Phase 4**                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/pages/MultiTablePage.tsx`                       | Mounts up to 4 `TablePage`s; slot classes (~3769); only `pointer-events: none` separates inactive slots — the reason the picker needed the `isActive` gate                                                                                                                                                                                                                                                                                                                              |

## Tests

| File                                                   | Count  | Note                                                       |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------- |
| `server/src/engine/PineappleDiscardClock.test.ts`      | 10     | Phase 1 — deadline map, publication, time bank, sweep      |
| `server/src/engine/PineappleDiscardChoice.test.ts`     | 7      | Phase 2 — includes the old rule computed alongside the new |
| `server/src/engine/PineappleAllInEquity.test.ts`       | 4      | Phase 2 — equity suppression, Omaha untouched              |
| `server/src/engine/PineappleThreeCardShowdown.test.ts` | 5      | #2072 — the money bug                                      |
| `server/src/engine/PineappleDiscardFold.test.ts`       | 6      | pre-existing — a missed discard folds                      |
| `tests/pineapple-discard-picks-the-right-card.test.ts` | 20     | client — index translation, subscription, picker, clock    |
| `tests/pineapple-discard.test.tsx`                     | 7      | pre-existing — the picker component                        |
| **`tests/animations-always-play.law.test.ts`**         | **45** | **Phase 3 pins go here**                                   |
| `tests/unit/timeBankSeatFeedbackAndCards.test.ts`      | —      | will catch you if you toast on the armed branch            |
| `tests/unit/noFixedSizeSourceWindows.test.ts`          | 1      | the byte-count gate                                        |
| `tests/helpers/sourceWindow.ts`                        | —      | use these, never byte counts                               |
| `server/src/engine/DisconnectMidTurnTimeBank.test.ts`  | 8      | the engine-harness pattern I copied                        |

## Docs / config

- `docs/changelog/2026-08-31-pineapple-discard-picks-the-right-card.md`
- `CLAUDE.md` §5.7, §5.8, §10.5, §10.6, §11.5, §12
- `supabase/migrations/20260312_secure_hole_cards_fix.sql` — `table_hole_cards`, RLS, the upsert
- `.github/workflows/ci.yml` — the six required jobs; the ratchet step at ~340
- `.github/workflows/auto-deploy-hetzner.yml`, `build-for-world-hub.yml`
- `scripts/ci/report-source-grep-tests.mjs`

---

**Good luck. The guards in this repo are unusually good — trust them, and when one goes red, assume it is right and you are wrong. That was true every single time it happened to me.**
