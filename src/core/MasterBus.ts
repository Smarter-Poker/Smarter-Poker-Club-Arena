/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MASTER BUS -- Centralized State & Event Management Layer (v2.0)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Master Bus is the central nervous system of Club Arena, orchestrating:
 * - Type-safe event emission and subscription
 * - Cross-store state synchronization
 * - Realtime channel bridge for live updates
 * - Service layer coordination
 * - Supabase channel deduplication registry
 * - Sentry breadcrumb logging for observability
 * - Debounced subscription helpers for performance
 *
 * NO DEMO DATA - All operations are real.
 */

import { useArenaStore } from '../stores/useArenaStore';
import { useClubStore } from '../stores/useClubStore';
import { useTableStore } from '../stores/useTableStore';
import { useUnionStore } from '../stores/useUnionStore';
import { useWalletStore } from '../stores/useWalletStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUserStore } from '../stores/useUserStore';
import { realtimeChannelService } from '../services/RealtimeChannelService';
import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { reportError } from '../utils/errorReporter';
import { STORAGE_KEYS } from '../lib/storage';

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BusEventType =
  | 'TABLE_CHAT_INSERT'
  | 'PLAYER_APPEARANCE_CHANGED'
  | 'CUSTOMIZATION_MUTATION_STATE'
  | 'AUTH_STATE_CHANGED'
  | 'USER_PROFILE_LOADED'
  | 'CLUB_JOINED'
  | 'CLUB_LEFT'
  | 'TABLE_SEATED'
  | 'TABLE_LEFT'
  // Dan 2026-08-15: the in-table "+" asks MultiTablePage to open a LOBBY tab
  // alongside the running game, instead of navigating the whole app away.
  | 'OPEN_LOBBY_TAB'
  // Dan 2026-08-25: the tournament lobby's Ranking and Tables tabs ask
  // MultiTablePage to open a table as an OBSERVER in a new screen, leaving
  // every screen already open still live. Cap-guarded like every other tab.
  | 'OPEN_OBSERVE_TABLE'
  | 'TABLE_CAP_BLOCKED'
  | 'BALANCE_UPDATED'
  // Had a payload in BusPayloadMap but was missing from this union, so five
  // subscribe sites carried `as any` to compile - which switches OFF payload
  // checking on a ledger event, the one place a wrong shape is money.
  | 'TRANSACTION_LOGGED'
  | 'VIP_POINTS_UPDATED'
  | 'WALLET_REFRESHED'
  | 'REALTIME_CONNECTED'
  | 'REALTIME_DISCONNECTED'
  | 'SYSTEM_ERROR'
  | 'HORSE_BUG_REPORT'
  | 'NOTIFICATION_READ'
  | 'WAITLIST_POSITION_CHANGED'
  | 'WAITLIST_CHANGED'
  | 'WAITLIST_SEAT_OFFERED'
  | 'SESSION_SUMMARY_DISMISSED'
  | 'ACHIEVEMENT_UNLOCKED'
  | 'MISSION_PROGRESS'
  | 'STREAK_UPDATE'
  // Phase 5: Daily challenge game events
  | 'HAND_COMPLETED'
  | 'HAND_WON'
  | 'FLOP_SEEN'
  | 'ALL_IN_WON'
  | 'BIG_POT_WON'
  | 'PREFLOP_WIN'
  | 'FLUSH_WIN'
  | 'PLAY_MINUTES'
  // Phase 8: Diamond economy bus event
  | 'DIAMOND_BALANCE_CHANGED'
  // Social & Messaging events
  | 'MESSAGE_SENT'
  | 'MESSAGE_RECEIVED'
  | 'PROFILE_UPDATED'
  | 'NOTIFICATION_RECEIVED'
  | 'NOTIFICATION_COUNT_CHANGED'
  // Friend events
  | 'FRIEND_REQUEST_SENT'
  | 'FRIEND_REQUEST_ACCEPTED'
  // Settings sync
  | 'SETTINGS_UPDATED'
  // Club data mutations (cross-page sync)
  | 'CLUB_UPDATED'
  | 'UNION_UPDATED'
  | 'ANNOUNCEMENT_CHANGED'
  // Financial events
  | 'COMMISSION_PAID'
  | 'SETTLEMENT_COMPLETED'
  | 'FINANCIAL_ALERT'
  | 'BBJ_HIT_GLOBAL'
  // Tournament lifecycle events
  | 'PLAYER_ELIMINATED'
  | 'TABLE_MERGED'
  // Cashier events
  | 'CHIPS_ADDED'
  | 'CHIPS_WITHDRAWN'
  // Settlement cron lifecycle
  | 'SETTLEMENT_CYCLE_STARTED'
  | 'SETTLEMENT_CYCLE_COMPLETED'
  | 'SETTLEMENT_PAYOUT_FAILED'
  // Resilience & Connection Events
  | 'OFFLINE_QUEUE_REPLAYED'
  | 'WS_CONNECTION_FAILED'
  | 'WS_CONNECTED'
  | 'WS_RECONNECTING'
  | 'WS_DISCONNECTED'
  // Security & Anti-Cheat Events
  | 'COLLUSION_DETECTED'
  | 'VALIDATION_MISMATCH'
  // Service lifecycle
  | 'SERVICES_READY'
  | 'SHOW_TOAST'
  | 'WS_METRICS'
  | 'OFFLINE_QUEUE_METRICS'
  // Engine orchestration events
  | 'TABLE_UPDATED'
  | 'TOURNAMENT_UPDATED'
  // Session tracking
  | 'SESSION_STATS_UPDATE'
  // Bomb pot events
  | 'BOMB_POT_TRIGGERED'
  | 'BOMB_POT_COMPLETED'
  // Disconnect protection events
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED'
  | 'DISCONNECT_TIMEOUT'
  // Table chat events
  | 'TABLE_CHAT_MESSAGE'
  | 'TABLE_REACTION'
  // Diagnostics
  | 'COMPONENT_CRASH'
  // Gamification events
  | 'MILESTONE_UNLOCKED'
  // Tournament timer & rebuy events
  | 'BLIND_LEVEL_CHANGE'
  | 'TOURNAMENT_REBUY'
  | 'TOURNAMENT_ADDON'
  // Multi-day flight events
  | 'FLIGHT_BAGGED'
  | 'FLIGHT_RESUMED'
  // Tournament notification hooks
  | 'TOURNAMENT_STARTING_24H'
  | 'TOURNAMENT_STARTING_1H'
  // VIP points events — @deprecated: superseded by VIP_POINTS_UPDATED (no emitters or subscribers)
  | 'VIP_POINTS_AWARDED'
  // Horse fleet events
  | 'HORSE_SEATED'
  | 'HORSE_REMOVED'
  // Final table experience events
  | 'FINAL_TABLE_REACHED'
  | 'SHOWDOWN_START'
  | 'HEADS_UP_SWITCH'
  // Run It Twice events
  | 'RIT_OFFERED'
  | 'RIT_ACCEPTED'
  | 'RIT_DECLINED'
  | 'RIT_RESOLVED'
  // Straddle events
  | 'STRADDLE_POSTED'
  | 'STRADDLE_TOGGLED'
  // Table break events
  | 'TABLE_BREAK_WARNING'
  | 'TABLE_BREAK_STARTED'
  | 'PLAYER_MOVED'
  | 'TABLE_BREAK_COMPLETED'
  // Spin-It lottery SNG events
  | 'GAME_CREATED'
  | 'PLAYER_JOINED'
  | 'SPIN_RESULT'
  | 'SPIN_GAME_STARTED'
  | 'BLIND_LEVEL_UP'
  | 'SPIN_HEADSUP'
  | 'SPIN_FINISHED'
  // Flash Pool (fast-fold) events
  | 'FLASH_PLAYER_JOINED'
  | 'FLASH_PLAYER_SEATED'
  | 'FLASH_TRANSITION'
  | 'FLASH_SIT_OUT'
  | 'FLASH_SIT_BACK'
  | 'FLASH_PLAYER_LEFT'
  // Phase 5: Hand Reveal + EV Cashout events
  | 'HAND_REVEALED'
  | 'HAND_MUCKED'
  | 'EV_CASHOUT_ACCEPTED'
  // Phase 6: Card Back Store events
  | 'SETTINGS_CHANGED'
  | 'DIAMOND_SPENT'
  | 'COSMETIC_OWNERSHIP_CHANGED'
  | 'ENTITLEMENTS_CHANGED'
  // Gamification engagement events (Session Build)
  | 'SETTLEMENT_RECEIPT_COPIED'
  | 'CHALLENGE_PROGRESS_UPDATED'
  | 'MISSION_CLAIMED'
  | 'DAILY_REWARD_CLAIMED'
  | 'WHEEL_SPIN_RESULT'
  | 'DAILY_RESET_AVAILABLE'
  | 'NOTIFICATION_DISMISSED'
  // Q3: Social, Messaging & Discovery events
  | 'USER_BLOCKED'
  | 'USER_UNBLOCKED'
  | 'CONVERSATION_CREATED'
  | 'CONVERSATION_PINNED'
  | 'CONVERSATION_UNPINNED'
  | 'UNREAD_DM_COUNT_CHANGED'
  | 'MESSAGE_DELETED'
  | 'CONVERSATION_UPDATED'
  // Phase Q1: Disconnect & Time Bank engine events
  | 'PLAYER_SAT_OUT'
  | 'PLAYER_SAT_BACK'
  | 'DISCONNECT_TIMER_STARTED'
  | 'PLAYER_TIMED_OUT'
  | 'TIME_BANK_ACTIVATED'
  | 'TIME_BANK_STOPPED'
  | 'TIME_BANK_REFILLED'
  | 'TIME_BANK_DEPLETED'
  | 'TIME_BANK_EXPIRED'
  | 'TIME_BANK_EXTENDED'
  | 'TIME_BANK_EXTENSION_DENIED'
  // Phase Q1: Insurance engine events
  | 'INSURANCE_OFFERED'
  | 'INSURANCE_ACCEPTED'
  | 'INSURANCE_DECLINED'
  | 'INSURANCE_SETTLED'
  // Phase Q1: Mixed game rotation events
  | 'GAME_VARIANT_ROTATED'
  // Phase Q1: Tournament chip race events
  | 'CHIP_RACE_COMPLETED'
  // Phase Q1: Pre-action queue events
  | 'PRE_ACTION_SET'
  | 'PRE_ACTION_EXECUTED'
  | 'PRE_ACTION_INVALIDATED'
  // Phase Q1: Rakeback events
  | 'RAKEBACK_CALCULATED'
  | 'RAKEBACK_DISTRIBUTED'
  // Phase 7: Hand Replay events
  | 'HAND_REPLAY_LOADED'
  | 'HAND_REPLAY_STEP'
  | 'HAND_REPLAY_COMPLETE'
  // Atomic stack & validation events
  | 'STACK_RACE_DETECTED'
  | 'STACK_SETTLEMENT'
  | 'ACTION_REJECTED'
  // Phase 8: Precise Action Timer events
  | 'ACTION_TIMER_STARTED'
  | 'ACTION_TIMER_EXTENDED'
  | 'ACTION_TIMER_EXPIRED'
  // Phase 8: State Verifier events
  | 'STATE_INTEGRITY_VIOLATION'
  // Phase 9: Telemetry & Table Balance events
  | 'ENGINE_TELEMETRY'
  | 'TABLE_BALANCE_EXECUTED'
  | 'TABLE_MOVE'
  // Session lifecycle
  | 'SESSION_ENDED'
  // Table creation event
  | 'TABLE_CREATED'
  // Table lifecycle admin events
  | 'TABLE_DELETED'
  | 'TABLE_CLOSED'
  // Cross-page coordination events (ported from World Hub native pages)
  | 'CHIPS_DISTRIBUTED'
  | 'CASHOUT_REQUESTED'
  | 'CASHOUT_APPROVED'
  | 'CASHOUT_CANCELLED'
  | 'CASHIER_BALANCE_CHANGED'
  | 'AGENT_UPDATED'
  | 'PLAYER_KICKED'
  // Q4: Backported page events (Hub → Club Arena)
  | 'DATA_MUTATED'
  | 'CHAT_MESSAGE_RECEIVED'
  | 'TOURNAMENT_REGISTERED'
  | 'TOURNAMENT_STARTED'
  | 'TOURNAMENT_COMPLETE'
  | 'ANTI_CHEAT_FLAG_CREATED'
  | 'ANNOUNCEMENT_CREATED' // @deprecated: no emitters or subscribers — reserved for future use
  | 'CREDIT_UPDATED'
  // Phase 4: Remaining native page event types (Hub → Club Arena)
  | 'TOURNAMENT_CANCELLED'
  | 'TOURNAMENT_LEVEL_CHANGE'
  | 'MEMBER_UPDATED'
  | 'MEMBER_ROLE_CHANGED'
  | 'HAND_REPLAYED'
  | 'HAND_COMPLETE'
  | 'PLAYER_LEFT'
  | 'RAKEBACK_CLAIMED'
  | 'CLUB_SETTINGS_UPDATED'
  | 'TICKER_SETTINGS_CHANGED'
  // Phase 4 deep-sweep: Backported overlay + theme events
  // (MYSTERY_BOUNTY_REVEALED removed 2026-08-26: zero subscribers ever; the
  // celebration listens to the server's t-break channel directly.)
  | 'UI_THEME_CHANGED'
  // Phase 8 Deep Sweep: flash pool game state event
  | 'GAME_STATE_UPDATED'
  | 'FLASH_POOL_JOINED'
  // Production resilience events
  | 'CONNECTION_RESTORED'
  // Admin audit trail events
  | 'ADMIN_ACTION'
  // Referral events
  | 'REFERRAL_CLAIMED'
  // Player notes event
  | 'PLAYER_NOTE_SAVED'
  // Table menu actions
  | 'TABLE_MENU_ACTION'
  // Table settings open
  | 'TABLE_SETTINGS_OPEN'
  // UI navigation toggle events
  | 'HAMBURGER_TOGGLE'
  | 'MENU_STATE_CHANGED'
  // Tournament break events (TournamentClock + TournamentEngine)
  | 'BREAK_START'
  | 'BREAK_END'
  | 'TOURNAMENT_BREAK'
  | 'TOURNAMENT_BREAK_END'
  // Satellite tournament completion
  | 'SATELLITE_COMPLETE'
  // Round 20 — Engine→FE event coverage (Bible V8 §1.16) re-broadcasts
  // emitted from TablePage when the corresponding lowercase engine events
  // arrive over the WS hub. See src/pages/TablePage.tsx engineLastEvent
  // useEffect for the dispatch site. INSURANCE_OFFERED, RIT_OFFERED,
  // RIT_RESOLVED, TIME_BANK_ACTIVATED, PLAYER_DISCONNECTED already exist
  // above — these are the additional ones added in Round 20 + Round 30 fix.
  | 'RIT_CHOOSER_DECIDED'
  | 'BBJ_HIT'
  | 'BBJ_PAYOUT_COMPLETE'
  | 'POT_DISTRIBUTED'
  | 'SHOWDOWN_CARDS_REVEALED'
  | 'TIME_BANK_LOW'
  | 'TIME_BANK_TIMEOUT'
  | 'TOURNAMENT_LEVEL_UP'
  | 'SEAT_TAKEN'
  | 'SEAT_LEFT'
  | 'TABLE_PAUSED'
  | 'TABLE_RESUMED'
  | 'TABLE_LOCKED'
  | 'TABLE_UNLOCKED'
  | 'RABBIT_HUNT_AVAILABLE'
  | 'ALL_IN_EQUITY'
  | 'ONLINE_COUNT'
  // 2026-08-29 hardening pass: shell-freshness telemetry. The SW's bounded
  // freshness race (sw-bus.js) and useShellUpdateGate's verified reloads are
  // invisible when they work — these two events are how we KNOW the
  // open-from-Hub glitch stays dead instead of believing it.
  | 'SHELL_STALENESS_CHECKED'
  | 'SHELL_RELOADED';

