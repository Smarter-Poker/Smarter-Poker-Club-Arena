# STEP 1: REMOVAL CATALOG

## Every Reference That Must Be Ripped Out

**Date:** 2026-03-24
**Governed by:** MIGRATION-LAW.md
**Scope:** Establish ONE source of truth — server only

---

## SUMMARY OF WHAT EXISTS RIGHT NOW

The client (TablePage.tsx) runs its OWN game engine in parallel with the server.
The comments literally say "LOCAL engine is authoritative" (line 3937, line 4112).
The server is treated as a secondary fire-and-forget notification system.

**This is backwards. The server must be authoritative. The client must be a dumb terminal.**

---

## FILE: src/pages/TablePage.tsx

### A. ENGINE IMPORTS TO REMOVE (6 imports)

| Line | Import                                                                                        | Why Remove                          |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| 74   | `import { timeBankEngine } from '../engine/TimeBankEngine'`                                   | Time bank must run on server only   |
| 118  | `import { Deck, compareHands, calculatePots, determineWinners } from '../engine/PokerEngine'` | Game logic must run on server only  |
| 119  | `import { HandController } from '../engine/HandController'`                                   | THE core dual-engine problem        |
| 120  | `import { serverActionValidator } from '../engine/ServerActionValidator'`                     | Validation must run on server only  |
| 122  | `import { OFCPineappleEngine } from '../engine/OFCPineappleEngine'`                           | Game logic must run on server only  |
| 132  | `import { monteCarloEquity } from '../engine/MonteCarloEquity'`                               | Equity calc must run on server only |

**Keep:** `import GameServerAPI, { submitAction } from '../services/GameServerAPI'` (line 130) — this is the correct server communication layer.

### B. handControllerRef — 51 REFERENCES (was estimated 48, actual count is 51)

| Line | Code                                                                                      | Category                                 |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| 2711 | `const handControllerRef = useRef<HandController \| null>(null)`                          | DECLARATION — delete                     |
| 2730 | `if (locks.handActive \|\| locks.activeHC \|\| handControllerRef.current)`                | GUARD — remove HC check                  |
| 2812 | `handControllerRef.current = hand`                                                        | ASSIGNMENT — delete                      |
| 1047 | `const engineState = handControllerRef.current?.getState()`                               | STATE READ — replace with server state   |
| 2919 | `const hcState = handControllerRef.current?.getState()`                                   | STATE READ — replace with server state   |
| 3034 | `if (isHorse && handControllerRef.current)`                                               | GUARD — remove                           |
| 3041 | `const hcState = handControllerRef.current.getState()`                                    | STATE READ — replace with server state   |
| 3081 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 3089 | `const hcStateNow = handControllerRef.current.getState()`                                 | STATE READ — replace with server state   |
| 3124 | `handControllerRef.current`                                                               | REFERENCE — remove                       |
| 3155 | `const result = handControllerRef.current.performAction(...)`                             | LOCAL ACTION — replace with submitAction |
| 3162 | `const hcStateAfter = handControllerRef.current.getState()`                               | STATE READ — replace with server state   |
| 3242 | `const engineState = handControllerRef.current?.getState()`                               | STATE READ — replace with server state   |
| 3283 | `const communityCards = handControllerRef.current?.getState()?.communityCards \|\| []`    | STATE READ — replace with server state   |
| 3516 | `handControllerRef.current = null`                                                        | CLEANUP — delete                         |
| 3653 | `handControllerRef.current = null`                                                        | CLEANUP — delete                         |
| 3839 | `if (!handControllerRef.current \|\| !tableId) return`                                    | GUARD — simplify                         |
| 3840 | `const state = handControllerRef.current.getState()`                                      | STATE READ — replace with server state   |
| 3870 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 3872 | `const foldResult = handControllerRef.current.performAction(tableState.heroSeat, 'fold')` | LOCAL ACTION — replace with submitAction |
| 3943 | `if (!handControllerRef.current \|\| !tableId) return false`                              | GUARD — simplify                         |
| 3949 | `const state = handControllerRef.current.getState()`                                      | STATE READ — replace with server state   |
| 4009 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4010 | `handControllerRef.current.performAction(heroSeat, 'fold')`                               | LOCAL ACTION — replace with submitAction |
| 4032 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4033 | `handControllerRef.current.performAction(heroSeat, 'check')`                              | LOCAL ACTION — replace with submitAction |
| 4055 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4056 | `handControllerRef.current.performAction(heroSeat, 'call')`                               | LOCAL ACTION — replace with submitAction |
| 4094 | `const hcState = handControllerRef.current?.getState?.()`                                 | STATE READ — replace with server state   |
| 4131 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4132 | `handControllerRef.current.performAction(heroSeat, 'fold')`                               | LOCAL ACTION — replace with submitAction |
| 4145 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4146 | `handControllerRef.current.performAction(heroSeat, 'check')`                              | LOCAL ACTION — replace with submitAction |
| 4159 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4160 | `handControllerRef.current.performAction(heroSeat, 'call')`                               | LOCAL ACTION — replace with submitAction |
| 4176 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4177 | `handControllerRef.current.performAction(heroSeat, 'raise', clamped)`                     | LOCAL ACTION — replace with submitAction |
| 4193 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4194 | `handControllerRef.current.performAction(heroSeat, 'all_in')`                             | LOCAL ACTION — replace with submitAction |
| 4231 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4232 | `const result = handControllerRef.current.performAction(heroSeat, 'raise', clampedRaise)` | LOCAL ACTION — replace with submitAction |
| 4265 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4266 | `handControllerRef.current.performAction(heroSeat, 'all_in')`                             | LOCAL ACTION — replace with submitAction |
| 4379 | `if (handControllerRef.current)`                                                          | GUARD — remove                           |
| 4380 | `const state = handControllerRef.current.getState()`                                      | STATE READ — replace with server state   |
| 4399 | `if (!handControllerRef.current) return`                                                  | GUARD — remove                           |
| 4400 | `const state = handControllerRef.current.getState()`                                      | STATE READ — replace with server state   |
| 4526 | `const handState = handControllerRef.current?.getState()`                                 | STATE READ — replace with server state   |
| 4547 | `const handState2 = handControllerRef.current?.getState()`                                | STATE READ — replace with server state   |
| 4995 | `const handState = handControllerRef.current?.getState()`                                 | STATE READ — replace with server state   |
| 5034 | `const handState = handControllerRef.current?.getState()`                                 | STATE READ — replace with server state   |

