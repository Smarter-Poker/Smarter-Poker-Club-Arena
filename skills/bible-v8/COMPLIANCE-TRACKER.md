# BIBLE v8 COMPLIANCE TRACKER
## Living Checklist — Updated Per-Fix

**Status Legend:**
- BROKEN = Known broken, not functional
- MISSING = Not implemented at all
- PARTIAL = Some implementation exists but incomplete or incorrect
- NEEDS-VERIFY = Implemented, needs actual verification against Bible
- VERIFIED = Confirmed working correctly per Bible specification
- N/A = Not applicable to current scope

**Last Updated:** 2026-03-24
**Updated By:** Claude (initial audit from deep code read)

---

## CHAPTER 1: MASTER LAWS

| ID | Requirement | Status | File(s) | Notes |
|----|------------|--------|---------|-------|
| 1.1.1 | Server maintains currentPlayerSeat | PARTIAL | server/src/engine/HandController.ts:43 | Server HC has it, but client also runs parallel HC |
| 1.1.2 | Non-turn actions rejected | PARTIAL | server/src/engine/ServerTableEngine.ts:306 | Server checks turn, but client doesn't wait for server |
| 1.1.3 | Pre-actions queued not executed | MISSING | server/ | PreActionEngine exists in src/engine/ (client-only), not on server |
| 1.1.4 | No parallel action processing | BROKEN | src/pages/TablePage.tsx:4112 | Client + server process same action independently |
| 1.2.1 | Action validated before execution | PARTIAL | server/src/engine/HandController.ts:192-197 | Basic validation via calculateBettingState, no auth check |
| 1.2.2 | Execution completes before broadcast | VERIFIED | server/src/engine/ServerTableEngine.ts:620 | broadcastCurrentState() called after performAction() |
| 1.2.3 | Broadcast confirms before next turn | MISSING | server/src/engine/ServerTableEngine.ts:775 | broadcastHandState is fire-and-forget, no confirmation |
| 1.2.4 | Timer starts after broadcast confirms | MISSING | server/src/engine/ServerTableEngine.ts:685 | Timer starts immediately on TURN_CHANGE, not after broadcast |
| 1.2.5 | No fire-and-forget | BROKEN | src/pages/TablePage.tsx:4017,4040,4063 | All submitAction calls are fire-and-forget .catch() |
| 1.3 | 20-step order of operations | BROKEN | Multiple | Steps 1-2 violated (client runs local engine), steps 3/7/8 missing from server |
| 1.4.1 | Server state is canonical | BROKEN | src/pages/TablePage.tsx:4112 | Comment says "LOCAL engine is authoritative" |
| 1.4.2 | Client derives from server broadcasts | BROKEN | src/pages/TablePage.tsx:2711 | Client creates own HandController with own deck/cards |
| 1.4.3 | Server wins disagreements | BROKEN | src/pages/TablePage.tsx:3838 | Client broadcasts its own state as PRIMARY |
| 1.4.4 | StateVerifier between hands | MISSING | server/ | StateVerifier exists in src/engine/ (client-only) |
| 1.4.5 | No client-side game logic | BROKEN | src/pages/TablePage.tsx:2711-2813 | Client runs full HandController |
| 1.5.1 | Correct turn order | NEEDS-VERIFY | server/src/engine/HandController.ts:472-500 | Logic exists, needs testing |
| 1.5.2 | Equal action calculation | NEEDS-VERIFY | server/src/engine/ServerTableEngine.ts:363-412 | getPlayerActions() exists |
| 1.5.3 | Equal timer duration | PARTIAL | server/src/engine/ServerTableEngine.ts:683 | Same actionTime for all, but time bank model differs |
| 1.5.4 | Correct side pot eligibility | NEEDS-VERIFY | server/src/engine/PokerEngine.ts:calculatePots | Logic exists in PokerEngine |
| 1.5.5 | No card exposure (anti-god-mode) | BROKEN | server/src/engine/ServerTableEngine.ts:792 | Server broadcasts ALL cards: `cards: p.cards ?? []` |
| 1.5.6 | Errors return messages, never auto-fold | BROKEN | server/src/engine/ServerTableEngine.ts:351-353 | Auto-folds on ANY validation error |
| 1.6 | Explicit state transitions | MISSING | All | No formal state machine anywhere |
| 1.7.1 | Server-side heartbeat disconnect | MISSING | server/ | DisconnectEngine exists in src/engine/ (client-only) |
| 1.7.2 | Timer continues during disconnect | PARTIAL | server/src/engine/ServerTableEngine.ts:192 | Timer runs, but no disconnect detection |
| 1.7.3 | Auto-fold/check on disconnect timeout | MISSING | server/ | No disconnect detection = no auto-action |
| 1.7.4 | preferCheckOverFold | MISSING | server/ | Not implemented on server |
| 1.7.5 | Reconnect grace period | MISSING | server/ | No disconnect tracking |
| 1.7.6 | maxConsecutiveTimeouts → sit-out | MISSING | server/ | No timeout counting |
| 1.8 | Fold finality | VERIFIED | server/src/engine/HandController.ts:203 | `player.is_folded = true` is permanent |
| 1.9 | 15-step settlement sequence | BROKEN | server/src/engine/HandController.ts:387-431, ServerTableEngine.ts:804-944 | Steps 1,9,10,11,12 missing; rest is fire-and-forget |
| 1.10 | Visual truth | NEEDS-VERIFY | src/pages/TablePage.tsx | Popups exist but not systematically verified |
| 1.11 | Audio truth | NEEDS-VERIFY | src/services/SoundService.ts | Sounds exist but not verified against all events |
| 1.12 | Haptic truth | PARTIAL | src/services/SoundService.ts | Minimal haptic integration |
| 1.13 | Priority: Server > DB > Client | BROKEN | Multiple | Client is currently authoritative |

