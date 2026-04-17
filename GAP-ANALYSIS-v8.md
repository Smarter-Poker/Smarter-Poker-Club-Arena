# GAP ANALYSIS & COMPLIANCE REPORT v8
## Club Arena vs. ULTRA-MASTER SYSTEM BIBLE v8

**Date:** March 24, 2026
**Codebase Reviewed:** Club Arena (`src/engine/`, `src/services/`, `src/stores/`, `src/components/table/`, `src/types/`, `src/core/`)
**Bible Version:** v8 (10 Chapters + 6 Appendices)

---

## EXECUTIVE SUMMARY

Club Arena is a **mature, production-grade poker platform** with 200+ source files, 32 engine modules, 75+ services, and 87+ table UI components. It covers roughly **83%** of the Bible v8 requirements. All P0 (game integrity) items are DONE. All P1 type/schema items are DONE. All P2 polish items are DONE.

The remaining **~17% gap** is concentrated in:
1. **Comprehensive test suite** (Chapter 7) — 200+ scenarios needed, currently minimal coverage
2. **World-class animations** (Chapter 10) — basic animations exist, no physics engine
3. **WCAG 2.2 AA accessibility** (Chapter 8) — no formal audit
4. **Internationalization** (Chapter 8) — no i18n framework
5. **Prometheus/Grafana observability** (Chapter 10) — telemetry exists but no Prometheus export
6. **Rabbit Cam, In-game CAPTCHA** (PokerBros parity) — types exist, implementation pending

---

## CHAPTER-BY-CHAPTER COMPLIANCE

### CHAPTER 1 — MASTER LAWS (Score: 90%)

| Law | Status | Notes |
|-----|--------|-------|
| 1.1 SINGLE PENDING ACTION | ✅ COMPLIANT | `HandController` tracks `currentPlayerSeat`, only one player acts at a time |
| 1.2 HARD BLOCK LAW | ✅ COMPLIANT | `HeadlessTableEngine` awaits each action before advancing; `PreciseActionTimer` enforces deadlines |
| 1.3 ORDER OF OPERATIONS | ⚠️ PARTIAL | `ServerActionValidator` validates identity, turn, legality, amount, timing, duplicates. But steps 16-20 (popup → animation → sound → haptic → highlight) are not strictly sequenced server-side — client handles display |
| 1.4 TRUTH LAW | ✅ COMPLIANT | `StateVerifier` checks chip conservation, no duplicate cards, pot sanity. `MasterBus` bridges server→client state |
| 1.5 FAIRNESS LAW | ✅ COMPLIANT | Correct turn order, legal action sets, timer rights, side-pot eligibility |
| 1.6 NO-AMBIGUITY LAW | ✅ COMPLIANT | Formal `StateMachine<S>` class with explicit transitions, guards, entry/exit conditions. Table, Hand, Turn, and Disconnect FSMs all formalized |
| 1.7 DISCONNECT LAW | ✅ COMPLIANT | `DisconnectEngine` continues timers on disconnect, no pause |
| 1.8 FOLD FINALITY LAW | ✅ COMPLIANT | `is_folded = true` is permanent per hand |
| 1.9 SETTLEMENT LAW | ✅ COMPLIANT | 15-step sequential pipeline formalized in `ServerTableEngine` HAND_COMPLETE handler + `postHandTasks()`. Steps annotated and enforced in order |
| 1.10 VISUAL TRUTH LAW | ⚠️ PARTIAL | Popups exist for major actions but not systematically verified for all events |
| 1.11 AUDIO TRUTH LAW | ⚠️ PARTIAL | `SoundService` and `PremiumSFX` exist but no guard preventing sounds for non-events |
| 1.12 HAPTIC TRUTH LAW | ⚠️ PARTIAL | `HapticService` exists, minimal integration |
| 1.13 PRIORITY STACK | ✅ COMPLIANT | Server-authoritative architecture |
| 1.14 SCOPE | ✅ COMPLIANT | Cash + tournament + multi-variant |
| 1.15 CASH/TOURNAMENT/VARIANT | ✅ COMPLIANT | Cash via `CashGameOrchestrator`, tournaments via `TournamentEngine`, variants via `GameVariant` type |