// #13: Type-safe payload map — compile-time enforcement of correct payloads
export interface BusPayloadMap {
  /**
   * 2026-08-29: a shell staleness verification completed (useShellUpdateGate).
   * `stale: false` is the win condition — the running bundle matched the
   * deployed one, so no reload was owed. The RATE of stale results per source
   * is the KPI for the open-from-Hub glitch fix: it should be near zero on
   * 'shell-updated'/'controllerchange' (the SW race served the fresh shell)
   * and small on 'resume-probe' (long-lived PWA sessions catching up).
   */
  SHELL_STALENESS_CHECKED: {
    stale: boolean;
    source: 'shell-updated' | 'controllerchange' | 'resume-probe';
    running: string | null;
    deployed: string | null;
  };
  /** 2026-08-29: the gate actually reloaded the page to adopt a new shell. */
  SHELL_RELOADED: { pageAgeMs: number };
  TABLE_CHAT_INSERT: { tableId: string; newRow: Record<string, unknown> };
  /**
   * A seated player's render-only identity changed. This event deliberately
   * carries no stack, cards, action or seat data: the game engine remains the
   * only authority for gameplay state. Pickers emit it optimistically so every
   * mounted table repaints in the tap frame; the seat-scoped profiles realtime
   * channel reconciles the durable cross-device value.
   */
  PLAYER_APPEARANCE_CHANGED: {
    userId: string;
    avatar?: string;
    frame?: string | null;
    aura?: string | null;
    /** Links the optimistic paint or rollback to its ordered durable write. */
    mutationId?: string;
    source: 'avatar-picker' | 'cosmetic-picker' | 'rollback';
  };
  /** Orders optimistic visual state against asynchronous database echoes. */
  CUSTOMIZATION_MUTATION_STATE: {
    kind: 'table-appearance' | 'player-appearance' | 'user-table-setting';
    scope: string;
    mutationId: string;
    /**
     * `save-failed` (2026-08-29) is a TERMINAL state that is not a rollback:
     * the write was lost after its retries and the user's value was KEPT on
     * screen anyway (Dan: "NEVER REGRESS OR AUTO CHANGE BACK"). Subscribers
     * that clear pending state on any non-`pending` state already handle it
     * correctly; only one that specifically watches for `rolled-back` needs to
     * know the difference.
     */
    state: 'pending' | 'confirmed' | 'rolling-back' | 'rolled-back' | 'save-failed';
  };
  AUTH_STATE_CHANGED: AuthStatePayload;
  USER_PROFILE_LOADED: { avatarUrl?: string; displayName?: string; userId?: string };
  CLUB_JOINED: ClubEventPayload;
  CLUB_LEFT: ClubEventPayload;
  TABLE_SEATED: TableEventPayload;
  TABLE_LEFT: TableEventPayload;
  /** Request that MultiTablePage open a lobby tab beside the running game. */
  OPEN_LOBBY_TAB: { requestedBy?: string };
  /**
   * Open a table as an observer in a NEW screen without disturbing the screens
   * already open. `tableName` is cosmetic (the tab label before the engine
   * reports the real one). Honours the same MAX_TABLES cap as every other tab:
   * at the cap this is refused with the standard cap notice, never silently
   * dropped, and never by closing a screen the player is using.
   */
  OPEN_OBSERVE_TABLE: { tableId: string; tableName?: string; stakes?: string };
  /** Dan 2026-08-21: a seat could not be opened because the player is at
   *  the 4-table cap. TournamentAutoSeat turns this into the large popup. */
  TABLE_CAP_BLOCKED: { tableId: string };
  BALANCE_UPDATED: { source: string; [key: string]: unknown };
  TRANSACTION_LOGGED: { entry: Record<string, unknown>; direction: 'in' | 'out' };
  VIP_POINTS_UPDATED: { userId: string; added: number; source: string; [key: string]: unknown };
  WALLET_REFRESHED: BalancePayload;
  REALTIME_CONNECTED: { channelName: string };
  REALTIME_DISCONNECTED: { channelName: string; reason?: string };
  SYSTEM_ERROR: { message: string; code?: string };
  HORSE_BUG_REPORT: Record<string, unknown>;
  NOTIFICATION_READ: { notifId: string | null; allRead: boolean };
  WAITLIST_POSITION_CHANGED: { tableId: string; position: number; tableName: string };
  /**
   * An EXCLUSIVE seat hold has just been granted to this player (Dan
   * 2026-08-30: sixty seconds to get to the seat). `holdExpiresAt` is an ISO
   * instant, not a duration, so a component that mounts late - or a tab that
   * was in the background - shows the true remaining time rather than
   * restarting the clock at sixty.
   */
  WAITLIST_SEAT_OFFERED: { tableId: string; tableName: string; holdExpiresAt: string | null };
  WAITLIST_CHANGED: void;
  SESSION_SUMMARY_DISMISSED: { tableId: string };
  ACHIEVEMENT_UNLOCKED: {
    userId: string;
    achievementId: string;
    name: string;
    icon: string;
    rarity: string;
    description: string;
    diamondReward?: number;
  };
  MISSION_PROGRESS: { userId: string; missionId: string; progress: number; target: number };
  STREAK_UPDATE: { userId: string; streakCount: number; multiplier: number };
  // Gameplay events — strict payload types (#7)
  HAND_WON: { handId: string; winners: string[]; pot: number };
  /**
   * Emitted once per hand the hero was DEALT IN (TablePage guards on
   * outcome.dealtIn). Dan 2026-08-20: `won`, `potWon` and `heroStack` were
   * added because the payload previously described only WHICH hand ended, not
   * how it went — leaving useTableSession unable to count hands played or won,
   * which pinned three Session Complete tiles to zero forever.
   */
  HAND_COMPLETED: {
    handId: string;
    tableId: string;
    won?: boolean;
    potWon?: number;
    heroStack?: number;
  };
  FLOP_SEEN: { handId: string; tableId: string };
  ALL_IN_WON: { handId: string; playerId: string; pot: number };
  BIG_POT_WON: { handId: string; pot: number };
  PREFLOP_WIN: { handId: string; playerId: string };
  FLUSH_WIN: { handId: string; playerId: string };
  PLAY_MINUTES: { minutes: number };
  // Phase 8: Diamond economy
  DIAMOND_BALANCE_CHANGED: { newBalance: number; delta: number; source: string };
  // Social & Messaging
  MESSAGE_SENT: { message: Record<string, unknown>; conversationId: string };
  MESSAGE_RECEIVED: { message: Record<string, unknown> };
  MESSAGE_DELETED: { messageId: string };
  CONVERSATION_UPDATED: { conversationId: string };
  PROFILE_UPDATED: { userId: string; updates: Record<string, unknown> };
  NOTIFICATION_RECEIVED: { notification: Record<string, unknown> };
  NOTIFICATION_COUNT_CHANGED: Record<string, unknown>;
  FRIEND_REQUEST_SENT: { toUserId: string; fromUserId?: string };
  FRIEND_REQUEST_ACCEPTED: { friendshipId?: string; userId?: string; friendId?: string };
  // Settings sync
  SETTINGS_UPDATED: { settings: Record<string, unknown> };
  // Club data mutations (cross-page sync)
  CLUB_UPDATED: { clubId: string; action?: string };
  UNION_UPDATED: { unionId: string };
  MEMBER_ROLE_CHANGED: { clubId: string; userId?: string; newRole?: string; previousRole?: string };
  ANNOUNCEMENT_CHANGED: { clubId: string; action: 'created' | 'deleted' };
  // Financial events
  COMMISSION_PAID: { agentId: string; amount: number };
  SETTLEMENT_COMPLETED: {
    periodId: string;
    agentsPaid: number;
    playersWithRakeback: number;
    totalDisbursed: number;
    successRate?: number;
    status: string;
    clubId?: string;
  };
  FINANCIAL_ALERT: {
    severity: 'critical' | 'warning' | 'info';
    source: string;
    message: string;
    context: Record<string, unknown>;
    timestamp: string;
  };
  BBJ_HIT_GLOBAL: {
    tableId: string;
    tableName: string;
    gameVariant: string;
    bigBlind: number;
    winnerName: string;
    amount: number;
    /* 2026-08-26: the hit's own identity and emission time, so the receiver
       de-duplicates on WHICH hit this is rather than on when it arrived —
       the fix for the jackpot re-announcing on every page refresh. Optional
       because a producer without a hand number still de-duplicates by table;
       see lib/bbjHitOnce. */
    handNumber?: number;
    emittedAt?: number;
  };
  // Tournament lifecycle events
  PLAYER_ELIMINATED: {
    tournamentId: string;
    userId: string;
    position: number;
    prize: number;
    username: string;
  };
  TABLE_MERGED: {
    tournamentId: string;
    sourceTableId: string;
    tablesRemaining: number;
    targetTableId?: string;
    playersMoved?: number;
  };
  // Cashier events
  CHIPS_ADDED: { tableId: string; userId: string; amount: number; newStack: number };
  CHIPS_WITHDRAWN: { tableId: string; userId: string; amount: number; newStack: number };
  // Settlement cron lifecycle
  SETTLEMENT_CYCLE_STARTED: { periodId: string; startedAt: string };
  SETTLEMENT_CYCLE_COMPLETED: {
    periodId: string;
    status: string;
    canary?: { passed: boolean; totalCredits: number; totalDebits: number; difference: number };
    agentsPaid?: number;
    playersWithRakeback?: number;
    totalDisbursed?: number;
  };
  SETTLEMENT_PAYOUT_FAILED: {
    type?: string;
    settlementId?: string;
    agentId?: string;
    unionId?: string;
    clubId?: string;
    clubName?: string;
    amount: number;
    periodId?: string;
    error: string;
  };
  // Resilience & Connection Events
  OFFLINE_QUEUE_REPLAYED: { replayed: number; failed: number };
  WS_CONNECTION_FAILED: { url: string; retries: number };
  WS_CONNECTED: { url: string };
  WS_RECONNECTING: { url: string; attempt: number };
  WS_DISCONNECTED: { url: string };
  // Security & Anti-Cheat Events
  COLLUSION_DETECTED: { playerA: string; playerB: string; patternType: string; score: number };
  VALIDATION_MISMATCH: {
    handId: string;
    tableId: string;
    discrepancies: { type: string; expected: string; actual: string; severity: string }[];
  };
  // Service lifecycle
  SERVICES_READY: { services: Record<string, boolean>; timestamp: string };
  COMPONENT_CRASH: {
    componentName: string;
    error: string;
    stack: string;
    timestamp: number;
  };
  SHOW_TOAST: {
    severity: 'critical' | 'warning' | 'info' | 'clock';
    message: string;
    source?: string;
    durationMs?: number;
  };
  WS_METRICS: { reconnectDurationMs: number; totalReconnects: number; url: string };
  OFFLINE_QUEUE_METRICS: {
    replayDurationMs: number;
    mutationsReplayed: number;
    mutationsFailed: number;
  };
  // Engine orchestration events
  TABLE_UPDATED: { tableId: string; status?: string };
  TOURNAMENT_UPDATED: { tournamentId: string; status?: string };
  // Session tracking
  SESSION_STATS_UPDATE: { tableId: string; stats: Record<string, unknown> };
  // Bomb pot events
  BOMB_POT_TRIGGERED: {
    tableId: string;
    anteAmount: number;
    doubleBoard: boolean;
    bbMultiplier: number;
    /** TRIPLE-BOARD 2026-08-27: boards actually dealt (1-3); optional for old emitters. */
    boardCount?: number;
    /**
     * VARIANT OVERRIDE 2026-08-28 (spec §10.1): uppercase variant label
     * (e.g. 'PLO4'), present ONLY when the bomb hand's variant differs from
     * the table's own game — the intro badges it.
     */
    variantLabel?: string;
  };
  BOMB_POT_COMPLETED: { tableId: string };
  // Disconnect protection events
  PLAYER_DISCONNECTED: { tableId: string; userId: string; graceSeconds?: number };
  PLAYER_RECONNECTED: { tableId: string; userId: string };
  DISCONNECT_TIMEOUT: { tableId: string; userId: string; action?: string };
  // Table chat events
  TABLE_CHAT_MESSAGE: {
    tableId: string;
    userId: string;
    playerName?: string;
    message: string;
    type?: string;
  };
  TABLE_REACTION: { tableId: string; userId: string; playerName?: string; emoji: string };
  // Gamification events
  MILESTONE_UNLOCKED: {
    milestoneId: string;
    userId: string;
    milestoneName?: string;
    /** MilestoneToast renders this as the toast body; without it every unlock
     *  read "You reached a new milestone!" regardless of which one it was. */
    description?: string;
    icon?: string;
    rewardDiamonds?: number;
    reward?: Record<string, unknown>;
  };
  // Tournament timer & rebuy event payloads
  BLIND_LEVEL_CHANGE: {
    tournamentId: string;
    /**
     * THE 1-BASED DISPLAY LEVEL. The first level of an event is `1`.
     *
     * This is NOT `tournaments.current_level`, which stores the 0-based index
     * the engine uses on `blindStructure[]`. TournamentTimerService computes
     * `const displayLevel = newLevel + 1` and emits THAT here while writing the
     * raw index to the row — see handleLevelChange.
     *
     * The distinction was undocumented until 2026-08-29 and ALL THREE consumers
     * had guessed wrong, each with a comment asserting the opposite ("the
     * payload carries an index", "TournamentTimerService writes one variable to
     * both"):
     *
     *   TournamentDetails wrote the payload straight into
     *   `tournament.current_level`, corrupting the shared object every tab
     *   reads until the next poll overwrote it;
     *
     *   TournamentClock added one to an already-1-based number and displayed a
     *   level TWO ahead;
     *
     *   BlindsTab indexed the structure with it and showed the next level's
     *   blinds, duration and "Next Level" from the instant the engine advanced.
     *
     * All three symptoms only appeared between an advance and the next poll,
     * which is why they read as flicker rather than as one bug. If you need the
     * index, subtract one.
     */
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante: number;
  };
  TOURNAMENT_REBUY: { tournamentId: string; userId: string; newStack?: number };
  TOURNAMENT_ADDON: { tournamentId: string; userId: string; newStack?: number };
  // Multi-day flight events
  FLIGHT_BAGGED: { tournamentId: string; playersCount: number; avgStack: number };
  FLIGHT_RESUMED: { tournamentId: string; playersResumed: number };
  // Tournament notification hooks
  TOURNAMENT_STARTING_24H: { tournamentId: string; name: string; startsAt: string };
  TOURNAMENT_STARTING_1H: { tournamentId: string; name: string; startsAt: string };
  /** @deprecated superseded by VIP_POINTS_UPDATED */
  VIP_POINTS_AWARDED: { userId: string; amount: number; source: string };
  // Horse fleet events
  HORSE_SEATED: { tableId: string; horseId: string; horseName: string };
  HORSE_REMOVED: { tableId: string; horseId: string; reason: string };
  // Final table experience event payloads
  FINAL_TABLE_REACHED: {
    tournamentId: string;
    tournamentName: string;
    prizePool: number;
    players: Array<{
      userId: string;
      username: string;
      chips: number;
      avatar?: string;
      stats?: {
        handsPlayed: number;
        vpipCount: number;
        pfrCount: number;
        aggressiveActions?: number;
        passiveActions?: number;
      };
    }>;
  };
  SHOWDOWN_START: {
    tableId: string;
    players: Array<{
      userId: string;
      seatNumber: number;
      username: string;
      cards: Array<{ rank: string; suit: string }>;
      handName: string;
      handRank: number;
      isWinner: boolean;
    }>;
  };
  HEADS_UP_SWITCH: {
    tournamentId: string;
    player1: { userId: string; username: string; chips: number };
    player2: { userId: string; username: string; chips: number };
  };
  // Run It Twice event payloads
  RIT_OFFERED: {
    tableId: string;
    handId: string;
    offeredBy: string;
    offeredTo: string;
    pot: number;
  };
  RIT_ACCEPTED: { tableId: string; handId: string };
  RIT_DECLINED: { tableId: string; handId: string; declinedBy: string };
  RIT_RESOLVED: {
    tableId: string;
    handId: string;
    board1: string[];
    board2: string[];
    board1Winner: string;
    board2Winner: string;
    distribution: Record<string, number>;
  };
  // Straddle event payloads
  STRADDLE_POSTED: {
    tableId: string;
    playerId: string;
    seatNumber: number;
    amount: number;
    straddleNumber: number;
  };
  STRADDLE_TOGGLED: { tableId: string; playerId: string; enabled: boolean };
  // Table break event payloads
  TABLE_BREAK_WARNING: {
    tableId: string;
    tournamentId: string;
    secondsRemaining: number;
    playerCount: number;
  };
  TABLE_BREAK_STARTED: {
    tableId: string;
    tournamentId: string;
    playerCount: number;
  };
  PLAYER_MOVED: {
    tournamentId: string;
    playerId: string;
    fromTableId: string;
    fromSeat: number;
    toTableId: string;
    toSeat: number;
    stack: number;
  };
  TABLE_BREAK_COMPLETED: {
    tableId: string;
    tournamentId: string;
    totalMoved: number;
    remainingTableCount: number;
  };
  // Spin-It event payloads
  GAME_CREATED: { type: string; lobbyId?: string; poolId?: string; stakes?: string };
  PLAYER_JOINED: { lobbyId: string; playerId: string; count: number };
  SPIN_RESULT: {
    lobbyId: string;
    multiplier: number;
    prizePool: number;
    label: string;
    color: string;
    bonusFromPool?: number;
    poolContribution?: number;
  };
  SPIN_GAME_STARTED: {
    lobbyId: string;
    players: string[];
    multiplier: number | null;
    prizePool: number;
    blinds: { small: number; big: number; durationSeconds: number };
  };
  BLIND_LEVEL_UP: {
    lobbyId: string;
    level: number;
    blinds: { small: number; big: number; durationSeconds: number };
  };
  SPIN_HEADSUP: { lobbyId: string; players: string[] };
  SPIN_FINISHED: {
    lobbyId: string;
    winnerId: string;
    prizePool: number;
    multiplier: number | null;
    payouts: Record<string, number>;
  };
  // Flash Pool event payloads
  FLASH_PLAYER_JOINED: { poolId: string; playerId: string; poolSize: number };
  FLASH_PLAYER_SEATED: { poolId: string; playerId: string; tableId: string; seatCount: number };
  FLASH_TRANSITION: { poolId: string; playerId: string; fromTableId: string; direction: string };
  /* DECLARED ONLY — no emitter and no subscriber anywhere in src/ (checked
     2026-08-29). Kept rather than deleted because the two SEAT_* entries beside
     it are kept for the same reason, and a payload type costs nothing; noted so
     nobody spends time looking for the code that fires it. Its `poolId` shape
     suggests it was drafted for the BBJ pool surface and never wired. */
  FLASH_SIT_OUT: { poolId: string; playerId: string };
  FLASH_SIT_BACK: { poolId: string; playerId: string };
  FLASH_PLAYER_LEFT: { poolId: string; playerId: string; cashout: number; handsPlayed: number };
  // Phase 5: Hand Reveal + EV Cashout payloads
  HAND_REVEALED: {
    handId: string;
    tableId: string;
    winnerId: string;
    cards: { rank: string; suit: string }[];
  };
  HAND_MUCKED: { handId: string; tableId: string; winnerId: string };
  EV_CASHOUT_ACCEPTED: {
    handId: string;
    tableId: string;
    playerId: string;
    cashoutAmount: number;
    equityPercent: number;
  };
  // Phase 6: Card Back Store payloads
  SETTINGS_CHANGED: {
    setting: string;
    value: string | number | boolean;
    /** Account scope for settings persisted outside localStorage. */
    userId?: string;
    /**
     * Which hook instance emitted this, so a receiver can ignore its OWN echo
     * without a stateful latch. See useTableSettings: the previous
     * `localOriginRef` boolean got permanently stuck whenever the bus
     * suppressed a duplicate emit, and silently swallowed the next real
     * cross-component update.
     */
    origin?: string;
  };
  DIAMOND_SPENT: { amount: number; item: string; category: string };
  COSMETIC_OWNERSHIP_CHANGED: {
    userId: string;
    category: 'theme_id' | 'table_id' | 'button_id' | 'background_id' | 'cards_id' | 'avatar';
    assetId?: string;
    source:
      | 'diamond-purchase'
      | 'club-purchase'
      | 'club-redemption'
      | 'vip-reward'
      | 'ownership-reconciled'
      | 'realtime-entitlement';
  };
  /**
   * A paid entitlement was durably delivered. Unlike the cosmetic-only event,
   * this also covers consumable balances and VIP membership. It is broadcast
   * cross-tab so an open table updates in the purchase response frame.
   */
  ENTITLEMENTS_CHANGED: {
    userId: string;
    category: 'time_bank' | 'throwable' | 'emote_pack' | 'table_skin' | 'avatar' | 'vip';
    assetId?: string;
    quantity?: number;
    source:
      | 'diamond-purchase'
      | 'club-purchase'
      | 'club-redemption'
      | 'vip-purchase'
      | 'vip-reward';
  };
  // Gamification engagement events (Session Build)
  SETTLEMENT_RECEIPT_COPIED: { receiptId: string };
  CHALLENGE_PROGRESS_UPDATED: Record<string, unknown>;
  MISSION_CLAIMED: { missionId: string; tier: string; rewardType: string; rewardAmount: number };
  DAILY_REWARD_CLAIMED: { amount: number; rewardType: string; streakDay: number };
  WHEEL_SPIN_RESULT: { segmentId: string; amount: number; type: string };
  DAILY_RESET_AVAILABLE: { date: string };
  NOTIFICATION_DISMISSED: { notificationId: string };
  // Q3: Social, Messaging & Discovery payloads
  USER_BLOCKED: { userId: string; blockedUserId: string };
  USER_UNBLOCKED: { userId: string; unblockedUserId: string };
  CONVERSATION_CREATED: { conversationId: string; isGroup: boolean };
  CONVERSATION_PINNED: { conversationId: string };
  CONVERSATION_UNPINNED: { conversationId: string };
  UNREAD_DM_COUNT_CHANGED: { userId: string; count?: number };
  // Phase Q1: Disconnect & Time Bank engine payloads
  PLAYER_SAT_OUT: {
    tableId: string;
    playerId: string;
    reason: string;
    consecutiveTimeouts: number;
  };
  PLAYER_SAT_BACK: { tableId: string; playerId: string };
  DISCONNECT_TIMER_STARTED: { tableId: string; playerId: string; timeoutSeconds: number };
  PLAYER_TIMED_OUT: {
    tableId: string;
    playerId: string;
    action: string;
    reason: string;
    consecutiveTimeouts: number;
  };
  TIME_BANK_ACTIVATED: {
    tableId: string;
    playerId: string;
    secondsGranted: number;
    usesRemaining: number;
    totalRemaining: number;
  };
  TIME_BANK_STOPPED: {
    tableId: string;
    playerId: string;
    secondsUsed: number;
    remainingSeconds: number;
    usesRemaining: number;
  };
  TIME_BANK_REFILLED: {
    tableId: string;
    playerId: string;
    usesRemaining: number;
    remainingSeconds: number;
  };
  TIME_BANK_DEPLETED: {
    tableId: string;
    playerId: string;
    remainingSeconds: number;
    usesRemaining: number;
  };
  TIME_BANK_EXPIRED: {
    tableId: string;
    playerId: string;
    remainingSeconds: number;
    usesRemaining: number;
  };
  TIME_BANK_EXTENDED: {
    tableId: string;
    playerId: string;
    secondsAdded: number;
    diamondsCharged: number;
    usesRemaining: number;
    remainingSeconds: number;
  };
  TIME_BANK_EXTENSION_DENIED: {
    tableId: string;
    playerId: string;
    reason: string;
  };
  // Phase Q1: Insurance engine payloads
  INSURANCE_OFFERED: {
    tableId: string;
    handId: string;
    playerId: string;
    equity: number;
    premium: number;
    insuredAmount: number;
  };
  INSURANCE_ACCEPTED: { tableId: string; handId: string; playerId: string; premium: number };
  INSURANCE_DECLINED: { tableId: string; handId: string; playerId: string };
  INSURANCE_SETTLED: {
    tableId: string;
    handId: string;
    playerId: string;
    payout: number;
    won: boolean;
  };
  // Phase Q1: Mixed game rotation payloads
  GAME_VARIANT_ROTATED: {
    tableId: string;
    previousVariant: string;
    newVariant: string;
    handsAtPrevious: number;
  };
  // Phase Q1: Tournament chip race payloads
  CHIP_RACE_COMPLETED: {
    tournamentId: string;
    playersAffected: number;
    smallestDenomination: number;
    newSmallestDenomination: number;
  };
  // Phase Q1: Pre-action queue payloads
  PRE_ACTION_SET: { tableId: string; playerId: string; action: string };
  PRE_ACTION_EXECUTED: { tableId: string; playerId: string; action: string; amount: number };
  PRE_ACTION_INVALIDATED: { tableId: string; playerId: string; reason: string };
  // Phase Q1: Rakeback payloads
  RAKEBACK_CALCULATED: {
    playerId: string;
    period: string;
    rakeContributed: number;
    rakebackAmount: number;
    tier: string;
  };
  RAKEBACK_DISTRIBUTED: { period: string; totalDistributed: number; playersCount: number };
  // Hand Replay
  HAND_REPLAY_LOADED: { handId: string; tableId: string; handNumber: number; totalSteps: number };
  HAND_REPLAY_STEP: {
    handId: string;
    step: number;
    totalSteps: number;
    action: any;
    snapshot: any;
  };
  HAND_REPLAY_COMPLETE: { handId: string };
  // Atomic stack & validation events
  STACK_RACE_DETECTED: {
    tableId: string;
    userId: string;
    operation: string;
    expectedVersion: number;
    actualVersion: number;
  };
  STACK_SETTLEMENT: { tableId: string; playerCount: number; totalMoved: number };
  ACTION_REJECTED: {
    tableId: string;
    playerId: string;
    code: string;
    reason: string;
    timestamp: number;
  };
  // Precise Action Timer
  ACTION_TIMER_STARTED: { tableId: string; playerId: string; durationMs: number; deadline: number };
  ACTION_TIMER_EXTENDED: {
    tableId: string;
    playerId: string;
    additionalMs: number;
    newDeadline: number;
  };
  ACTION_TIMER_EXPIRED: { tableId: string; playerId: string; driftMs: number };
  // State Verifier
  STATE_INTEGRITY_VIOLATION: {
    tableId: string;
    handNumber: number;
    violationCount: number;
    violations: Array<{ type: string; message: string; severity: string }>;
  };
  // Engine Telemetry & Table Balance
  ENGINE_TELEMETRY: {
    activeTables: number;
    totalHandsDealt: number;
    avgHandsPerHour: number;
    cacheHitRatio: number;
  };
  TABLE_BALANCE_EXECUTED: { moveCount: number; tableCount: number; totalPlayers: number };
  TABLE_MOVE: {
    playerId: string;
    fromTableId: string;
    fromSeat: number;
    toTableId: string;
    toSeat: number;
    reason: string;
    timestamp: string;
  };
  // Session lifecycle
  SESSION_ENDED: { tableId: string; sessionId?: string; userId?: string };
  // Table creation
  TABLE_CREATED: { tableId: string; clubId?: string; table?: Record<string, unknown> };
  // Table lifecycle admin events
  TABLE_DELETED: { tableId: string; clubId?: string };
  TABLE_CLOSED: { tableId: string; clubId?: string };
  // Cross-page coordination events (ported from World Hub native pages)
  CHIPS_DISTRIBUTED: { clubId: string; amount?: number; userId?: string };
  CASHOUT_REQUESTED: { clubId: string; amount?: number; userId?: string };
  CASHOUT_APPROVED: { cashoutId: string; clubId: string };
  CASHOUT_CANCELLED: { cashoutId: string; clubId: string };
  CASHIER_BALANCE_CHANGED: { clubId: string; balance?: number };
  AGENT_UPDATED: { clubId: string; agentId?: string };
  PLAYER_KICKED: { clubId: string; userId?: string };
  CREDIT_UPDATED: { clubId: string; userId?: string; amount?: number };
  // Ported from World Hub: cross-page data mutation sync + chat badge sync
  DATA_MUTATED: { table: string; action: string; [key: string]: unknown };
  CHAT_MESSAGE_RECEIVED: {
    clubId?: string;
    tableId?: string;
    senderId?: string;
    message?: string;
    messageId?: string;
  };
  // Q4: Backported page events (Hub → Club Arena)
  TOURNAMENT_REGISTERED: {
    tournamentId: string;
    clubId?: string;
    unionId?: string;
    userId?: string;
  };
  TOURNAMENT_STARTED: { tournamentId: string; clubId?: string };
  TOURNAMENT_COMPLETE: { tournamentId: string; clubId?: string };
  ANTI_CHEAT_FLAG_CREATED: { clubId: string; flagId?: string; severity?: string };
  ANNOUNCEMENT_CREATED: { clubId: string; action?: string };
  // Phase 4: Remaining native page event payloads
  TOURNAMENT_CANCELLED: { tournamentId: string; clubId?: string; reason?: string };
  TOURNAMENT_LEVEL_CHANGE: {
    tournamentId: string;
    level?: number;
    smallBlind?: number;
    bigBlind?: number;
    ante?: number;
  };
  MEMBER_UPDATED: { clubId: string; userId?: string; role?: string };
  HAND_REPLAYED: { handId: string; clubId?: string };
  HAND_COMPLETE: { tableId?: string; clubId?: string; handNumber?: number };
  PLAYER_LEFT: { clubId: string; userId?: string; tableId?: string };
  RAKEBACK_CLAIMED: { clubId: string; amount?: number; userId?: string };
  CLUB_SETTINGS_UPDATED: { clubId?: string; setting?: string; value?: unknown };
  TICKER_SETTINGS_CHANGED: { scope: 'club' | 'union'; scopeId: string };
  // Phase 4 deep-sweep: overlay + theme payloads
  UI_THEME_CHANGED: {
    key: string;
    value?: unknown;
    /** Prevents a customization from another signed-in tab/account leaking in. */
    userId?: string;
    /** Present on optimistic paints and their rollbacks; absent on DB echoes. */
    mutationId?: string;
    /** Authoritative row clock used to preserve ALL-vs-variant precedence. */
    updatedAt?: string;
  };
  // Phase 8 Deep Sweep: flash pool game state event
  GAME_STATE_UPDATED: {
    tableId?: string;
    state?: string;
    poolId?: string;
    activePlayers?: number;
    tablesRunning?: number;
  };
  FLASH_POOL_JOINED: { poolId: string; userId: string; buyIn: number };
  // Production resilience
  CONNECTION_RESTORED: { timestamp: number };
  // Admin audit trail
  ADMIN_ACTION: {
    action: string;
    target: string;
    details?: Record<string, unknown>;
    userId?: string;
  };
  // Referral event
  REFERRAL_CLAIMED: { referralCode?: string; userId?: string; clubId?: string };
  // Player notes
  PLAYER_NOTE_SAVED: { clubId: string; targetUserId: string };
  TABLE_MENU_ACTION: {
    tableId: string;
    action:
      | 'SIT_OUT'
      | 'STAND_UP_BB'
      | 'AUTO_TOP_UP'
      | 'TOGGLE_SOUNDS'
      | 'TOGGLE_VIBRATIONS'
      | 'REBUY'
      | 'ADD_ON'
      | 'SESSION_STATS'
      | 'LEADERBOARD'
      | 'SETTINGS'
      | 'HAND_HISTORY'
      | 'HELP'
      | 'LEAVE_TABLE'
      | 'FORCE_LEAVE_TABLE'
      | 'CHANGE_AVATAR'
      | 'TOGGLE_ALIAS'
      /** Dan 2026-08-19: close a table's tab after the player leaves it. */
      | 'CLOSE_TABLE_TAB';
  };
  // Table settings open
  TABLE_SETTINGS_OPEN: { tableId: string };
  // UI navigation toggle
  HAMBURGER_TOGGLE: Record<string, unknown>;
  MENU_STATE_CHANGED: { isOpen: boolean };
  // Tournament break events
  BREAK_START: { tournamentId: string; durationMinutes?: number; resumeAt?: string };
  BREAK_END: { tournamentId: string };
  TOURNAMENT_BREAK: { tournamentId: string; level?: number; durationMinutes?: number };
  TOURNAMENT_BREAK_END: { tournamentId: string };
  // Satellite tournament completion
  SATELLITE_COMPLETE: {
    tournamentId: string;
    ticketWinners: number | unknown[];
    targetTournament: unknown;
  };
  // Round 20 — Engine→FE event coverage payloads. The engine emits the
  // lowercase form (rit_chooser_decided, bbj_hit, etc.) over WS; TablePage
  // re-emits onto the bus. Payloads are pass-through (Record<string, unknown>)
  // because the engine event shapes vary by event type and component-level
  // listeners narrow at use site.
  RIT_CHOOSER_DECIDED: Record<string, unknown>;
  BBJ_HIT: Record<string, unknown>;
  BBJ_PAYOUT_COMPLETE: Record<string, unknown>;
  POT_DISTRIBUTED: Record<string, unknown>;
  SHOWDOWN_CARDS_REVEALED: Record<string, unknown>;
  TIME_BANK_LOW: Record<string, unknown>;
  TIME_BANK_TIMEOUT: Record<string, unknown>;
  TOURNAMENT_LEVEL_UP: Record<string, unknown>;
  SEAT_TAKEN: Record<string, unknown>;
  SEAT_LEFT: Record<string, unknown>;
  TABLE_PAUSED: Record<string, unknown>;
  TABLE_RESUMED: Record<string, unknown>;
  TABLE_LOCKED: Record<string, unknown>;
  TABLE_UNLOCKED: Record<string, unknown>;
  RABBIT_HUNT_AVAILABLE: Record<string, unknown>;
  ALL_IN_EQUITY: Record<string, unknown>;
  ONLINE_COUNT: Record<string, unknown>;
}