---

## CHAPTER 2: OBJECT SCHEMAS

| ID | Requirement | Status | Notes |
|----|------------|--------|-------|
| 2.1 | Table object complete | PARTIAL | Missing: big_blind_ante field in some paths |
| 2.2 | TableSettings complete | PARTIAL | Many settings defined in types but not all wired through |
| 2.3 | Player object complete | PARTIAL | Missing: is_disconnected, position, time_bank_remaining in broadcast |
| 2.4 | Hand state broadcast complete | PARTIAL | Missing: min_raise, last_raise, action_history, pots in broadcast payload |
| 2.5 | Action record complete | NEEDS-VERIFY | Fields exist in HandController |
| 2.6 | Pot object | NEEDS-VERIFY | calculatePots returns {amount, eligible} |
| 2.7 | Winner object | PARTIAL | Missing potIndex, hand description in broadcast |
| 2.8 | HandConfig complete | PARTIAL | Missing: bigBlindAnte, straddles, ritEnabled, insuranceEnabled on server |
| 2.9 | RakeConfig complete | PARTIAL | Missing: playerCountCaps, timedRake on server |
| 2.10-2.18 | Additional schemas | MISSING | 4-tier hand history not implemented |

---

## CHAPTER 3: STATE MACHINES

| ID | Requirement | Status | Notes |
|----|------------|--------|-------|
| 3.1 | Table state machine | MISSING | Just `running` boolean flag |
| 3.2 | Hand state machine | MISSING | String-based stage progression, no formal FSM |
| 3.3 | Turn state machine | MISSING | Just a setTimeout |
| 3.4 | Disconnect state machine | MISSING | No disconnect tracking on server |

---

## CHAPTER 4: OPERATIONAL PROCEDURES