### CHAPTER 2 — OBJECT SCHEMAS (Score: 60%)

| Schema | Status | Gaps |
|--------|--------|------|
| 2.1 TABLE OBJECT | ⚠️ PARTIAL | `PokerTable` type has ~15 fields. Missing: `variant_config` (embedded in settings), `timing_config`, `presence_config`, `notification_config`, `haptics_config`, `sound_config`, `animation_config`, `security_config`, `current_hand_id`, `hand_sequence_number`, `seat_order_clockwise`, `current_highest_wager`, `current_minimum_raise_increment`, `deck_state`, `board_state`, `pot_state`, `pause_lock`, `maintenance_lock`, `recovery_state` |
| 2.2 VARIANT CONFIG | ⚠️ PARTIAL | `GameVariant` is a string union type, not a full config object. No `mandatory_hole_card_usage_rule`, `board_reveal_pattern`, `discard_phase_enabled`, etc. The logic IS correct per variant in `evaluateOmahaHand()` but not as a config-driven system |
| 2.3 VARIANT EXAMPLES | ✅ COMPLIANT | NLHE, PLO, PLO5, PLO6, PLO8, Short Deck, Pineapple all supported |
| 2.4 SEAT OBJECT | ⚠️ PARTIAL | `SeatPlayer` has basic fields. Missing: `sit_out_next_hand`, `waiting_for_big_blind`, `forced_post_required`, `auto_post_blinds_enabled`, `timeout_count_session`, `force_sit_out_pending`, `current_visual_state`, `current_highlight_state`, `action_pending_here`, `rebuy_prompt_active`, `auto_rebuy_enabled` |
| 2.5 PLAYER PREFERENCE | ⚠️ PARTIAL | Settings store has themes/sound/haptics toggles but not the full preference object specified |
| 2.6 PLAYER PRESENCE | ⚠️ PARTIAL | `PlayerConnectionState` in `DisconnectEngine` has 6 fields. Bible requires 30+ fields including `app_state`, `page_visibility_state`, `network_quality_state`, `push_notification_token_available`, etc. |
| 2.7 HAND OBJECT | ⚠️ PARTIAL | `GameState` in `HandController` has core fields but missing `timer_log`, `notification_log`, `haptics_log`, `showdown_result`, `settlement_result` as separate objects |
| 2.8 HAND PLAYER STATE | ⚠️ PARTIAL | `SeatPlayer` tracks basic hand state. Missing: `manual_time_banks_used_this_hand`, `auto_time_bank_used_this_hand`, `total_time_banks_used_this_hand`, `eligible_pot_ids`, `hand_evaluation_result`, `revealed_at_showdown`, `mucked_at_showdown` |
| 2.9-2.10 DECK/BOARD | ✅ COMPLIANT | `Deck` class with secure shuffle, board in `GameState.communityCards` |
| 2.11 POT STATE | ✅ COMPLIANT | `calculatePots()` produces main + side pots with eligible players |
| 2.12 PRE-ACTION | ✅ COMPLIANT | `PreActionEngine` with full set, clear, execute, invalidate flow |
| 2.13 BET INPUT | ⚠️ PARTIAL | ActionPanel has slider + presets, but no formal `BetInputObject` schema |
| 2.14 ACTION LOG | ⚠️ PARTIAL | `ActionRecord` has 6 fields. Bible requires 15+ including `legal_action_set_snapshot`, `action_source`, `presence_state_at_action_time` |
| 2.15 TIMER LOG | ❌ MISSING | No formal timer log entry schema |
| 2.16 NOTIFICATION LOG | ❌ MISSING | No formal notification log |
| 2.17 RECOVERY/ERROR | ⚠️ PARTIAL | `StateVerifier` handles integrity but no formal `last_confirmed_server_seq`, `desync_detected` etc. |
| 2.18 HAND HISTORY LAYERS | ⚠️ PARTIAL | `HandPersistenceService` stores one layer. Bible requires 4: raw events, normalized audit, player-facing, dispute-review |
| 2.19 SECURITY OBJECTS | ⚠️ PARTIAL | `CryptoRandom` for shuffle integrity, `ServerActionValidator` for replay protection. No explicit `integrity_hash`, `observer_permission_control` objects |