### C. broadcastLocalHandState — 14 REFERENCES

| Line | Code                                                  | Category                                      |
| ---- | ----------------------------------------------------- | --------------------------------------------- |
| 3838 | `const broadcastLocalHandState = useCallback(() => {` | DECLARATION — delete entire function          |
| 3878 | `broadcastLocalHandState()`                           | CALL (inside autoFoldTimer) — delete          |
| 3890 | `broadcastLocalHandState, sendAction]`                | DEPENDENCY — remove from deps array           |
| 4015 | `broadcastLocalHandState()`                           | CALL (after fold) — delete                    |
| 4038 | `broadcastLocalHandState()`                           | CALL (after check) — delete                   |
| 4061 | `broadcastLocalHandState()`                           | CALL (after call) — delete                    |
| 4136 | `broadcastLocalHandState()`                           | CALL (after fold in quick actions) — delete   |
| 4150 | `broadcastLocalHandState()`                           | CALL (after check in quick actions) — delete  |
| 4164 | `broadcastLocalHandState()`                           | CALL (after call in quick actions) — delete   |
| 4182 | `broadcastLocalHandState()`                           | CALL (after raise in quick actions) — delete  |
| 4199 | `broadcastLocalHandState()`                           | CALL (after all-in in quick actions) — delete |
| 4207 | `broadcastLocalHandState]`                            | DEPENDENCY — remove from deps array           |
| 4241 | `broadcastLocalHandState()`                           | CALL (after raise) — delete                   |
| 4273 | `broadcastLocalHandState()`                           | CALL (after all-in) — delete                  |

### D. performAction LOCAL CALLS — 14 REFERENCES

These are calls to `handControllerRef.current.performAction()` — local engine execution.
Each one must be replaced with `await submitAction()` to the server.

| Line | Action         | Current Code                                                               | Replacement                                                    |
| ---- | -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 3155 | HORSE auto     | `handControllerRef.current.performAction(...)`                             | `await submitAction(tableId, userId, action)`                  |
| 3872 | auto-fold      | `handControllerRef.current.performAction(heroSeat, 'fold')`                | `await submitAction(tableId, userId, 'fold')`                  |
| 4010 | fold           | `handControllerRef.current.performAction(heroSeat, 'fold')`                | Already has submitAction on line 4017 — just remove local call |
| 4033 | check          | `handControllerRef.current.performAction(heroSeat, 'check')`               | Already has submitAction on line 4040 — just remove local call |
| 4056 | call           | `handControllerRef.current.performAction(heroSeat, 'call')`                | Already has submitAction on line 4063 — just remove local call |
| 4132 | fold (quick)   | `handControllerRef.current.performAction(heroSeat, 'fold')`                | Already has submitAction on line 4138 — just remove local call |
| 4146 | check (quick)  | `handControllerRef.current.performAction(heroSeat, 'check')`               | Already has submitAction on line 4152 — just remove local call |
| 4160 | call (quick)   | `handControllerRef.current.performAction(heroSeat, 'call')`                | Already has submitAction on line 4166 — just remove local call |
| 4177 | raise (quick)  | `handControllerRef.current.performAction(heroSeat, 'raise', clamped)`      | Already has submitAction on line 4184 — just remove local call |
| 4194 | all-in (quick) | `handControllerRef.current.performAction(heroSeat, 'all_in')`              | Already has submitAction on line 4201 — just remove local call |
| 4232 | raise          | `handControllerRef.current.performAction(heroSeat, 'raise', clampedRaise)` | Already has submitAction on line 4244 — just remove local call |
| 4266 | all-in         | `handControllerRef.current.performAction(heroSeat, 'all_in')`              | Already has submitAction on line 4276 — just remove local call |

