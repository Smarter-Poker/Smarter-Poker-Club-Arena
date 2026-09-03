# 2026-08-15 — Dead action buttons vs all-in + permanent table freezes

Nine issues reported by Dan. Two were hard bugs root-caused against production
data; seven were UI. Shipped in PR #54 (squash `f041ccb1`).

## 1. Facing an all-in, Fold and Call did nothing; hero timed out

**Root cause.** `src/pages/TablePage.css` — `.table-page--allin-mode .action-panel`
carried `pointer-events: none`, and `setIsAllInMode(true)` fires on ANY player's
all-in (`TablePage.tsx`, WS `PLAYER_ACTION` handler), not just hero's. An
opponent's shove therefore made hero's own Fold / Call / All-In buttons
physically unclickable for the remainder of the hand.

The browser never dispatched the click at all, so `haptic`, `onAction`,
`handleActionPanelAction`, `validateAndExecuteAction` and `submitAction` all
never ran — which is why there was NO error toast. The auto-fold timer is a
pure-JS path that never touches the DOM, so it fired normally and folded hero.
That asymmetry (DOM path dead, JS path alive) is the signature of a
pointer-events block, and it is why this presented as a "silent" failure.

**Production evidence.** hand_history hand #1315, table `3f0682f1`:

```
river  seat 2  all_in  249.46   ts 1786808225911
river  seat 8  fold      0      ts 1786808256020   <- Dan
```

Delta 30,109 ms = 15s clock + 2s grace + auto-activated time bank. Every other
Dan action in that hand took 2-11s.

**Fix (defence in depth — all three must fail to regress):**

1. `pointer-events` removed from the selector, with a comment forbidding its
   return. Added `.table-page--allin-mode.table-page--hero-turn .action-panel
{ opacity: 1 }`.
2. Dramatic mode no longer engages while hero still has live action.
3. `TURN_CHANGE` calls `setIsAllInMode(false)` whenever action reaches hero.
   Previously it was cleared only on HAND_STARTED and 3s after HAND_COMPLETE,
   so one shove blacked out the panel for every remaining street — and in
   multiway pots, for every other live player too.

**Verified live:** the deployed bundle
`public/hub/club-arena/assets/TablePage-DPYscDP9-v6.css` now serves
`table-page--allin-mode .action-panel{opacity:.35;transition:opacity .5s ease}`
with no pointer-events, confirmed by curl against smarter.poker.

## 2. Tables freezing permanently

**Production evidence.** Ten cash tables stopped dealing inside a 48-second
window (15:38:55-15:39:43Z) and were still dead 18+ minutes later with funded,
non-sitting-out seats, while unaffected tables dealt 9-11 hands/min throughout.
`hand_state_snapshots` shows them stopped at `is_complete=false, stage=preflop`
— the hand was dealt and the first actor never acted. Table `3f0682f1` (5 horses

- 1 human) died at hand #1320, the hand visible in Dan's own screenshot.

**Root causes and fixes:**

| #   | Cause                                                                                                                                                                                                                                                                                                                     | Fix                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `dealingLoop()` launched unawaited/uncaught in `ServerTableEngineBase.start()`. A throw from inside the loop's own catch escapes it; `index.ts` swallows the rejection; `running` stays true; `isRunning()` lies; GameServer never reaps; discovery never rebuilds. **This is what made every other bug here permanent.** | `.catch()` -> `killForRestart()`                                            |
| 2   | Turn clock armed LAST, after an unwrapped `broadcastCurrentState()` and the only `hub.emitEvent` call site in the engine without a try/catch. One bad subscriber socket skipped `handleTurnChange` — the sole line that arms a timer or schedules a horse action.                                                         | Arm clock first; delivery best-effort; `forceArmTurnTimer` fallback         |
| 3   | Horse actions had no fallback when the engine REJECTED the action. `HandController.performAction` returns `false`, it does not throw, so the existing catch never fired. The human path was fixed for this in July ("the table froze with no clock"); the horse path was missed.                                          | Check the boolean; degrade to check-if-free/fold                            |
| 4   | No fetch timeout anywhere in the server (zero AbortController / Promise.race in `server/src`). One hung socket stalls a table forever. Ten tables failing in 48s is a degrading-transport signature, not ten logic bugs.                                                                                                  | 15s abort at the Supabase client; listed as transient in the loop's backoff |
| 5   | `emitTurnChange()` silently returned on seat `-1`, hanging the hand until the 10-minute void. `start()` already guarded this (AUDIT FIX 2026-07-19); `advanceGame`/`advanceStage` did not.                                                                                                                                | Advance the stage instead of hanging                                        |
| 6   | No table watchdog existed. `isRunning()` was the only liveness signal and it cannot go false.                                                                                                                                                                                                                             | See below                                                                   |