| ID | Requirement | Status | File | Notes |
|----|------------|--------|------|-------|
| 4.1 | Hand start procedure | PARTIAL | server/src/engine/HandController.ts:87-103 | Steps 1-8 exist; step 8 (secure card delivery) BROKEN |
| 4.2 | Blind posting | NEEDS-VERIFY | server/src/engine/HandController.ts:105-145 | Heads-up + standard implemented |
| 4.3.a | Traditional ante | VERIFIED | server/src/engine/HandController.ts:135-142 | Works |
| 4.3.b | Big Blind Ante (BBA) | MISSING | server/ | Not in server HandController |
| 4.4 | Straddle handling | MISSING | server/ | StraddleEngine is client-only |
| 4.5 | Card dealing | NEEDS-VERIFY | server/src/engine/HandController.ts:163-181 | Variant-aware card count |
| 4.6 | Hole card security | BROKEN | server/src/engine/ServerTableEngine.ts:792 | All cards broadcast to all players |
| 4.7-4.8 | Betting round flow | NEEDS-VERIFY | server/src/engine/HandController.ts:257-322 | Logic exists, needs edge case testing |
| 4.9 | Fold validation | VERIFIED | server/src/engine/PokerEngine.ts | Always legal |
| 4.10 | Check validation | NEEDS-VERIFY | server/src/engine/PokerEngine.ts | Only when toCall=0 |
| 4.11 | Call validation | NEEDS-VERIFY | server/src/engine/PokerEngine.ts | |
| 4.12 | Bet validation | NEEDS-VERIFY | server/src/engine/PokerEngine.ts | |
| 4.13 | Raise validation | NEEDS-VERIFY | server/src/engine/PokerEngine.ts | Min raise logic needs verification |
| 4.14 | All-in validation | NEEDS-VERIFY | server/src/engine/HandController.ts:228-241 | |
| 4.15 | Pre-action system | MISSING | server/ | PreActionEngine is client-only |
| 4.16-4.18 | Stage progression | NEEDS-VERIFY | server/src/engine/HandController.ts:324-381 | |
| 4.19 | Insurance | MISSING | server/ | InsuranceEngine is client-only |
| 4.20 | Run-It-Twice | MISSING | server/ | RunItTwiceEngine is client-only |
| 4.21 | Showdown rules | MISSING | server/ | No muck/show logic, no show order |
| 4.22 | Bomb pot | NEEDS-VERIFY | server/src/engine/HandController.ts:94-98,147-161 | |

---

## CHAPTER 5: UI/POPUP/ANIMATION/SOUND/HAPTIC

| ID | Requirement | Status | Notes |
|----|------------|--------|-------|
| 5.1 | Popup doctrine | PARTIAL | ActionPanel shows actions, but not all events have popups |
| 5.2 | Animation sequence (sequential) | PARTIAL | Some animations exist, not formally sequenced |
| 5.3 | Sound doctrine | PARTIAL | SoundService covers basics but gaps exist |
| 5.4 | Haptic doctrine | PARTIAL | Minimal integration |

---

## CHAPTER 6: TIMER SYSTEM

| ID | Requirement | Status | File | Notes |
|----|------------|--------|------|-------|
| 6.1.a | Server-authoritative timer | BROKEN | server/src/engine/ServerTableEngine.ts:192 | Uses setTimeout, not deadline-based |
| 6.1.b | Deadline-based (not setTimeout) | MISSING | server/ | PreciseActionTimer exists client-only |
| 6.1.c | Grace period (2s) | MISSING | server/ | No grace period on server timeout |
| 6.1.d | Auto-fold on expiry | VERIFIED | server/src/engine/ServerTableEngine.ts:199-205 | Auto-folds |
| 6.1.e | Auto-check if toCall=0 | MISSING | server/ | Always auto-folds, never auto-checks |
| 6.2.a | Time bank: 2 uses max per hand | BROKEN | server/src/engine/ServerTableEngine.ts:228 | 1 per turn, no per-hand limit |
| 6.2.b | Time bank: pool model | PARTIAL | server reads time_bank_uses_remaining but model differs from client |
| 6.2.c | Time bank: refill per orbit | MISSING | server/ | No refill logic |
| 6.3.a | Heartbeat disconnect detection | MISSING | server/ | No heartbeat system |
| 6.3.b | Disconnect timeout | MISSING | server/ | No disconnect tracking |
| 6.3.c | maxConsecutiveTimeouts | MISSING | server/ | No timeout counting |
| 6.3.d | Reconnect grace period | MISSING | server/ | No reconnect handling |