export interface BusEvent<T = unknown> {
  type: BusEventType;
  payload: T;
  timestamp: string;
}

export interface AuthStatePayload {
  userId: string | null;
  isAuthenticated: boolean;
}

export interface ClubEventPayload {
  clubId: string;
  clubName?: string;
  action?: string;
}

export interface TableEventPayload {
  tableId: string;
  seat?: number;
  tableName?: string;
  userId?: string;
}

export interface BalancePayload {
  walletType: 'PLAYER' | 'BUSINESS' | 'PROMO';
  available: number;
  total: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER BUS STATUS
// ═══════════════════════════════════════════════════════════════════════════════

export interface MasterBusStatus {
  online: boolean;
  stores: {
    arena: boolean;
    club: boolean;
    table: boolean;
    union: boolean;
    wallet: boolean;
    settings: boolean;
    user: boolean;
  };
  eventSubscribers: number;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER BUS SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

type EventHandler<T = unknown> = (event: BusEvent<T>) => void;
type EventLogEntry = BusEvent & { id: number };
type OnEventCallback = (entry: EventLogEntry) => void;

// Auto-incrementing subscriber ID for unique debounce timer keys
let _subscriberIdCounter = 0;
let _eventLogIdCounter = 0;

// Critical events that trigger SW notification + Supabase log
const CRITICAL_EVENTS: BusEventType[] = [
  'BALANCE_UPDATED',
  'VIP_POINTS_UPDATED',
  'CLUB_JOINED',
  'CLUB_LEFT',
  'TABLE_SEATED',
  'TABLE_LEFT',
  'FINANCIAL_ALERT',
];

class MasterBusCore {
  private subscribers: Map<BusEventType, Set<EventHandler>> = new Map();
  private status: MasterBusStatus | null = null;
  private initialized: boolean = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPABASE CHANNEL REGISTRY — Prevents duplicate subscriptions
  // ═══════════════════════════════════════════════════════════════════════════
  private channelRegistry: Map<string, RealtimeChannel> = new Map();
  /**
   * SHARED-CHANNEL REFCOUNT 2026-08-28.
   *
   * `getOrCreateChannel` hands the SAME Supabase channel to every consumer of
   * a key, and `removeRegisteredChannel` used to tear it down unconditionally
   * — so the first component to unmount silenced it for everyone still
   * listening. Live shape: a player with the tournament lobby open beside a
   * table in the same event closes the lobby, and the table stops receiving
   * `t-break-<id>` break countdowns, add-on windows and bounty reveals for the
   * rest of the event, with no error anywhere. Four consumers bind that one
   * key (useMysteryBounty, MysteryBountyCelebration, TournamentLobbyPage,
   * TablePage), and only one of them even attempted a guard — "I created it"
   * is not "nobody else is reading it", which is why the guard could not work.
   *
   * The count belongs HERE, with the map it protects, not in each caller.
   */
  private channelRefs: Map<string, number> = new Map();
  private debouncedTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // #4: Channel health monitor interval
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Phase 7: Cross-Tab Broadcast Channel
  private broadcastChannel: BroadcastChannel | null = null;

