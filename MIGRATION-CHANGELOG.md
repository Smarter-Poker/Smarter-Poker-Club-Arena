# MIGRATION CHANGELOG
## Every Change, Documented. No Exceptions.

**Started:** 2026-03-24
**Current Step:** Step 1 — RIP OUT client-side engine code

---

## Step 1 — RIP OUT Client-Side Engine Code

### Phase: COMPLETED 2026-03-24

**File: `src/pages/TablePage.tsx`**

**Removed (~780 lines net):**

1. **Engine imports removed (5 of 6):**
   - `Deck, compareHands, calculatePots, determineWinners` from `PokerEngine`
   - `HandController` from `HandController`
   - `serverActionValidator` from `ServerActionValidator`
   - `OFCPineappleEngine` from `OFCPineappleEngine`
   - `monteCarloEquity` from `MonteCarloEquity`
   - **KEPT:** `timeBankEngine` — deferred to Step 5 (8 active callsites)

2. **HandController initialization block removed (~940 lines):**
   - `handControllerRef` declaration + all 51 references → **0 remaining**
   - `handController` state + `setHandController` → removed
   - `handInProgressRef` → removed
   - `startNextHandRef` function body → removed (entire HC creation, config, event subscription)
   - All HC event handlers: HAND_START, CARDS_DEALT, COMMUNITY_CARDS, POT_UPDATE, PLAYER_ACTION, TURN_CHANGE, SHOWDOWN, WINNERS, HAND_COMPLETE
   - Horse auto-action logic (HydraService decision → HC performAction)
   - `handPersistenceService.wireToHandController()` call
   - First-hand trigger `useEffect` watching `tableState.players`

3. **`broadcastLocalHandState` function removed:**
   - Function declaration (was `useCallback` wrapping `broadcastHandState()`)
   - All 14 call sites across action handlers
   - `broadcastHandState` removed from supabase import (unused)

4. **Action handlers migrated to server-only:**
   - `handleFold` — local `performAction('fold')` removed, `submitAction` is now primary (awaited)
   - `handleCheck` — same pattern
   - `handleCall` — same pattern
   - `handleActionPanelAction` — all 5 cases (fold/check/call/raise/allin) cleaned
   - `handleConfirmRaise` — local engine call removed
   - `handleAllIn` — local engine call removed
   - `handleTimerAutoFold` — local engine call removed, `submitAction` only

5. **`validateAndExecuteAction` simplified:**
   - Removed `serverActionValidator.validate()` dependency
   - Removed `handControllerRef.current.getState()` for validation context
   - Now does basic client-side guard only (fold always allowed, check hero exists)
   - Server performs real validation

6. **HC state reads replaced with `tableState` (Zustand):**
   - Keyboard shortcut 'C' handler — `hcState.currentBet` → `tableState.lastBetAmounts`
   - `useTableKeyboard` `onCallCheck` — same replacement
   - `onBetPreset` — `state.pot` → `tableState.pot`
   - Pre-action check/callAny handlers — same replacement
   - ActionPanel render props (`canCheck`, `callAmount`, `minRaise`) — derived from `tableState`
   - PreActionBar `canCheck` prop — derived from `tableState`

7. **`monteCarloEquity` call replaced:**
   - Insurance equity calculation now uses heuristic fallback
   - TODO marker left for server-side equity endpoint (Step 3)

8. **Rabbit hunt handler updated:**
   - Removed `handControllerRef.current?.getState()?.deck` access
   - Falls through to random card generation (server-side rabbit hunt in Step 3)

9. **Comment cleanup:**
   - "LOCAL engine is authoritative" comments → removed or updated
   - "Use HC's authoritative pot value" → removed
   - HandController references in section headers → neutralized

**What the client KEEPS (correct behavior):**
- `submitAction()` from GameServerAPI — HTTP POST to server (PRIMARY)
- `sendAction()` from useTableWebSocket — WebSocket action send
- `subscribeToHandState()` — Supabase Realtime listener
- All UI rendering — cards, chips, animations, sounds
- All Zustand state — populated by server events
- `timeBankEngine` — deferred to Step 5

**Verification (grep):**
- `handControllerRef`: 0 matches ✅
- `broadcastLocalHandState`: 0 non-comment matches ✅
- `.performAction(`: 0 matches ✅
- `monteCarloEquity`: 0 non-comment matches ✅
- `serverActionValidator`: 0 non-comment matches ✅
- Engine imports (`from '../engine/`): only `timeBankEngine` (Step 5) ✅

**Next:** Step 2 — VERIFY CLEAN (full grep confirms zero local authoritative state)