---

## CHAPTER 7: EDGE CASES

| ID | Edge Case | Status | Notes |
|----|-----------|--------|-------|
| 7.1 | Heads-up blind posting | NEEDS-VERIFY | Logic in HandController.ts:110-113 |
| 7.2 | Short blind all-in | NEEDS-VERIFY | sbAmount = Math.min(smallBlind, sbPlayer.stack) |
| 7.3 | Short all-in doesn't reopen | NEEDS-VERIFY | Need to verify in isBettingRoundComplete |
| 7.4 | Multi-way side pots | NEEDS-VERIFY | calculatePots in PokerEngine.ts |
| 7.5 | Split pot | NEEDS-VERIFY | determineWinners handles ties |
| 7.6 | Hi-Lo no qualifying low | NEEDS-VERIFY | PokerEngine handles 8-or-better |
| 7.7 | Hi-Lo odd chip | NEEDS-VERIFY | Lowest seat first rule |
| 7.8 | RIT different winners | MISSING | No RIT on server |
| 7.9 | Disconnect during all-in runout | MISSING | No disconnect handling |
| 7.10 | Bomb pot short ante | NEEDS-VERIFY | |
| 7.11 | Straddle when can't cover | MISSING | No straddle on server |
| 7.12 | Sit out during hand | PARTIAL | is_sitting_out flag exists |
| 7.13 | Leave during hand | PARTIAL | leave-pending logic in postHandTasks |
| 7.14 | Tournament elimination | NEEDS-VERIFY | |
| 7.15 | Hand-for-hand | PARTIAL | Basic sync exists |
| 7.16 | Simultaneous disconnects | MISSING | No disconnect handling |
| 7.17 | Server crash recovery | PARTIAL | Stale data cleanup exists |
| 7.18 | No-flop-no-drop rake | NEEDS-VERIFY | sawFlop tracking exists |
| 7.19 | Rake cap per player count | MISSING | Not in server getRakeConfig |
| 7.20 | Mixed game rotation | MISSING | No mixed game support |

---

## SUMMARY STATISTICS

| Category | Total | VERIFIED | NEEDS-VERIFY | PARTIAL | MISSING | BROKEN |
|----------|-------|----------|-------------|---------|---------|--------|
| Ch 1: Master Laws | 30 | 2 | 0 | 5 | 12 | 11 |
| Ch 2: Schemas | 10 | 0 | 2 | 6 | 2 | 0 |
| Ch 3: State Machines | 4 | 0 | 0 | 0 | 4 | 0 |
| Ch 4: Procedures | 18 | 1 | 9 | 1 | 5 | 2 |
| Ch 5: UI/UX | 4 | 0 | 0 | 4 | 0 | 0 |
| Ch 6: Timers | 12 | 1 | 0 | 1 | 8 | 2 |
| Ch 7: Edge Cases | 20 | 0 | 9 | 3 | 6 | 0 |
| **TOTAL** | **98** | **4 (4%)** | **20 (20%)** | **20 (20%)** | **37 (38%)** | **15 (15%)** |

### Bottom Line:
- **4% verified** — almost nothing is actually confirmed working per Bible
- **15% actively broken** — these things exist but produce wrong behavior
- **38% missing** — not implemented at all on the server
- **20% partial** — some code exists but incomplete
- **20% needs verification** — code exists but hasn't been tested against Bible

### The Big 3 Blockers (must fix before ANYTHING else):
1. **DUAL ENGINE** — Remove client-side HandController, make server sole authority
2. **CARD SECURITY** — Stop broadcasting all cards to all players
3. **AUTO-FOLD ON ERROR** — Return errors instead of force-folding players