  // #9 Event log for DevTools dashboard (capped at 200)
  private eventLog: EventLogEntry[] = [];
  private onEventCallbacks: Set<OnEventCallback> = new Set();
  private static MAX_EVENT_LOG = 200;

  // Phase 15: Event deduplication — fingerprint cache prevents duplicate subscriber reactions
  private recentEventFingerprints = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 500;
  // Events that must NEVER be deduplicated (financial, errors, auth)
  private static readonly DEDUP_BYPASS: BusEventType[] = [
    'BALANCE_UPDATED',
    'VIP_POINTS_UPDATED',
    'WALLET_REFRESHED',
    'SYSTEM_ERROR',
    'AUTH_STATE_CHANGED',
    'DIAMOND_BALANCE_CHANGED',
    // Every tap is an ordered visual mutation. Suppressing a repeated choice
    // can strand a rollback or a second mounted table on the prior artwork.
    'UI_THEME_CHANGED',
    'PLAYER_APPEARANCE_CHANGED',
    'SETTINGS_CHANGED',
    'USER_PROFILE_LOADED',
    'CUSTOMIZATION_MUTATION_STATE',
    // A receipt must unlock every mounted picker, even when two rewards grant
    // the same bundle inside the fingerprint window.
    'COSMETIC_OWNERSHIP_CHANGED',
    // Two distinct purchases may legitimately grant the same quantity inside
    // 500ms. A ledger delivery event must never be fingerprint-deduplicated.
    'ENTITLEMENTS_CHANGED',
    // ANIMATION AUDIT 2026-08-27: gameplay-animation events added. These are
    // engine-fact relays whose payloads can legitimately repeat within 500ms
    // (two identical antes, an engine re-emit after reconnect, back-to-back
    // pots of the same size) — deduping them SKIPPED the second animation
    // with only a console.debug. Dan's rule: no animation is ever skipped.
    'BOMB_POT_TRIGGERED',
    'BOMB_POT_COMPLETED',
    'SHOWDOWN_CARDS_REVEALED',
    'RIT_OFFERED',
    'BBJ_HIT',
    'POT_DISTRIBUTED',
  ];