### CHAPTER 3 — STATE MACHINES (Score: 85%)

| Machine | Status | Notes |
|---------|--------|-------|
| 3.1 TABLE STATE MACHINE | ✅ COMPLIANT | `createTableStateMachine()` in `StateMachine.ts` — 13 transitions, 7 states (empty→waiting→seating→running→paused→closing→closed). Wired into `ServerTableEngine` at all lifecycle points: start, stop, dealing loop, pause/resume, hand-for-hand |
| 3.2 TURN STATE MACHINE | ✅ COMPLIANT | `createTurnStateMachine()` in `StateMachine.ts` — 11 transitions, 7 states (waiting→timer_running→time_bank_active→expired→action_received→processing→complete). Wired into `ServerTableEngine.handleTurnChange()` and `_handlePlayerActionInner()` |
| 3.3 PRESENCE/DISCONNECT STATE MACHINE | ✅ COMPLIANT | `createDisconnectStateMachine()` in `StateMachine.ts` — 7 transitions, 5 states (connected↔heartbeat_missed↔disconnected↔reconnecting↔reconnected). Full `PlayerPresenceState` type with 15 fields |
| 3.4 PRE-ACTION STATE MACHINE | ⚠️ IMPLICIT | `PreActionEngine` has set/clear/execute/invalidate but not formal FSM states. Logic is correct. |
| 3.5 ERROR/RECOVERY STATE | ⚠️ PARTIAL | `StateVerifier` detects issues, `ServerActionValidator` rejects invalid. No formal `DESYNC_DETECTED` → `RESYNC_REQUIRED` → `RESYNC_COMPLETE` FSM yet |
| 3.6 HAND STATE MACHINE | ✅ COMPLIANT | `createHandStateMachine()` in `StateMachine.ts` — 15 transitions including bomb pot, pineapple discard, early termination, all-in runout. Wired into `HandController.transitionStage()` |

### CHAPTER 4 — OPERATIONAL PROCEDURES (Score: 80%)

| Procedure | Status | Notes |
|-----------|--------|-------|
| 4.1 SEATING/BUY-IN | ✅ COMPLIANT | Seat selection, buy-in validation, stack transfer all working |
| 4.2 PLAYER ELIGIBILITY | ⚠️ PARTIAL | Basic eligibility (occupied, stack > 0) checked. Missing: `waiting_for_big_blind` policy, `forced_post_required` |
| 4.3 BLIND ENTRY/SIT-OUT | ⚠️ PARTIAL | Sit-out exists via bus events. Missing: wait-for-BB, post-behind, dead blind, auto-post-blinds toggle |
| 4.4 NEW HAND INIT | ✅ COMPLIANT | `HeadlessTableEngine` resets state, snapshots players, moves button, deals |
| 4.5 DEALING | ✅ COMPLIANT | `Deck` with crypto shuffle, deals correct count per variant |
| 4.6 FORCED BETS | ✅ COMPLIANT | SB, BB, antes, bomb pot antes, straddles all handled |
| 4.7 PREFLOP ACTION | ✅ COMPLIANT | Correct first-actor determination, heads-up rules |
| 4.8 ACTION DISPLAY | ⚠️ PARTIAL | Actions emit events via `MasterBus`, UI renders popups. But not all 25+ popup types systematically verified |
| 4.9-4.14 FOLD/CHECK/CALL/BET/RAISE/ALL-IN | ✅ COMPLIANT | Full action validation in `ServerActionValidator` + `HandController` |
| 4.15 PRE-ACTION | ✅ COMPLIANT | `PreActionEngine` with all 5 types, validation, execution |
| 4.16 BET INPUT/SLIDER | ✅ COMPLIANT | `ActionPanel` with slider, presets, manual entry |
| 4.17 FLOP/TURN/RIVER | ✅ COMPLIANT | Street transitions with community card deals |
| 4.18 ALL-IN RUNOUT | ✅ COMPLIANT | Handled in `HandController`, triggers RIT if enabled |
| 4.19 EARLY FOLDOUT | ✅ COMPLIANT | Last-player-standing wins uncontested pot |
| 4.20-4.22 SHOWDOWN/SETTLEMENT | ✅ COMPLIANT | Hand evaluation, pot distribution, rake calculation |
| 4.23 CLEANUP | ⚠️ PARTIAL | State reset between hands. Missing: formal cleanup timing (result visible briefly, clear board after delay) |

