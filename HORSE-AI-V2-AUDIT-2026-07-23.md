# HORSE AI V2 — DEEP AUDIT & REBUILD (2026-07-23)

**Scope:** Line-by-line audit of the entire horse system — the 574 horses in the
database, the server-side decision engine (`HorseLogic`), the turn pipeline in
`ServerTableEngine`, the fleet/lifecycle managers, and every game variant's
decision path on every street. Everything below was found, fixed, and then
verified by simulation before being written back to the repo.

---

## 1. WHAT WAS AUDITED

| Layer           | Files                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Decision engine | `server/src/engine/HorseLogic.ts`                                                                 |
| Turn pipeline   | `server/src/engine/ServerTableEngine.ts` (scheduleHorseAction, handlePineappleDiscard)            |
| Game engine     | `server/src/engine/HandController.ts`, `StateMachine.ts`, `PokerEngine.ts`, `MonteCarloEquity.ts` |
| Fleet ops       | `server/src/services/HorseFleetManager.ts`, `HorseLifecycleManager.ts`, `supabase.ts`             |
| Data            | `profiles` table (574 horses), `horse_profile` jsonb column                                       |

The legacy client-side engines (`src/lib/poker-engine/HorsePokerBrain.js`,
`src/services/HydraService.ts`, `BotLogic`, `HorseBrainAdapter`) are dead code
after the server-authoritative migration — the March bug report
(`HORSE_SYSTEM_BUG_REPORT.md`) targeted those files and is now largely
obsolete. The live decision path is:
`HandController TURN_CHANGE -> ServerTableEngine.scheduleHorseAction -> HorseLogic.decide -> performAction`.

---

## 2. CRITICAL FINDINGS (all fixed)

### F1 — All 574 horses played the IDENTICAL style

`profiles.horse_profile` is a **jsonb** column and every row contained `{}`.
The server treated it as a string: `styleMap[player.horse_profile || 'balanced']`.
`{}` is truthy, `styleMap[{}]` is `styleMap["[object Object]"]` = undefined →
**every horse fell back to 'balanced'**. The five styles, think-time ranges,
and bluff frequencies were dead configuration.
**Fix:** new `resolveHorseStyle()` accepts strings, jsonb objects
(`{"style":"tag","aggression":1.05,...}`), legacy names (reg/fish/nit/maniac),
and falls back to a deterministic hash of the horse's id — the fleet stays
diverse even with empty profiles. Additionally, all 574 rows were populated
with real profiles (tag 102 / lag 121 / balanced 118 / tricky 115 / grinder 118) plus per-horse aggression/tightness/bluffFreq/sizing jitter, so **no two
horses play exactly alike**.

### F2 — Horses could not price a draw (folded every flush draw)

Postflop "strength" was a static made-hand lookup (pair = 0.2-0.45, etc.).
A nut flush draw evaluates as high card ≈ 0.1 → horses folded virtually every
draw to a single bet, never semi-bluffed, and could be printed on by anyone
who bet small every flop.
**Fix:** postflop decisions now run a real Monte Carlo equity simulation
(draw equity priced by the runout), sized against actual pot odds, opponent
count, SPR, and implied odds, with style-driven semi-bluff and bluff mixes.

### F3 — Betting-round live-lock (engine bug, affects humans too)

`HandController.isBettingRoundComplete()` compared bets with strict `===`.
A call sets `bet += (currentBet - bet)`; IEEE 754 drift can land it at
`15.580000000000002` vs a `currentBet` of `15.58`. The round then **never
completes** — TURN_CHANGE loops until the 120s hand timeout voids the hand.
Reproduced in simulation (~1 in 2,000 hands; more often at odd stake sizes).
**Fix:** half-cent tolerance comparison (chips are whole cents per Bible V8
§2.6, so 0.005 can never mask a genuinely unmatched bet). Re-ran 6,100
simulated hands: zero stalls.

### F4 — Stale think-timer could act in the WRONG hand