  // #4b Channel factory registry for auto-recovery
  private channelFactoryRegistry: Map<string, () => void> = new Map();

  /**
   * Initialize the Master Bus
   * Verifies all stores are accessible and sets up event system
   */
  init(): MasterBusStatus {
    if (this.initialized) {
      return this.status!;
    }

    const stores = {
      arena: false,
      club: false,
      table: false,
      union: false,
      wallet: false,
      settings: false,
      user: false,
    };

    // Verify each store is accessible
    try {
      const arenaState = useArenaStore.getState();
      stores.arena = arenaState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._ArenaStore_Error');
    }

    try {
      const clubState = useClubStore.getState();
      stores.club = clubState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._ClubStore_Error');
    }

    try {
      const tableState = useTableStore.getState();
      stores.table = tableState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._TableStore_Error');
    }

    try {
      const unionState = useUnionStore.getState();
      stores.union = unionState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._UnionStore_Error');
    }

    try {
      const walletState = useWalletStore.getState();
      stores.wallet = walletState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._WalletStore_Error');
    }

    try {
      const settingsState = useSettingsStore.getState();
      stores.settings = settingsState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._SettingsStore_Error');
    }

    try {
      const userState = useUserStore.getState();
      stores.user = userState !== undefined;
    } catch (e) {
      reportError(e, 'MasterBus._UserStore_Error');
    }

    // Determine overall status
    const allOnline = Object.values(stores).every((s) => s === true);

    this.status = {
      online: allOnline,
      stores,
      eventSubscribers: this.getTotalSubscribers(),
      timestamp: new Date().toISOString(),
    };

    this.initialized = true;

    // Set up internal event handlers for cross-store sync
    this.setupInternalHandlers();

    // Set up native broadcast channel for cross-tab synchronization
    if (typeof window !== 'undefined' && window.BroadcastChannel) {
      this.broadcastChannel = new BroadcastChannel('smarter-poker-master-bus');
      this.broadcastChannel.onmessage = (event) => {
        if (event.data && event.data.type && event.data.payload) {
          // Re-emit local events received from other tabs, explicitly marking them as fromBroadcast
          this.emit(event.data.type, event.data.payload, true);
        }
      };
    }

    // #4: Start channel health monitoring (every 30s)
    this.startChannelHealthMonitor();

    return this.status;
  }