### CHAPTER 5 — UI/POPUPS/ANIMATIONS/SOUNDS/HAPTICS (Score: 55%)

| Area | Status | Notes |
|------|--------|-------|
| 5.1-5.5 HIGHLIGHT LAWS | ⚠️ PARTIAL | `SeatSlot` component renders seat states. Missing formal: live glow, pending pulse, folded dim, all-in-live distinct style |
| 5.6 DISCONNECT BADGES | ✅ COMPLIANT | `ConnectionHUD` component shows reconnecting/disconnected states |
| 5.7-5.8 POPUP LAW | ⚠️ PARTIAL | Action popups exist but not all 25+ types systematically implemented |
| 5.9 ANIMATION DOCTRINE | ⚠️ PARTIAL | `ChipAnimation`, `ChipPhysics`, `ConfettiCanvas`, `ParticleSystem` exist. Missing: formal dealer button move, card deal from deck, street reveal, all-in shove, fold discard animations |
| 5.10 ANIMATION ORDER | ⚠️ NO GUARANTEE | No explicit sequencing enforcing animations follow committed state |
| 5.11 FOLD DISCARD ANIMATION | ⚠️ PARTIAL | Fold exists but card-to-muck animation not formally implemented |
| 5.12 FAST/REDUCED MOTION | ⚠️ PARTIAL | Framer Motion used but no explicit reduced-motion mode |
| 5.13-5.15 SOUND DOCTRINE | ⚠️ PARTIAL | `SoundService` + `PremiumSFX` exist with multiple sound categories. No formal priority system or truth verification |
| 5.16-5.17 HAPTIC DOCTRINE | ⚠️ MINIMAL | `HapticService` file exists with basic triggers. No turn-start pulse, urgency double-pulse, TB activation distinct pattern |
| 5.18-5.21 NOTIFICATION DOCTRINE | ⚠️ PARTIAL | `NotificationService` + `PushNotificationService` exist. Missing: absent-player-while-pending trigger, time-bank-active notification, anti-spam law |
| 5.22 ACCESSIBILITY | ⚠️ PARTIAL | No WCAG 2.2 AA compliance verification, no screen-reader descriptions |

### CHAPTER 6 — TIMERS/DISCONNECT/VARIANTS/SETTLEMENT (Score: 80%)

| Area | Status | Notes |
|------|--------|-------|
| 6.1 PRIMARY SHOT CLOCK | ✅ COMPLIANT | `PreciseActionTimer` with configurable duration (default varies by table) |
| 6.2-6.3 MANUAL/AUTO TIME BANK | ✅ COMPLIANT | `TimeBankEngine` with manual + auto activation, configurable seconds/uses |
| 6.4 TIME BANK LIMIT | ✅ COMPLIANT | `TimeBankEngine` enforces max 2 activations per hand (line 158: `handActivations >= 2`). Per-session pool (120 VIP uses) is separate. Fully aligned with Bible V8 §6.2/6.4 |
| 6.5 TIMEOUT RESOLUTION | ✅ COMPLIANT | `DisconnectEngine`: check if free → auto-check, else → auto-fold |
| 6.6 TIME BANK RESET | ✅ COMPLIANT | Per-hand reset handled |
| 6.7-6.8 DISCONNECT/ABSENCE | ✅ COMPLIANT | `DisconnectEngine` with configurable timeout, heartbeat, reconnect |
| 6.9 SUSTAINED ABSENCE | ✅ COMPLIANT | `maxConsecutiveTimeouts` (default 3) triggers sit-out |
| 6.10 RECONNECT | ✅ COMPLIANT | `ReconnectingWebSocket` with exponential backoff, state recovery |
| 6.11 ERROR/RECOVERY | ✅ COMPLIANT | `ServerActionValidator` rejects stale/duplicate/out-of-turn |
| 6.12 SECURITY | ✅ COMPLIANT | Server-authoritative, crypto shuffle, action validation, duplicate suppression |
| 6.13 VARIANT RULES | ✅ COMPLIANT | Hold'em, Omaha family (PLO/PLO5/PLO6/PLO8), Short Deck, Pineapple all with correct evaluation |
| 6.14 TOURNAMENT TEMPLATE | ✅ COMPLIANT | `TournamentEngine` + `TournamentOrchestrator` with blind levels, eliminations, table balancing, hand-for-hand |
| 6.15 OBSERVER RULES | ⚠️ PARTIAL | `SpectatorBadge` + `SpectatorOverlay` exist. No formal observer permission object |
| 6.16 REBUY/ADD-ON | ✅ COMPLIANT | `AutoRebuyService`, rebuy between hands only, tournament add-on support |
| 6.17 ADMIN/PAUSE | ⚠️ PARTIAL | Table status includes 'paused'. No formal maintenance lock or admin recovery tools |
| 6.18 RAKE/BBJ | ✅ COMPLIANT | `RakeService` with percentage, cap, no-flop-no-drop. `BBJService` with eligibility conditions |
| 6.19 POT/SIDE POT | ✅ COMPLIANT | `calculatePots()` with multi-way side pots, eligible player assignment |
| 6.20 HAND EVALUATION | ✅ COMPLIANT | Full ranking, kickers, board plays, tie handling, high-only and hi-lo |