**KEY INSIGHT:** Most action handlers already call BOTH the local engine AND submitAction.
The pattern is: local engine first (authoritative), then submitAction as fire-and-forget backup.
We FLIP this: submitAction becomes the ONLY call, local engine calls get deleted.

### E. "AUTHORITATIVE" COMMENTS TO REMOVE

| Line | Text                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------ |
| 2366 | `// The authoritative auto-fold timer...`                                                        |
| 3447 | `// Use HC's authoritative pot value`                                                            |
| 3481 | `// Use event.pot (authoritative HC value)`                                                      |
| 3572 | `// Use authoritative sawFlop from HAND_COMPLETE event`                                          |
| 3937 | `// Action handlers — LOCAL engine is authoritative → broadcast via Supabase Realtime (PRIMARY)` |
| 4112 | `// Architecture: LOCAL engine is authoritative → broadcast via Supabase Realtime (PRIMARY)`     |

### F. HandController INITIALIZATION BLOCK (~lines 2711-2813)

This entire block creates a new HandController instance on the client.
It must be deleted entirely. The server creates and manages HandControllers.

---

## OTHER FILES WITH ENGINE IMPORTS

| File                                    | Line  | Import                                           | Action                                |
| --------------------------------------- | ----- | ------------------------------------------------ | ------------------------------------- |
| src/pages/FlashPoolPage.tsx             | 18    | `flashPoolEngine`                                | DEFER — FlashPool is Phase 6          |
| src/pages/admin/EngineDashboard.tsx     | 3-4   | `cashGameOrchestrator`, `tournamentOrchestrator` | DEFER — Admin dashboard, not gameplay |
| src/services/HydraService.ts            | 73,75 | `HorseDecision` type                             | TYPE ONLY — safe for now              |
| src/services/BBJService.ts              | 19    | `EvaluatedHand` type                             | TYPE ONLY — safe for now              |
| src/services/HandPersistenceService.ts  | 19    | `HandController, HandEvent` type                 | TYPE ONLY — safe for now              |
| src/services/FinancialCronService.ts    | 20    | `rakebackEngine`                                 | MOVE TO SERVER in Phase 6             |
| src/services/RakeService.ts             | 5     | `rakebackEngine`                                 | MOVE TO SERVER in Phase 6             |
| src/components/table/SpinItWheel.tsx    | 14    | `SpinPrizeConfig, SpinMultiplier` type           | TYPE ONLY — safe for now              |
| src/components/table/StraddleToggle.tsx | 15    | `straddleEngine`                                 | MOVE TO SERVER in Phase 4             |

**STEP 1 SCOPE: Only TablePage.tsx engine removal. Other files are later phases.**

---

## WHAT THE CLIENT KEEPS

1. `submitAction()` from GameServerAPI — HTTP POST to server (CORRECT)
2. `sendAction()` from useTableWebSocket — WebSocket action send (CORRECT)
3. `subscribeToHandState()` — Supabase Realtime listener (CORRECT)
4. All UI rendering — cards, chips, animations, sounds (CORRECT)
5. All Zustand state — populated by Realtime broadcasts (CORRECT)

---

## EXECUTION ORDER FOR STEP 1

Following MIGRATION-LAW.md Law 4 (one change at a time):

1. Read each action handler function in full (Law 3: read before changing)
2. Remove handControllerRef declaration and initialization block
3. Remove broadcastLocalHandState declaration and function body
4. For each action handler (fold, check, call, raise, all-in):
   a. Remove `if (handControllerRef.current)` guard
   b. Remove `handControllerRef.current.performAction(...)` call
   c. Remove `broadcastLocalHandState()` call
   d. Make `submitAction()` the primary (await it, handle errors)
   e. Verify the handler
5. Remove remaining handControllerRef.getState() reads (replace with tableState from Zustand)
6. Remove engine imports
7. Remove "authoritative" comments
8. Run grep verification
9. Run npx tsc --noEmit
10. Document all changes in MIGRATION-CHANGELOG.md