  /**
   * Subscribe to an event type — type-safe version
   */
  subscribe<K extends BusEventType>(
    eventType: K,
    handler: (event: BusEvent<K extends keyof BusPayloadMap ? BusPayloadMap[K] : unknown>) => void
  ): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }

    this.subscribers.get(eventType)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  /**
   * Emit an event to all subscribers — type-safe version
   * Also logs a Sentry breadcrumb for observability (#8)
   */
  emit<K extends BusEventType>(
    type: K,
    payload: K extends keyof BusPayloadMap ? BusPayloadMap[K] : unknown,
    fromBroadcast: boolean = false
  ): void {
    const event: BusEvent<typeof payload> = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    // Phase 15: Event deduplication — suppress duplicate events within 500ms window
    if (!MasterBusCore.DEDUP_BYPASS.includes(type)) {
      try {
        const fingerprint = `${type}:${JSON.stringify(payload)}`;
        const now = Date.now();
        const lastSeen = this.recentEventFingerprints.get(fingerprint);
        if (lastSeen && now - lastSeen < MasterBusCore.DEDUP_WINDOW_MS) {
          // Duplicate within window — suppress subscriber dispatch, still log
          console.debug(`[MasterBus] Dedup suppressed: ${type} (${now - lastSeen}ms since last)`);
          return;
        }
        this.recentEventFingerprints.set(fingerprint, now);
        // Auto-clean fingerprint after window expires
        setTimeout(
          () => this.recentEventFingerprints.delete(fingerprint),
          MasterBusCore.DEDUP_WINDOW_MS
        );
      } catch {
        // JSON.stringify failure on circular ref — skip dedup, let event through
      }
    }

    // Phase 7: Cross-tab synchronization
    if (!fromBroadcast && this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({ type, payload });
      } catch (e: any) {
        console.warn('[MasterBus] Failed to broadcast event cross-tab:', e);
        // Phase 11: Structured error telemetry for Sentry visibility
        if (type !== 'SYSTEM_ERROR') {
          this.emit('SYSTEM_ERROR', {
            message: `BroadcastChannel postMessage failed for ${type}: ${e?.message || 'unknown'}`,
            code: 'BROADCAST_CHANNEL_ERROR',
          });
        }
      }
    }