`scheduleHorseAction`'s setTimeout only checked "is it still this seat's
turn". If the hand ended and a new hand started within the think window, the
same seat can be current player again — the stale timer would fire an action
computed for the **previous hand** into the new one.
**Fix:** the callback now verifies `handControllerRef === this.handController`
before acting.

### F5 — Pineapple horses discarded a random card

Horses never responded to `PINEAPPLE_DISCARD_REQUIRED`; the expiry
auto-discard always throws away the **last** card. A horse flopping a set
8-8-3 would discard whatever sat at index 2.
**Fix:** horses now pick the equity-maximizing discard (Monte Carlo over the
three keep-two options) with a humanlike delay; the expiry auto-discard
remains as the safety net.

### F6 — Pineapple all-in showdowns used THREE hole cards (illegal hand)

When everyone was all-in before the discard phase, the runout skipped the
discard entirely and showdown scored best-5-of-8 — an illegal extra-card
advantage. **Fix:** `HandController.runOutCommunityCards` now force-resolves
pending discards (best-two keep) the moment the flop is on the board.
Verified: 0 three-card showdowns in 300 simulated pineapple hands.

### F7 — FSM violation logged on EVERY pineapple hand

The hand state machine had no `pineapple_discard -> flop` edge, but
`HandController` performs exactly that transition, so every pineapple hand
spammed "Invalid transition" warnings (into Sentry, in production).
**Fix:** added the missing edges (`-> flop`, `-> showdown`).

---

## 3. THE V2 DECISION ENGINE (full rewrite of HorseLogic.ts)

**Preflop — every variant:**

- Position-aware (EP/MP/CO/BTN/SB/BB computed from the dealer button and live seats).
- A hand-tuned 169-combo classifier for NLHE (replaces the Chen-style score
  that ranked 66 above AKs for 3-bets), with short-deck adjustments.
- Hutchison-style Omaha scoring for plo4/plo5/plo6 (pairs, double-suited to
  aces, rundown connectivity, dangler penalties) + A2/A3 low credit for plo8.
- Pineapple 3-card scoring (best two + backup value).
- Raise-context aware: unopened / limped / single-raised / 3-bet+ pots read
  from the live action history; limper-count iso-sizing; squeeze sizing;
  IP 3x vs OOP ~3.8x 3-bets; 2.3x 4-bets; jam logic when committed.
- Short-stack push/fold under 12bb.
- Blind defense with price discounts; never folds a free check; never folds
  to a limp for the big blind.

**Postflop — every street, every variant:**

- Real Monte Carlo equity vs the live opponent count (up to 4 modeled),
  variant-correct: true Omaha 2+3 evaluation, plo8 hi/lo split with
  qualifying-low and scoop logic, short-deck rankings (flush > full house,
  A6789 wheel), pineapple mirrored hole-card counts.
- Value bets sized by strength and street (thin 33% → strong 85% pot),
  multiway thresholds tighten per extra opponent, slowplay/trap and
  check-raise mixes by style, semi-bluffs driven by actual draw equity,
  disciplined bluff-catching vs small river bets, SPR-based commitment.
- Pot-limit sizing caps computed exactly the way the engine validates them.

**Bulletproof legality:**

- Every decision passes through `legalize()` and then a final
  `verifyAmount()` check against **the engine's own `validateAction()`**,
  with one-cent nudges for float-boundary cases and a raise→call→check
  fallback ladder. A horse action can no longer be rejected — measured **0
  rejections in 6,100 full hands** (was 524 per 2,100 hands before the fix).
- All amounts are whole cents (Bible V8 §2.6); directional cent-snapping
  (floor against caps, ceil against minimums).
- A top-level try/catch guarantees a legal check/fold even on corrupted input
  — a horse can never hang a table.

**Speed (measured, per decision, including equity simulation):**

| Variant           | Before | After       |
| ----------------- | ------ | ----------- |
| NLHE / short deck | ~24 ms | **0.45 ms** |
| Pineapple         | ~63 ms | **0.5 ms**  |
| PLO4              | ~30 ms | **7.5 ms**  |
| PLO5/PLO6         | ~34 ms | **~10 ms**  |
| PLO8 (hi-lo)      | ~19 ms | **5 ms**    |