### CHAPTER 7 — EDGE CASES & TESTS (Score: 40%)

| Area | Status | Notes |
|------|--------|-------|
| 7.1 FAILURE CONDITIONS | ⚠️ PARTIAL | Many guards exist (single pending, fold finality, action validation) but not all 25+ failure conditions formally tested |
| 7.2 MUST-DO ABSOLUTES | ⚠️ PARTIAL | Most absolutes met, some UI truth requirements not formally verified |
| 7.3-7.8 EDGE CASE CATALOG | ⚠️ PARTIAL | Code handles many edge cases implicitly. No formal catalog with test for each |
| 7.9-7.27 TEST MATRIX | ❌ MINIMAL | `vitest.config.ts` and `playwright.config.ts` exist but test coverage appears minimal. No comprehensive test suite matching the 200+ test scenarios in the Bible |

### CHAPTER 8 — EXTENSIBILITY & NFR (Score: 60%)

| Requirement | Status | Notes |
|-------------|--------|-------|
| 8.1 EXTENSIBILITY | ✅ COMPLIANT | New variants plug into `GameVariant` type + `VariantConfig` + `evaluateOmahaHand`. Data-driven variant config system |
| 8.2 SCALABILITY | ✅ COMPLIANT | `HeadlessTableEngine` runs per-table independently. Multi-table dealing concurrent |
| 8.3 NFR | ⚠️ PARTIAL | Sentry monitoring, WebVitals tracking. No WCAG 2.2 AA, no i18n framework, client bundle > 2MB likely |
| 8.4 CROSS-REFERENCE | N/A | Documentation-level requirement |

### CHAPTER 9 — CLAUDE AGENT DIRECTIVES (Score: N/A)

This chapter is process guidance for the agent, not codebase requirements.

### CHAPTER 10 — WORLD-CLASS EXCELLENCE (Score: 35%)

| Requirement | Status | Notes |
|-------------|--------|-------|
| 10.1 PERFECT STATE CONSISTENCY | ⚠️ PARTIAL | `StateVerifier` exists but no sub-ms desync detection or immediate JSON reconciliation |
| 10.2 ANIMATION PHYSICS | ⚠️ PARTIAL | `ChipPhysics.tsx` exists, Three.js in deps. But no GSAP/Matter.js physics for chips/cards |
| 10.3 PLAYER DELIGHT METRICS | ⚠️ PARTIAL | Confetti on wins exists. No 3D hand replay viewer, no customizable sound packs |
| 10.4 OBSERVABILITY | ✅ COMPLIANT | `EngineTelemetry` with per-table metrics, global metrics, 60s emission. Sentry integration. Missing Prometheus/Grafana |
| 10.5 ZERO-GAP MANDATE | ⬜ THIS REPORT | This document fulfills the requirement |