**Watchdog.** Rides the existing 10s heartbeat entry (no new interval, no new
scheduler). Tracks `lastProgressAtMs`, stamped on accepted actions, turn
changes, hand starts. Escalates and never touches chips directly:

- Tier 1: seat lost its clock -> re-arm it
- Tier 2: still stalled -> force check-if-free/fold, restarting the event cascade
- Tier 3: unrecoverable -> `killForRestart()` so GameServer rebuilds the engine

Plus a `GameServer` zombie reaper: if the discovery RPC still lists a table as
ready but its engine has shown no progress for 3 minutes, drop it so the next
5s cycle rebuilds it. **This alone would have recovered all ten tables in <5s
instead of leaving them dead for 18+ minutes.**

## 3-9. UI

- Instant seating: seat paints on tap before any network call; chips land on
  confirm; the buy-in RPC runs behind it with seat rollback on rejection.
  Previously TWO sequential round-trips completed before anything appeared —
  the "very long delay", which on a slow link read as a silent failure.
- Hero avatar 1.33x villains (redeclared `--seat-avatar-size` on `.seat--hero`
  so wrap + ring + photo can never drift), moved lower (y 91 -> 95.5), hole
  cards re-anchored to the avatar midline instead of the name box.
- Countdown depletes clockwise (top -> right -> bottom -> left) and stays
  yellow a full 15s. All 26 live tables run `action_time_seconds = 15` but the
  colour keyframe hardcoded the red snap at 80%, so yellow only ever lasted
  12s. Red is now reserved for time-bank overtime.
- Hero never faded while `seat--in-hand`; a folded hero still dims.
- Spotlight always on: dropped the `highlight_active_players` and
  `isHandInProgress` gates, and the acting seat is now LIT rather than the
  effect relying solely on dimming others (which vanished once most seats had
  folded — exactly when Dan noticed it missing).
- Bet multipliers: presets were `bigBlind * N` then clamped into
  `[minRaise, maxRaise]`, so facing a raise 2X/3X/4X all collapsed to the same
  `minRaise` value and the amount never moved. Now multiples of the bet being
  faced, 5X added, correct pot-sized-raise math postflop.
- Table centre brand (logo + date/game/blinds/club), hand number to upper right.
- Occupied tables render `EMPTY` instead of `+ SIT`, click target removed.

## Process note — WORK WAS DESTROYED MID-SESSION

An Antigravity `git reset --hard origin/main` fired partway through and wiped
every uncommitted client edit plus `ServerTableEngineBase.ts` (reflog
`HEAD@{0}: reset: moving to origin/main`). Recovered and re-applied. Confirms
CLAUDE.md RULE 13: commit to a branch after every meaningful change, not at
session end. All subsequent work was committed within minutes of each edit.

## Not done / follow-ups

- `server` vitest could not run: pre-existing esbuild host(0.21.5)/binary(0.27.3)
  mismatch in `server/node_modules`. Unrelated to this branch, but it means the
  engine test suite is currently un-runnable and should be repaired.
- `clearTurnTimer()` in `ServerTableEngineTurns.ts` is still an empty function
  that four call sites believe cancels timers (notably the all-in runout
  "pause all timers" path). Left alone deliberately — `startTurnTimer` calls it
  on every re-arm, so making it real without auditing that interaction risks
  cancelling disconnect/timebank entries. Needs its own change.
- Time-bank auto-activation re-arms the enforcement clock for the whole
  remaining POOL (`getRemainingSeconds`, up to 120 x 15s = 30 min) rather than
  the 15s just granted. The separate 15s timebank deadline usually saves it,
  but its callback bails on a per-table FSM guard. Deferred.
- 14 `performAction(` call sites treat the return as throw-or-succeed; only
  two now handle `false`. Worth a sweep.