Achieved with a new allocation-free bitmask evaluator (cross-validated
against the authoritative `PokerEngine` evaluator on **94,000 random
comparisons — 100% agreement**, including short-deck and Omaha low), a
partial Fisher-Yates deal, an xorshift PRNG for the hot loop, and a bounded
preflop equity cache.

**Humanlike pacing kept:** think times are style- and situation-aware
(snap-folds preflop, tanks on big river decisions, faster heads-up), clamped
inside the table's action timer. Horses remain indistinguishable from real
players per Bible V8.

---

## 4. FLEET & DATA FIXES

- **HorseFleetManager:** removed an N+1 query (club_id re-fetched per table
  per 30s seeding cycle — now selected with the table list).
- **supabase.ts loadSeatedPlayers:** passes the raw jsonb profile through
  instead of coercing `{}` to a truthy garbage value.
- **types.ts:** `horse_profile` typed as `string | Record<string, unknown>`
  to match the actual column type.
- **Database:** all 574 horses updated from `{}` to full profiles
  (style + aggression 0.90-1.15, tightness 0.92-1.10, bluffFreq 0.85-1.15,
  sizingMultiplier 0.90-1.10 — deterministic per-horse via md5, so re-running
  the migration is idempotent).

---

## 5. VERIFICATION (all run before delivery)

1. **Legality fuzz:** 2,800 randomized states across all 7 variants × all
   streets × 5 styles → **100% legal** per the engine's own validator; all
   amounts whole cents; no NaN.
2. **Evaluator cross-validation:** 94,000 random hand comparisons vs
   `PokerEngine` (holdem, short deck, plo4/5/6, plo8 low) → **100% agreement**.
3. **Full-hand simulation:** 6,100 complete hands (2,100 across all variants
   - 4,000 short-deck stress) driven end-to-end through the real
     `HandController`: **0 rejected actions, 0 exceptions, 0 chip-conservation
     errors, 0 stalls, 0 illegal pineapple showdowns, 0 FSM violations.**
     Flop seen in ~55% of hands, river in ~48% — healthy, human-looking flow.
4. **Style differentiation:** 3,000 5-max NLHE hands with fixed seats:
   grinder VPIP 34%/PFR 11.5%/AF 0.93 → lag VPIP 38%/PFR 18%/AF 1.38 —
   the five styles now genuinely play differently (they did not before).
5. **Unit tests:** new `HorseLogic.test.ts` (legality fuzz, poker-sanity
   frequencies, discard intelligence, style resolution, evaluator
   cross-validation, performance budget) added to the vitest suite.
6. **TypeScript:** full-package `tsc --noEmit` in the audit sandbox (external
   modules stubbed — the sandbox blocks npm): zero errors in any modified
   file; plus an import smoke test of the full `ServerTableEngine` wiring.
   Run `cd server && npx tsc --noEmit && npm test` locally before deploying —
   the new `HorseLogic.test.ts` suite runs in your vitest setup.

---

## 6. DEPLOY NOTES

- Server changes only (`server/` on Hetzner). No client rebuild needed.
- The DB profile migration has already been applied (idempotent; only touches
  rows where `horse_profile` is `{}` or NULL).
- The horses will pick up their new brains on the next PM2 restart of the
  game server.

## 7. RECOMMENDED FOLLOW-UPS (not done, flagged)

1. `HorseFleetManager.DEFAULT_TABLES` still spawns only the single NLH 1/2
   table ("quality before scaling"). The engine + horses are now verified on
   all 7 variants — adding PLO/short-deck/pineapple tables is a config change.
2. `getFleetHealth()` reads `horse_status`, but seeding no longer maintains
   that column (horses multi-table). Health numbers are cosmetic right now.
3. The engine allows an over-pot all-in in pot-limit games ('all_in' skips
   the pot-limit cap in `validateAction`). Horses never do this (they cap at
   pot), but a modified client could. Worth a server-side clamp.
4. Tournament horse play runs through the same decision path and inherits all
   improvements, but ICM/ladder awareness is not modeled yet.