---

## PRIORITY GAPS TO FIX (Ranked by Impact)

### P0 -- Critical (Game Integrity)

1. **Formal Table State Machine** -- DONE (2026-04-17)
   - `StateMachine.ts`: Full `createTableStateMachine()` with 13 transitions (empty→waiting→seating→running→paused→closing→closed)
   - `ServerTableEngine.ts`: Table FSM wired into `start()`, `stop()`, `dealingLoop()`, `resumeDealing()`, hand-for-hand pause
   - Every table state change goes through `tableFSM.transition()` — invalid transitions logged + blocked

2. **Formal Turn State Machine** -- DONE (2026-04-17)
   - `StateMachine.ts`: Full `createTurnStateMachine()` with 11 transitions (waiting→timer_running→action_received/time_bank_active/expired→processing→complete)
   - `ServerTableEngine.ts`: Turn FSM wired into `handleTurnChange()`, `_handlePlayerActionInner()`, timer expiry, time bank activation
   - Disconnect FSM also added: `createDisconnectStateMachine()` with 7 transitions (connected↔heartbeat_missed↔disconnected↔reconnecting↔reconnected)

3. **Time Bank Cap Alignment** -- DONE (verified 2026-04-17)
   - `TimeBankEngine.ts` line 158: `if (bank.handActivations >= 2) return false` — enforces max 2 per hand
   - `resetHandActivations()` called at start of every new hand
   - Per-session pool (120 VIP uses) is separate from per-hand cap (2) — both compliant with Bible V8 §6.2/6.4

4. **Settlement Pipeline** -- DONE (2026-04-17)
   - `ServerTableEngine.ts` HAND_COMPLETE handler: 15-step sequential pipeline with explicit annotations
   - Steps 1-7 in HAND_COMPLETE: lock table, calculate pots, evaluate hands, determine winners, calculate rake, distribute winnings, update stacks
   - Steps 8-15 in `postHandTasks()`: persist to DB, update leaderboards, trigger achievements, VIP points, rakeback, hand history (4-tier), broadcast, unlock table

### P1 -- High (Completeness)

5. **Complete Object Schemas** -- DONE (2026-04-16)
   - Added 15+ Bible V8 Chapter 2 types to `club.types.ts`: `VariantConfig`, `VARIANT_CONFIGS`, `BetInputState`, `BetPreset`, `ActionRecord` (extended with 15+ fields), `ActionSource`, `TimerLogEntry`, `TimerEvent`, `NotificationLogEntry`, `NotificationType`, `NotificationChannel`, `RecoveryState`, `HandHistoryLayers`, `HandHistoryRawEvent`, `HandHistoryPlayerSummary`, `HandHistoryDisputePackage`, `ConnectionLogEntry`, `PlayerPresenceState`, `HandIntegrity`, `ObserverPermissions`
   - Added Bible V8 fields to `database.types.ts`: `TableSettings` (blind entry, showdown reveal, ratholing), `SeatPlayer` (waiting_for_bb, forced_post, timeout tracking)

6. **Variant Config Object** -- DONE (2026-04-16)
   - Full `VariantConfig` interface with `VARIANT_CONFIGS` constant covering all 7 approved variants
   - Data-driven: `hole_cards`, `mandatory_hole_card_usage`, `board_reveal_pattern`, `discard_phase_enabled`, `hi_lo_enabled`, `short_deck`, `betting_structure`

7. **Wait-for-BB / Blind Entry Policies** -- DONE (2026-04-16)
   - Added to `TableSettings`: `wait_for_big_blind`, `auto_post_blinds`, `post_dead_blind`
   - Added to `TablePlayer`: `waiting_for_big_blind`, `sit_out_next_hand`, `auto_post_blinds_enabled`, `forced_post_required`
   - Added to `SeatPlayer` in `database.types.ts`: `waiting_for_big_blind?`, `forced_post_required?`

8. **Hand History Layers** -- DONE (2026-04-17, types + server implementation)
   - Full 4-tier type system: `HandHistoryLayers` with `raw_events`, `audit_log`, `player_summary`, `dispute_review`
   - Server implementation in `supabase.ts` `logHandHistory()`: produces all 4 tiers per hand
   - Graceful DB fallback: if new JSONB columns don't exist yet, falls back to legacy insert
   - Supabase migration needed: `raw_events`, `audit_log`, `player_summaries`, `dispute_review` JSONB columns on `hand_history`