    // #9: Log to event log for DevTools dashboard
    const logEntry: EventLogEntry = { ...(event as BusEvent), id: ++_eventLogIdCounter };
    this.eventLog.push(logEntry);
    if (this.eventLog.length > MasterBusCore.MAX_EVENT_LOG) {
      this.eventLog = this.eventLog.slice(-MasterBusCore.MAX_EVENT_LOG);
    }
    // Notify live DevTools listeners
    this.onEventCallbacks.forEach((cb) => {
      try {
        cb(logEntry);
      } catch {
        /* */
      }
    });

    // #8: Log Sentry breadcrumb for every event
    try {
      if (typeof window !== 'undefined' && (window as any).__SENTRY__) {
        import('./sentryBundle')
          .then((Sentry) => {
            Sentry.addBreadcrumb({
              category: 'masterBus',
              message: type,
              level: 'info',
              data:
                typeof payload === 'object'
                  ? (payload as Record<string, unknown>)
                  : { value: payload },
            });
          })
          .catch(() => {
            /* Sentry not available */
          });
      }
    } catch {
      /* silent */
    }

    // #9b: Forward critical events to Service Worker for background notifications
    if (CRITICAL_EVENTS.includes(type)) {
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'BUS_EVENT',
            event: { type, payload, timestamp: event.timestamp },
          });
        }
      } catch {
        /* SW not available */
      }
    }

    const handlers = this.subscribers.get(type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          const result = handler(event as BusEvent) as any;
          if (result instanceof Promise) {
            result.catch((e: any) => {
              reportError(e, 'MasterBus.Handler_failed_for_type');
            });
          }
        } catch (e) {
          reportError(e, 'MasterBus.Handler_failed_for_type');
        }
      });
    }
  }

  /**
   * Set up internal handlers for cross-store synchronization
   */
  private setupInternalHandlers(): void {
    // Light/dark mode is part of the same visual system as felt art. Zustand's
    // persisted store updates the source tab before emitting; this handler is
    // what applies a BroadcastChannel or database-originated change in every
    // other mounted tab without calling setTheme() and echoing it back.
    this.subscribe('UI_THEME_CHANGED', (event) => {
      if (event.payload.key !== 'theme') return;
      const activeUserId = useUserStore.getState().user?.id;
      if (event.payload.userId && event.payload.userId !== activeUserId) return;
      const theme = event.payload.value;
      if (theme !== 'light' && theme !== 'dark') return;
      if (useSettingsStore.getState().theme !== theme) {
        useSettingsStore.setState({ theme });
      }
      /* Keep the full /settings cache coherent too. A profile realtime event
         used to repaint the app and update Zustand while leaving this separate
         cache on the old mode; opening Settings then saved that stale value
         back over the cross-device choice. The source tab has already mirrored
         this cache before it emits, so only remote/stale events rebroadcast a
         SETTINGS_UPDATED notification here. */
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
          const parsed = raw ? JSON.parse(raw) : {};
          const current =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
          if ((current as Record<string, unknown>).theme !== theme) {
            const next = { ...(current as Record<string, unknown>), theme };
            localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
            this.emit('SETTINGS_UPDATED', { settings: next });
          }
        } catch (error) {
          reportError(error, 'MasterBus.Interface_theme_cache_sync_failed');
        }
      }
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.style.colorScheme = theme;
      }
    });

    // When auth state changes, sync user data across stores
    this.subscribe('AUTH_STATE_CHANGED', (event) => {
      const { userId, isAuthenticated } = event.payload;

      if (isAuthenticated && userId) {
        // Load user-specific data
        useClubStore.getState().loadMemberships();
        useWalletStore.getState().refreshAll(userId);
      } else {
        // Clear user data on logout
        useClubStore.getState().reset();
        useWalletStore.getState().reset();
        useArenaStore.getState().reset();
      }
    });

    // When balance updates, immediately sync the WalletStore globally
    this.subscribe('BALANCE_UPDATED', () => {
      const user = useUserStore.getState().user;
      if (user) {
        useWalletStore.getState().refreshAll(user.id);
      }
    });

    // Phase 14 Fix: Ensure global diamond balances sync properly across all headers
    this.subscribe('DIAMOND_BALANCE_CHANGED', () => {
      const user = useUserStore.getState().user;
      if (user) {
        // force: this fires BECAUSE the balance changed. The store's freshness
        // window is there to make component mounts free, not to suppress an
        // event that exists to report a change.
        useWalletStore.getState().loadDiamonds(user.id, { force: true });
      }
    });

    // Phase 7: Reload diamond balance after any diamond spend (Table Studio purchases, etc.)
    this.subscribe('DIAMOND_SPENT', () => {
      const user = useUserStore.getState().user;
      if (user) {
        // force: the player just spent diamonds - the number on screen is known
        // to be wrong at this instant.
        useWalletStore.getState().loadDiamonds(user.id, { force: true });
      }
    });

    // When joining a club, subscribe to realtime channel
    this.subscribe('CLUB_JOINED', (event) => {
      const { clubId } = event.payload;
      const user = useUserStore.getState().user;

      if (user) {
        realtimeChannelService.subscribeToClub(
          clubId,
          user.id,
          {
            id: user.id,
            displayName: user.display_name || user.username,
            playerNumber: 0,
            avatarUrl: user.avatar_url || '',
            status: 'online',
          },
          {
            onEvent: () => {
              /* reserved for future club channel events */
            },
          }
        );
      }
    });

    // When leaving a club, unsubscribe from realtime
    this.subscribe('CLUB_LEFT', (event) => {
      realtimeChannelService.unsubscribeFromClub(event.payload.clubId);
    });
  }

  /**
   * Get total number of event subscribers
   */
  private getTotalSubscribers(): number {
    let total = 0;
    this.subscribers.forEach((handlers) => {
      total += handlers.size;
    });
    return total;
  }

  /**
   * Get current Master Bus status
   */
  getStatus(): MasterBusStatus | null {
    if (this.status) {
      this.status.eventSubscribers = this.getTotalSubscribers();
    }
    return this.status;
  }

  /**
   * Check if Master Bus is online
   */
  isOnline(): boolean {
    return this.status?.online === true;
  }

  /**
   * Reset the Master Bus (for testing or logout)
   */
  reset(): void {
    this.subscribers.clear();
    // Clean up all registered Supabase channels
    this.channelRefs.clear();
    this.channelRegistry.forEach((channel) => {
      supabase.removeChannel(channel);
    });
    this.channelRegistry.clear();
    this.channelFactoryRegistry.clear();
    this.debouncedTimers.forEach((timer) => clearTimeout(timer));
    this.debouncedTimers.clear();
    this.eventLog = [];
    this.onEventCallbacks.clear();
    // Phase 15: Clear dedup fingerprint cache
    this.recentEventFingerprints.clear();
    // #4: Stop health monitor
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Close cross-tab channel
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }

    this.status = null;
    this.initialized = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIMISTIC MIDDLEWARE (Phase 7)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Optimistic Execution Middleware (Zero Latency UI)
   * Instantly emits the optimistic payload to update the UI lag-free,
   * awaits the database mutate, and gracefully rolls back the cache upon failure.
   */
  async executeOptimistic<T, K extends BusEventType>(
    eventType: K,
    optimisticPayload: K extends keyof BusPayloadMap ? BusPayloadMap[K] : unknown,
    asyncFn: () => Promise<T>,
    rollbackPayload?: K extends keyof BusPayloadMap ? BusPayloadMap[K] : unknown
  ): Promise<T> {
    // 1. Instantly Mutate the Local World State (0ms Latency)
    this.emit(eventType, optimisticPayload);

    // 2. Await the Server-Side Source of Truth
    try {
      return await asyncFn();
    } catch (err: any) {
      // 3. Rollback the World State silently upon failure
      if (rollbackPayload) {
        this.emit(eventType, rollbackPayload);
      }

      // Dispatch globally for structured error alerts if not suppressed
      this.emit('SYSTEM_ERROR', {
        message: err.message || 'Optimistic execution failed and was rolled back.',
        code: err.code || 'OPTIMISTIC_ROLLBACK',
      });

      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #1: CHANNEL REGISTRY — Deduplicated Supabase channel management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get or create a Supabase channel — guarantees exactly one channel per key.
   * If a channel with the same key already exists, returns it.
   */
  getOrCreateChannel(key: string, options?: { private?: boolean }): RealtimeChannel {
    // Every handout takes a reference; removeRegisteredChannel gives one back.
    this.channelRefs.set(key, (this.channelRefs.get(key) ?? 0) + 1);
    const existing = this.channelRegistry.get(key);
    if (existing) return existing;

    const channel = supabase.channel(
      key,
      options?.private ? { config: { private: true } } : undefined
    );
    this.channelRegistry.set(key, channel);
    // Emit REALTIME_CONNECTED so ConnectionIndicator knows we have live channels
    this.emit('REALTIME_CONNECTED', { channelName: key });
    return channel;
  }

  /**
   * Release one reference to a registered channel. The channel is torn down
   * only when the LAST consumer lets go — see the channelRefs note above.
   */
  removeRegisteredChannel(key: string): void {
    const remaining = (this.channelRefs.get(key) ?? 0) - 1;
    if (remaining > 0) {
      this.channelRefs.set(key, remaining);
      return;
    }
    this.channelRefs.delete(key);
    const channel = this.channelRegistry.get(key);
    if (channel) {
      supabase.removeChannel(channel);
      this.channelRegistry.delete(key);
    }
  }

  /**
   * Force a channel down regardless of who still holds it. For teardown paths
   * that own the whole surface (a full bus reset, sign-out) — never for a
   * component unmount, which is what the refcounted release above is for.
   */
  forceRemoveRegisteredChannel(key: string): void {
    this.channelRefs.delete(key);
    const channel = this.channelRegistry.get(key);
    if (channel) {
      supabase.removeChannel(channel);
      this.channelRegistry.delete(key);
    }
  }

  /**
   * Check if a channel is already registered
   */
  hasChannel(key: string): boolean {
    return this.channelRegistry.has(key);
  }

  /**
   * Get count of registered channels (for diagnostics)
   */
  getChannelCount(): number {
    return this.channelRegistry.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #4: DEBOUNCED SUBSCRIPTION — Prevents rapid-fire event storms
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe with debounce — collapses rapid-fire events into one call.
   * #2 FIX: Uses unique per-subscriber timer keys (no cross-subscriber collision).
   * #1 FIX: Clears pending timer on unsubscribe (no stale handler fire).
   */
  subscribeDebounced<K extends BusEventType>(
    eventType: K,
    handler: (event: BusEvent<K extends keyof BusPayloadMap ? BusPayloadMap[K] : unknown>) => void,
    debounceMs: number = 300
  ): () => void {
    // #2: Unique timer key per subscriber instance
    const subscriberId = ++_subscriberIdCounter;
    const timerKey = `${eventType}_debounce_${subscriberId}`;

    const debouncedHandler: EventHandler = (event) => {
      const existing = this.debouncedTimers.get(timerKey);
      if (existing) clearTimeout(existing);

      this.debouncedTimers.set(
        timerKey,
        setTimeout(() => {
          try {
            const result: any = (handler as EventHandler)(event);
            // If handler returns a promise, catch its rejection too
            if (result && typeof result.catch === 'function') {
              result.catch((err: unknown) => {
                console.warn(`[MasterBus] Async handler error for ${eventType}:`, err);
              });
            }
          } catch (err) {
            console.warn(`[MasterBus] Handler error for ${eventType}:`, err);
          }
          this.debouncedTimers.delete(timerKey);
        }, debounceMs)
      );
    };

    const unsubFromBus = this.subscribe(eventType, debouncedHandler as any);

    // #1: Return enhanced unsubscribe that also clears any pending timer
    return () => {
      unsubFromBus();
      const pendingTimer = this.debouncedTimers.get(timerKey);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.debouncedTimers.delete(timerKey);
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #4: CHANNEL HEALTH MONITOR — Auto-detect dead channels
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Periodically checks channel health. Removes channels in CLOSED or
   * CHANNEL_ERROR state from the registry to prevent stale references.
   */
  private startChannelHealthMonitor(): void {
    if (this.healthCheckInterval) return; // Already running

    this.healthCheckInterval = setInterval(() => {
      const deadChannels: string[] = [];

      this.channelRegistry.forEach((channel, key) => {
        const state = (channel as any).state;
        if (state === 'closed' || state === 'errored') {
          console.warn(`[BUS HEALTH] Dead channel detected: "${key}" (state: ${state})`);
          deadChannels.push(key);
          // Emit REALTIME_DISCONNECTED so ConnectionIndicator shows offline
          this.emit('REALTIME_DISCONNECTED', { channelName: key, reason: `Channel ${state}` });
        }
      });

      deadChannels.forEach((key) => {
        // #4b: Auto-recovery — try to re-create via factory if registered
        const factory = this.channelFactoryRegistry.get(key);
        if (factory) {
          this.removeRegisteredChannel(key);
          console.debug(`[BUS HEALTH] Auto-recovering channel: "${key}"`);
          try {
            factory();
            // Emit REALTIME_CONNECTED after successful recovery
            this.emit('REALTIME_CONNECTED', { channelName: key });
          } catch (e) {
            reportError(e, 'MasterBus.Recovery_failed_for_key');
          }
        } else if (this.isCriticalChannelKey(key)) {
          // P2-4: A critical channel (e.g. per-user hole cards
          // `table-cards-secure-*`) with no re-subscribe factory must NOT be
          // silently removed — removeChannel would destroy the underlying
          // Supabase channel and abort its own auto-rejoin, leaving the hero
          // permanently blind for the session. Leave it in place so Supabase's
          // realtime client keeps attempting to rejoin, and surface it loudly.
          reportError(
            new Error(`Critical realtime channel dead with no recovery factory: ${key}`),
            'MasterBus.Critical_channel_no_factory'
          );
          console.warn(
            `[BUS HEALTH] Critical channel "${key}" dead but has no factory -- leaving in place for Supabase auto-rejoin (NOT reaping)`
          );
        } else {
          this.removeRegisteredChannel(key);
          console.warn(`[BUS HEALTH] No factory for "${key}" -- removed only`);
        }
      });
    }, 30_000); // Every 30 seconds
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #9: DIAGNOSTICS — Dev-mode debugging dashboard data
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns a diagnostics snapshot for dev debugging.
   */
  getDiagnostics(): {
    subscribers: Record<string, number>;
    channels: { key: string; state: string }[];
    pendingTimers: number;
    initialized: boolean;
    eventLogSize: number;
    channelFactories: number;
  } {
    const subscribers: Record<string, number> = {};
    this.subscribers.forEach((handlers, event) => {
      subscribers[event] = handlers.size;
    });

    const channels = Array.from(this.channelRegistry.entries()).map(([key, ch]) => ({
      key,
      state: (ch as any).state || 'unknown',
    }));

    return {
      subscribers,
      channels,
      pendingTimers: this.debouncedTimers.size,
      initialized: this.initialized,
      eventLogSize: this.eventLog.length,
      channelFactories: this.channelFactoryRegistry.size,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #9: EVENT LOG — DevTools dashboard live feed
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get the event log (newest last) */
  getEventLog(): EventLogEntry[] {
    return [...this.eventLog];
  }

  /** Clear the event log */
  clearEventLog(): void {
    this.eventLog = [];
  }

  /** Register a live callback for new events (returns unsubscribe fn) */
  onEvent(callback: OnEventCallback): () => void {
    this.onEventCallbacks.add(callback);
    return () => {
      this.onEventCallbacks.delete(callback);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // #4b: CHANNEL FACTORY REGISTRY — For auto-recovery
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register a factory function for a channel key (enables auto-recovery) */
  registerChannelFactory(key: string, factory: () => void): void {
    this.channelFactoryRegistry.set(key, factory);
  }

  /** Remove a channel factory */
  removeChannelFactory(key: string): void {
    this.channelFactoryRegistry.delete(key);
  }

  /**
   * Whether a channel key carries data that must never be silently reaped by
   * the health monitor without a recovery path. Currently the per-user secure
   * hole-card channel (`table-cards-secure-*`) — losing it blinds the hero for
   * the rest of the session (see P2-4). Kept as a method so the set of critical
   * prefixes can grow in one place.
   */
  private isCriticalChannelKey(key: string): boolean {
    return key.startsWith('table-cards-secure-');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// Singleton instance
export const masterBus = new MasterBusCore();

// Convenience functions
export function initMasterBus(): MasterBusStatus {
  return masterBus.init();
}

export function getMasterBusStatus(): MasterBusStatus | null {
  return masterBus.getStatus();
}

export function isMasterBusOnline(): boolean {
  return masterBus.isOnline();
}

/**
 * Convenience helper: show a toast via the MasterBus → BusToastBridge pipeline.
 * Services can call this without importing the React toast hook.
 */
export function busToast(
  message: string,
  severity: 'critical' | 'warning' | 'info' | 'clock' = 'info',
  durationMs?: number
): void {
  masterBus.emit('SHOW_TOAST', { message, severity, source: 'busToast', durationMs });
}