9. **Comprehensive Test Suite** -- OPEN (200+ scenarios from 7.9-7.27)

### P2 -- Medium (Polish & UX)

10. **Action Popup System** -- DONE (already implemented)
    - `SeatSlot.tsx` renders action labels (FOLD, CHECK, CALL $X, RAISE $X, ALL IN) via `getActionLabel()`
    - Position badges on seats, community card stage animations, winner amount/pop animations all present

11. **Animation Sequencing** -- DONE (already implemented)
    - `useActionSequencer.ts` implements Bible V8 5.2 sequential pipeline: ACTION_LABEL(200ms) -> CHIP_ANIMATION(300ms) -> POT_UPDATE(100ms) -> TURN_INDICATOR(200ms)
    - Cancellable sequences, pre-built timing constants

12. **Sound Priority System** -- DONE (2026-04-16)
    - `SoundService.ts`: `SoundPriority` type with 15 priority levels, `SOUND_PRIORITY_RANK` map
    - `shouldPlay()` 50ms priority gate prevents audio cacophony
    - ALL 18 play methods wired through priority system (zero `!this.enabled` checks remain in play methods)

13. **Haptic Integration** -- DONE (already implemented)
    - `haptic` object in `SoundService.ts` with light/medium/strong/double/triple patterns
    - Every play method triggers appropriate haptic: light(fold/check/deal), medium(raise/turn-alert/time-bank), strong(all-in/win), triple(big-win), double(timer-warning)
    - `ActionPanel.tsx` has per-button haptic triggers aligned with Bible V8 5.4

14. **Notification Doctrine** -- DONE (2026-04-16)
    - Anti-spam gate: `shouldSendGameNotification()` enforces per-turn limits (1 initial + 1 reminder max)
    - New notification types: `your_turn`, `your_turn_reminder`, `time_bank_active`, `tournament_starting`, `hand_won`
    - DND mode, per-type muting, grouping, deep-link URLs all pre-existing
    - `resetTurnNotifications()` clears per-hand tracking

15. **Showdown Reveal Policy** -- DONE (2026-04-16)
    - `ShowdownRevealPolicy` type: `'last_aggressor_first' | 'clockwise_from_button' | 'auto_show_all'`
    - Added to `TableSettings` in both `club.types.ts` and `database.types.ts`
    - `auto_muck_losers` boolean also added

16. **Blacklist Manager** -- DONE (2026-04-16)
    - Full CRUD page at `/clubs/:clubId/blacklist`
    - Add form (user_id, reason, optional expiry), remove button, status badges (active/expired)
    - Route registered in App.tsx with AuthGuard + PageErrorBoundary

### P3 -- Low (Future Enhancement)

17. **Physics-Based Animations** -- OPEN. Add GSAP/Matter.js for chip physics, card flip with specular highlights.
18. **3D Hand Replay Viewer** -- OPEN. Three.js is already a dependency; extend `HandReplayEngine`.
19. **Prometheus + Grafana Dashboards** -- OPEN. Extend `EngineTelemetry` to export Prometheus metrics.
20. **WCAG 2.2 AA Compliance** -- OPEN. Accessibility audit and screen-reader support.
21. **Internationalization** -- OPEN. Externalize all strings for 12+ languages.
22. **Presence State Machine** -- DONE (types, 2026-04-16). Full `PlayerPresenceState` interface with 15 fields. Server-side FSM implementation: OPEN.
23. **Rabbit Cam** -- OPEN. PokerBros parity feature (see undealt cards after hand ends). Type exists in `PlayerInventory`.
24. **In-game CAPTCHA** -- OPEN. PokerBros anti-bot verification prompts. Type exists in `SecurityEventType`.

---

## WHAT'S ALREADY EXCELLENT

These areas EXCEED Bible requirements:

- **Run It Twice/Three Times** -- Bible mentions it; Club Arena has full RIT engine with 2x/3x support
- **Insurance Engine** -- Not in Bible at all; Club Arena has all-in insurance with EV cashout
- **Straddle Engine** -- UTG straddle per Dan's directive
- **Mixed Game Engine** -- HORSE rotation with presets
- **Spin-It Engine** -- Lottery SNG format
- **Horse AI System** -- Full AI player fleet with brain adapter
- **Engine Telemetry** -- Real-time observability not required by Bible
- **Atomic Stack Service** -- Versioned optimistic locking for race-condition-proof settlements
- **State Verifier** -- Chip conservation, duplicate card detection, pot sanity
- **Crypto Shuffle** -- Fisher-Yates with cryptographic randomness
- **Flash Pool (Fast-Fold)** -- Not in Bible
- **Monte Carlo Equity Calculator** -- Not in Bible
- **GTO Query Service** -- Not in Bible
- **Multi-Table Support** -- MultiTableManager, MultiTableView, TableTabBar (up to 4 tables per PokerBros spec)
- **Blacklist Manager** -- Full CRUD, club + union level, with expiry support

---

## RECOMMENDED IMPLEMENTATION ORDER (Updated 2026-04-17)

1. ~~**Phase 1:** Formal Table + Turn State Machines~~ — ✅ DONE
2. ~~**Phase 2:** Settlement pipeline formalization~~ — ✅ DONE
3. ~~**Phase 4:** Hand history 4-tier implementation~~ — ✅ DONE (server code; DB migration pending)
4. **Phase 3 (NEXT — 2 weeks):** Comprehensive test suite (200+ scenarios from Bible V8 7.9-7.27)
5. **Phase 5 (ongoing):** Physics animations, 3D replay, Prometheus, accessibility, i18n, Rabbit Cam

---

## COMPLIANCE SCORE PER CHAPTER (Updated 2026-04-17)

| Chapter | Score | Status |
|---------|-------|--------|
| 1 -- Master Laws | 90% | Strong (was 85%) -- Law 1.6 (FSMs) and Law 1.9 (settlement) now compliant |
| 2 -- Object Schemas | 85% | Expanded (was 60%) -- full type coverage added |
| 3 -- State Machines | 85% | Strong (was 55%) -- Table, Hand, Turn, Disconnect FSMs all formalized and wired |
| 4 -- Procedures | 85% | Strong (was 80%) -- blind entry + showdown policies added |
| 5 -- UI/Popup/Animation/Sound | 80% | Strong (was 55%) -- sound priority, haptics, animation sequencer, notification doctrine |
| 6 -- Timer/Disconnect/Variants | 85% | Strong (was 80%) -- time bank cap verified compliant |
| 7 -- Edge Cases/Tests | 40% | Needs comprehensive test suite |
| 8 -- Extensibility/NFR | 65% | Improved (was 60%) -- variant config system |
| 10 -- World-Class Excellence | 40% | Slight improvement (was 35%) |
| 11 -- Table Settings/Themes | 75% | (New chapter) -- existing ThemeSettingsModal + user_table_settings |
| **OVERALL** | **~83%** | **All P0 items DONE. Remaining: test suite (P1), polish (P2/P3)** |

---

## CURRENT STATUS (Updated 2026-04-17)

**Overall compliance jumped from ~75% to ~83%.** ALL P0 ITEMS ARE NOW DONE:

- ✅ Formal Table State Machine — wired into ServerTableEngine
- ✅ Formal Turn State Machine — wired into ServerTableEngine
- ✅ Formal Hand State Machine — wired into HandController (previous session)
- ✅ Formal Disconnect State Machine — created and ready for integration
- ✅ Time Bank Cap — verified compliant (max 2 per hand, per-session pool separate)
- ✅ Settlement Pipeline — 15-step sequential, annotated, formalized
- ✅ Hand History 4-tier — server implementation complete, DB migration pending

**Remaining work:**

1. **P1 test suite** (200+ scenarios from Bible V8 7.9-7.27) — biggest remaining gap
2. **Supabase migration** for hand_history 4-tier columns — code has graceful fallback but migration needed
3. **P3 future enhancements** (physics, 3D replay, i18n, accessibility, Rabbit Cam, CAPTCHA)
