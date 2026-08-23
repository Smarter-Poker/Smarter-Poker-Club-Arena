/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Premium Poker Table Page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * premium-style table interface with Facebook color scheme
 * Features:
 * - Oval table with premium rail
 * - 6-max or 9-max seating
 * - Real-time pot and community cards
 * - Action panel with raise slider
 * - Jackpot banner
 * - WebSocket connection for real-time game state
 */

import { useState, useEffect, useCallback, useRef, startTransition, useMemo } from 'react';
import { publishSessionSummary, type TournamentResult } from '../services/pendingSessionSummary';
import { setShownCards } from '../services/ShowCardsService';
import { useParams, useNavigate } from 'react-router-dom';
import {
  SeatSlot,
  PotDisplay,
  CommunityCards,
  DealerButton,
  DealAnimation,
} from '../components/table';
import type { SeatPlayer, Card, LastAction, PositionBadge } from '../components/table/SeatSlot';
import type { SidePot } from '../components/table/PotDisplay';
import type { BoardStage } from '../components/table/CommunityCards';
import { normalizeCardBack } from '../components/table/CardImage';
// Rabbit-hunt button artwork (Dan: "use the actual rabbit hunt dynamic image").
// Imported through Vite rather than referenced from public/ on purpose: an
// imported asset is emitted into dist/assets/, and sync-club-arena.sh copies
// assets/ wholesale while it deliberately PRESERVES (i.e. never updates)
// public/hub/club-arena/images/. A new file dropped in images/ would never
// reach production, and git-safe-push.sh's `git clean` sweeps untracked files
// there — assets/ is explicitly excluded from that clean.
// Dan 2026-08-17 — five new composite skins (his renders) + three derived
// colorways, all sharing the SAME canonical geometry as the original five
// (felt window 20.3-79.6% x 8.9-89.2% of the 896x1200 frame, measured by
// felt-edge scan). One asset per skin serves BOTH the darkened page backdrop
// and the in-scaler table art, so seats always land on the painted rail.

/**
 * Canonical skin registry. Every entry is a 896x1200 composite (scene +
 * painted table) with the table oval in the SAME position, so one seat map
 * and one felt window work for all of them. Aliases keep older stored
 * table_id values working.
 */

import smarterPokerLetterLogo from '../assets/smarter-poker-letter-logo.png';
import { useTableWebSocket } from '../services/TableWebSocket';
import { supabase, getAuthUser } from '../lib/supabase';
// Phase 1.1 PR-3: authoritative engine WS state. Mounted always; becomes the
// source of truth for game-state fields when VITE_USE_ENGINE_WS=1. The old
// Supabase Realtime game-state path stays wired in parallel until PR-5 deletes
// it, so flipping the flag is a pure rollout switch.
import { useEngineTableState } from '../hooks/useEngineTableState';
import { mapEngineSnapshot } from '../utils/mapEngineSnapshot';
import { gameCode } from '../utils/gameCode';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { masterBus } from '../core/MasterBus';
import {
  useMasterBusSubscription,
  useMasterBusSubscriptions,
} from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { playerStatusService } from '../services/PlayerStatusService';
import { avatarService } from '../services/AvatarService';
import PlayerNotesPanel from '../components/gameplay/PlayerNotesPanel';
import HandReplay from '../components/replay/HandReplay';
import { GameRulesModal } from '../components/table/GameRulesModal';
import SitOutModal from '../components/table/SitOutModal';
import WaitListModal from '../components/table/WaitListModal';
import { waitlistService } from '../services/WaitlistService';
import { roomService, type RoomMessage } from '../services/RoomService';
import { HydraService } from '../services/HydraService';
import TableChat, { type ChatMessage } from '../components/table/TableChat';
import InsuranceModal, { type InsuranceOffer } from '../components/table/InsuranceModal';
import { RunItTwicePrompt } from '../components/table/RunItTwice';
import BadBeatJackpot from '../components/table/BadBeatJackpot';
import { BBJCelebration } from '../components/table/BBJCelebration';
import { ThrowableSelector } from '../components/table/ThrowableSelector';
import { ThrowAnimationContainer } from '../components/table/ThrowAnimation';
import { throwableService, type Throwable, type ThrowEvent } from '../services/ThrowableService';
import { useTabKeepAlive, workerTimeout, cancelWorkerTimeout } from '../hooks/useTabKeepAlive';
import { STORAGE_KEYS } from '../lib/storage';
import StraddleToggle from '../components/table/StraddleToggle';
import TimeBank from '../components/table/TimeBank';
import CashierModal from '../components/table/CashierModal';
import BuyInModal from '../components/table/BuyInModal';
import IdentityModal from '../components/table/IdentityModal';
// Phase 1.2 PR-F: top-level disconnect FSM toast
import DisconnectToast from '../components/table/DisconnectToast';
// Phase 1.3 PR-C+D: server-rejection toast + auto-snap hint imported below
// at the existing ActionErrorToast import line — do not duplicate here.
// Phase 2 T2-01 (spec §5.6): Fold Protection Dialog.
import FoldProtectionDialog from '../components/table/FoldProtectionDialog';
// Phase 2 T2-02 (spec §5.7): Always-visible timebank counter (bottom-left).
import TimebankCounter from '../components/table/TimebankCounter';
// Dan 2026-08-21, item 3: buy more time banks with diamonds (1/10/25/100/500).
import TimeBankStoreModal from '../components/table/TimeBankStoreModal';
import { sessionStatsService } from '../services/SessionStatsService';
import RabbitHunt from '../components/table/RabbitHunt';
import LeaderboardPanel from '../components/table/LeaderboardPanel';
import HandNotation from '../components/table/HandNotation';
import { soundService, haptic } from '../services/SoundService';
import { ConfettiCanvas } from '../components/table/ConfettiCanvas';
import { ParticleSystem } from '../components/table/ParticleSystem';
import {
  ChipAnimationManager,
  createChipToPotEvent,
  createPotToWinnerEvent,
  type ChipAnimationEvent,
} from '../components/table/ChipAnimation';
import MiniHUD from '../components/table/MiniHUD';
// PotOddsDisplay intentionally NOT used on live tables — available for practice/training mode only
import HandHistoryPanel, {
  type HandRecord,
  type HandHistoryAction,
  type HandHistoryStreet,
} from '../components/table/HandHistoryPanel';
// [MIGRATION] timeBankEngine removed — server-authoritative (Step 5). Time bank via GameServerAPI + DB.
import { usePlayerStats } from '../hooks/usePlayerStats';
import { useTableSettings } from '../hooks/useTableSettings';
import { useTableTimer } from '../hooks/useTableTimer';
import { useTableModals } from '../hooks/useTableModals';
import { useTableChat } from '../hooks/useTableChat';
import { useTableTournament } from '../hooks/useTableTournament';
import { useTableAnimations } from '../hooks/useTableAnimations';
import { useTableSound } from '../hooks/useTableSound';
import { useTableSession } from '../hooks/useTableSession';
import { GTOQueryService, type GTOSolution } from '../services/GTOQueryService';
import { tableService } from '../services/TableService';
import { WalletService } from '../services/WalletService';
import ActionPanel from '../components/table/ActionPanel';
import { potSizedRaiseTo } from '../components/table/ActionPanel';
import { betChipOffsetPx, chipCollectOffsetPx } from '../components/table/tableGeometry';
import PreActionBar from '../components/table/PreActionBar';
// The ShareHand COMPONENT is rendered by TableModalsLayer, not here — the
// default import this line used to carry was unused. TablePage builds the
// payload, so it needs the types.
import type { ShareableHand, ShareableCard, ShareableAction } from '../components/table/ShareHand';
import SettingsPanel from '../components/table/SettingsPanel';
import TableMenu from '../components/table/TableMenu';
import {
  SitOutIcon,
  RebuyIcon,
  AddOnIcon,
  HandHistoryIcon,
  LeaderboardIcon,
  SessionStatsIcon,
  SettingsIcon,
  HelpIcon,
  LeaveTableIcon,
} from '../components/table/TableMenuIcons';
import LeaveTableConfirm from '../components/table/LeaveTableConfirm';
import PresenceIndicator from '../components/social/PresenceIndicator';
import { useToast } from '../components/common/Toast';
import TournamentBreakScreen from '../components/table/TournamentBreakScreen';
import AddOnModal from '../components/table/AddOnModal';
import TournamentAnnouncementOverlay from '../components/table/TournamentAnnouncementOverlay';
import KnockoutAnimation, { type KnockoutData } from '../components/tournament/KnockoutAnimation';
import MysteryBountyChest, {
  type MysteryChestData,
} from '../components/tournament/MysteryBountyChest';
import { useAnimationQueue } from '../hooks/useAnimationQueue';
import SpinWheel, {
  DEFAULT_SPIN_TIERS,
  parseLockedTiers,
  type SpinWheelData,
} from '../components/tournament/SpinWheel';
import RebuyModal from '../components/table/RebuyModal';
import TournamentWinnerOverlay from '../components/table/TournamentWinnerOverlay';
import { isSpinTournament, type SpinRevealSubject } from '../utils/spinReveal';
// RealtimeChannelService imported if needed for future use
import ChipStack from '../components/table/ChipStack';
import { tournamentService } from '../services/TournamentService';
import TimerBar from '../components/table/TimerBar';
import RealTimeResults from '../components/table/RealTimeResults';
// [MIGRATION] All engine imports removed — server-authoritative (Steps 1-7 complete)
import { handPersistenceService } from '../services/HandPersistenceService';
import { handHistoryService } from '../services/HandHistoryService';
// Dan 2026-08-15: the real rake schedule (byte-identical mirror of the
// server's), used so the Game Rules modal states the rake actually taken.
import { resolveDisplayRake } from '../lib/rakeOverride';
// Dan 2026-08-15: two distinct HandRecord shapes exist — the snake_case
// Supabase row from the service, and the camelCase view-model the panel
// renders. Alias both so adaptServiceHandToPanel below reads unambiguously.
import { LeaderboardService } from '../services/LeaderboardService';
import { achievementTriggerService } from '../services/AchievementTriggerService';
import { dailyChallengeService } from '../services/DailyChallengeService';
// REPLACE_ME from '../services/AchievementTriggerService';
import { notificationService } from '../services/NotificationService';
import SpectatorBadge from '../components/table/SpectatorBadge';
// FIX 194: HandStrengthIndicator REMOVED — not allowed for live online gameplay
// import HandStrengthIndicator from '../components/table/HandStrengthIndicator';
import SessionTimer from '../components/table/SessionTimer';
import { horseBugReporter } from '../services/HorseBugReporter';
import { useUserTableSettings } from '../hooks/useUserTableSettings';
import { useUserThemeSettings } from '../hooks/useUserThemeSettings';
import PineappleDiscard from '../components/table/PineappleDiscard';
import GameServerAPI, {
  submitAction,
  respondToRIT,
  respondToInsurance,
  sendHeartbeat,
  setPreAction as serverSetPreAction,
  setSitOut,
  showHand as serverShowHand,
  toggleStraddle as serverToggleStraddle,
  postBBToEnter as serverPostBBToEnter,
} from '../services/GameServerAPI';
import DiamondWalletModal from '../components/wallet/DiamondWalletModal';
import { retryAsync } from '../utils/retryAsync';
//monteCarloEquity import removed — server-authoritative
import './TablePage.css';
import { SessionHUD } from '../components/table/SessionHUD';
import { BombPotOverlay } from '../components/table/BombPotOverlay';
import { ConnectionHUD } from '../components/table/ConnectionHUD';
import { TableErrorBoundary } from '../components/common/TableErrorBoundary';
import { FinalTableOverlay } from '../components/tournament/FinalTableOverlay';
import { HeadsUpOverlay } from '../components/tournament/HeadsUpOverlay';
// Phase 8-9 Premium Components
import { QuickActionsBar } from '../components/table/QuickActionsBar';
import { SpectatorOverlay } from '../components/table/SpectatorOverlay';
import { TableReactions } from '../components/table/TableReactions';
import { useTableKeyboard } from '../hooks/useTableKeyboard';

import { TablePerfMonitor } from '../components/table/TablePerfMonitor';
// IMPROVEMENT PASS 2026-08-19: PremiumCard, PlayerCard, HoleCardReveal and
// createChipToPotEvent imports removed — imported for years, never rendered
// or called (dead weight in the TablePage chunk).
import { playerStyleClassifier } from '../services/PlayerStyleClassifier';
// Phase 9: Previously unwired table components
import { StreamerMode } from '../components/table/StreamerMode';
import { BankrollWidget } from '../components/table/BankrollWidget';
import { HandReveal } from '../components/table/HandReveal';
import PositionStatsPopup from '../components/table/PositionStatsPopup';
import { SessionTrajectoryMini } from '../components/table/SessionTrajectoryMini';
import { StreakBadge } from '../components/table/StreakBadge';

import { useIsMounted } from '../hooks/useIsMounted';
import { useFrameBudgetMonitor } from '../hooks/useFrameBudgetMonitor';
// Bible V8 §11: 4-Corner Table HUD Components
import { TableHUD } from '../components/table/TableHUD';
import { MiniStatsCard } from '../components/table/MiniStatsCard';
import { PreviousHandCard } from '../components/table/PreviousHandCard';
import { HandDetailModal } from '../components/table/HandDetailModal';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage, shouldSurfaceError } from '../utils/safeErrorMessage';
import { serverNow } from '../utils/serverClock';
// Dan 2026-08-21, item 15: hero's live hand strength under their seat box.
import { bestFive } from '../utils/handEvaluator';
// Dan 2026-08-21, items 11 + 16: the client's post-hand hold comes from the
// same animation spec the engine derives its own hold from, so the table can
// never clear the winner before the pot has finished travelling to them.
import { handCompletionHoldMs } from '../config/handCompletionSpec';

/** Rank ordering for the preflop label. Ace high; T/J/Q/K above the numbers. */
const RANK_ORDER = (r: string): number =>
  ({
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    T: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  })[String(r).toUpperCase()] ?? 0;

/** "A" -> "Ace", "T" -> "Ten", so the preflop label reads like a poker room. */
const RANK_WORD = (r: string): string =>
  ({
    '2': 'Two',
    '3': 'Three',
    '4': 'Four',
    '5': 'Five',
    '6': 'Six',
    '7': 'Seven',
    '8': 'Eight',
    '9': 'Nine',
    T: 'Ten',
    J: 'Jack',
    Q: 'Queen',
    K: 'King',
    A: 'Ace',
  })[String(r).toUpperCase()] ?? String(r).toUpperCase();
import { normalizeCards, seatPctToViewportPx } from '../utils/tableGeometry';
import { getAnimationSpeed } from '../utils/animationSpeed';
import { ActionErrorToast, ActionErrorData } from '../components/table/ActionErrorToast';
import { TableModalsLayer } from '../components/table/TableModalsLayer';

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT RESULT — what the Session Complete popup shows instead of chips
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read the player's finishing position and winnings for a tournament.
 *
 * Dan 2026-08-20: "tournaments are never displayed by chips, only what place
 * you finished and how much you made."
 *
 * `tournament_players` is the record of record: `position` is the finish,
 * `prize` the payout, `bounty_winnings` / `bounties_collected` the PKO side.
 * Field size comes from the tournament row.
 *
 * Never throws and never blocks the leave: on any failure it returns a result
 * with nulls, so the summary shows "\u2014" for the place rather than falling back
 * to a chip panel that would be actively wrong.
 */
async function fetchTournamentResult(
  tournamentId: string,
  userId: string
): Promise<TournamentResult> {
  const empty: TournamentResult = {
    finishPlace: null,
    entrants: null,
    prize: 0,
    bountyWinnings: 0,
    knockouts: 0,
    rebuys: 0,
    addOns: 0,
    isSpin: false,
  };

  try {
    /* AUDIT 2026-08-20 — entrants is COUNTED, not read off the tournament row.

       `tournaments.current_players` is an entry counter incremented on register
       and decremented only on UNregister; no elimination path touches it. It is
       close to the field size and drifts from it, which is why TournamentClock
       already stopped trusting it ("the clock showed the starting field for the
       whole tournament"). Counting tournament_players is the same source the
       clock uses, so the two agree, and it stays right for re-entry events.
       current_players remains the fallback if the count cannot be read. */
    const [{ data: entry }, { data: tourney }, { count: entryCount }] = await Promise.all([
      supabase
        .from('tournament_players')
        .select('position, prize, bounty_winnings, bounties_collected, rebuys, add_on, status')
        .eq('tournament_id', tournamentId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('tournaments')
        /* variant + tournament_type: the two columns isSpinTournament reads.
           Either one may carry it, which is why the helper checks both and
           nothing here re-derives it. Without them the ranking card branded
           EVERY finished event a Spin. */
        .select('name, current_players, variant, tournament_type')
        .eq('id', tournamentId)
        .maybeSingle(),
      supabase
        .from('tournament_players')
        .select('user_id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId),
    ]);

    return {
      name: tourney?.name || undefined,
      finishPlace: entry?.position ?? null,
      entrants: entryCount ?? tourney?.current_players ?? null,
      prize: Number(entry?.prize) || 0,
      bountyWinnings: Number(entry?.bounty_winnings) || 0,
      knockouts: Number(entry?.bounties_collected) || 0,
      rebuys: Number(entry?.rebuys) || 0,
      // add_on is a count on some rows and a boolean on older ones; both mean
      // "how many add-ons", so coerce rather than trusting the column type.
      addOns:
        typeof entry?.add_on === 'boolean' ? (entry.add_on ? 1 : 0) : Number(entry?.add_on) || 0,
      isSpin: isSpinTournament(tourney as SpinRevealSubject | null),
    };
  } catch (err) {
    reportError(err, 'TablePage.fetchTournamentResult');
    return empty;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CONFIG HELPER — Derives rake config from official chart
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableState {
  tableId: string;
  tableName: string;
  gameType: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'SHORT_DECK' | string;
  blinds: string;
  maxPlayers: 6 | 9;
  pot: number;
  sidePots: SidePot[];
  communityCards: Card[];
  /** DOUBLE-BOARD BOMB POT 2026-08-20: board 2, empty unless active. */
  communityCards2: Card[];
  /** ROUND 3: hands until the next bomb pot (1 = next hand); null = off. */
  bombPotIn: number | null;
  boardStage: BoardStage;
  /**
   * The engine's OWN stage string, unnormalised.
   *
   * `boardStage` is deliberately massaged for the board display: it is clamped
   * so it can never run backwards, and it is derived UPWARD from the
   * community-card count. That is right for drawing the felt, but it erases any
   * stage the board has no concept of. `pineapple_discard` is exactly that case
   * — it happens with three cards already out, so the normaliser rewrote it to
   * 'flop' and the discard phase was invisible to the client. Keep the raw value
   * for anything that needs to know what the engine is actually doing.
   */
  engineStage: string;
  dealerSeat: number;
  currentPlayerSeat: number;
  heroSeat: number;
  players: (SeatPlayer | null)[];
  jackpotAmount: number;
  isHandInProgress: boolean;
  positions: PositionBadge[];
  lastActions: LastAction[];
  lastBetAmounts: number[]; // Per-seat bet amounts for action labels + chip display
  isTournament: boolean;
  tournamentId?: string;
  bountyMap: Record<string, number>; // userId → current bounty value (for KO/PKO display)
  isBountyTournament: boolean;
  spinMultiplier?: number;
  handForHand?: boolean;
  bubbleInfo?: { playersRemaining: number; paidPositions: number };
  lateRegOpen?: boolean;
  currentLevel?: number;
  refreshTrigger?: number;
  // Phase 2 T1-01: winners from the authoritative engine snapshot, with
  // net profit precomputed (winnings - totalInvested). Drives the +N
  // yellow floating text above each winner's seat.
  engineWinners?: Array<{ userId: string; seat: number; amount: number; netAmount: number }>;
  // Bible V8 §4.2 — User IDs of players currently waiting for the BB to
  // rotate. The hero sees a "Post BB to enter" button when their userId
  // is in this list. Walkthrough Step 4 fix 2026-04-29.
  waitingForBBUserIds?: string[];
  // Phase 8: Action timer state
  actionTimerDeadline?: number;
  /** Wall-clock turn start (server-authoritative). Drives the CSS ring
   * animation via SeatSlot turnStartTimeMs/turnDeadlineMs props. */
  actionTimerStartTime?: number;
  actionTimerPlayerId?: string;
  // Phase 8: Session stats
  sessionPL?: number;
  sessionHands?: number;
  // Table settings (from create/Supabase)
  rakePercent?: number;
  rakeCap?: number;
  runItTwice?: boolean;
  // Bible V8 §2.4: Server-authoritative hand state fields
  minRaise?: number;
  lastRaise?: number;
  currentBet?: number;
  actionHistory?: {
    seat: number;
    userId: string;
    action: string;
    amount: number;
    timestamp: number;
    stage: string;
  }[];
  handNumber?: number;
  clubName?: string;
  /** Union the club belongs to, shown beside the club on the felt masthead. */
  unionName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
// SEAT POSITIONS — Fixed percentages for vertical table layout (never move)
// ═══════════════════════════════════════════════════════════════════════════════

// Phase A rebuild (Dan 2026-04-17, VERTICAL FLIP): seats distributed evenly
// around a VERTICAL portrait oval (aspect ~0.65:1, taller than wide) to match
// PokerBros exactly. Hero at bottom-center (seat 1), remaining seats step CCW
// around the perimeter so seat 2 lands at lower-left.
//   Parametric: x = 50 + a*cos(θ), y = 50 + b*sin(θ)   (a=33, b=44 in % of scaler)
// Narrower x radius + taller y radius pins avatars to the portrait rail.
/* ── TABLE SILHOUETTE (Dan 2026-07-28) ─────────────────────────────────────
   The hand-drawn CSS/SVG "egg" is gone. The table is now the SAME black-and-
   gold artwork the Commander /commander/table-tablets page uses, rotated to
   portrait (src/assets/table-vertical-black-gold.png, 341x609, transparent).
   The PNG supplies the rail, bevel and gold hairline; .table-surface is sized
   to the artwork's felt window (left 18.8%, top 10.5%, 63.3% x 79.2%) with
   border-radius: 9999px so the themed felt gradient lands exactly inside it. */

// Arc-length parameterised on the artwork's rail centreline (stadium:
// a = 39.6% of width, b = 44.4% of height), hero at bottom-centre travelling
// counter-clockwise. y values are nudged for .seat-wrapper's translate(-50%,-50%),
// which centres the whole avatar+box stack (~92px) rather than the avatar.
// Dan 2026-08-15: "[the hero] needs to be lower, it's currently positioned too
// high on the table." The hero slot is index 0 (bottom-centre) in both maps and
// is the ONLY slot the rotation ever assigns to hero, so nudging it down here
// moves hero alone and leaves all six villain positions untouched. 91 -> 95.5
// also buys the 1.33x hero avatar the vertical room it needs.

// HORSE AVATARS — Use deterministic SVG generator (no external DiceBear dependency)
// Each horse gets a unique colorful avatar derived from their name
import { generateAvatarSvg } from '../utils/avatarGenerator';
// 2026-08-19: pure card + seat helpers now live in their own modules. They used
// to sit inline in this file; the seat rings in particular carry measured rail
// positions that must not be casually rewritten. See those files for why.
import { ENGINE_SUIT_MAP, sortCardsByRank, getGameVariantLabel } from '../lib/tableCardDisplay';
import {
  seatLayoutFor,
  createEmptySeats,
  rotateSeatsForHero,
  seatPixelMap,
} from '../lib/tableSeatGeometry';
import {
  resolveSkin,
  resolveBackgroundLayers,
  DEFAULT_TABLE_BACKDROP_COLOR,
  TABLE_BACKGROUND_SIZE,
  TABLE_BACKGROUND_POSITION,
  TABLE_BACKGROUND_REPEAT,
} from '../lib/tableTheme';
import { adaptServiceHandToPanel } from '../lib/handHistoryAdapter';
import { useUserStore } from '../stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW-LEVEL LOCKS — TRUE singletons that survive module reloads, lazy-load
// chunk duplication, and React component remounts. Using window.* guarantees
// only ONE game loop exists regardless of how many module instances load.
// ═══════════════════════════════════════════════════════════════════════════════
const _horsesLoadedForTable: Record<string, boolean> = {};
const _win = window as any;

/**
 * Single source of truth for where chip flights land — the pot's visual
 * centre as a percentage of the table scaler.
 *
 * LIVE E2E FIX 2026-08-20: this was {x:49.9, y:33} to mirror `.pot-area`'s
 * base rule (top:32.99%) in TablePage.css. But TableVisualHotfix.css ships
 * `.table-page .pot-area { top: 19% !important }` (Dan 2026-08-17 — pot moved
 * up for clear air above the board), which ALWAYS wins (two-class specificity
 * + !important). So the pot actually renders at 19% and chips aimed at 33
 * landed ~14% of table-height below it. `.pot-area` is a zero-size anchor
 * with translate(-50%,-50%), so its top% IS the pot's centre. Aim there.
 * If either the base rule or the hotfix moves the pot, move this with it.
 */
const POT_ANCHOR_PCT = { x: 49.9, y: 19 };
if (!_win.__pokerLocks) {
  _win.__pokerLocks = {
    handActive: false,
    activeHC: null as any,
    firstHandTriggered: false,
    horsesLoaded: {} as Record<string, boolean>,
    lastHandStartMs: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

// Props for embedded multi-table mode
interface TablePageProps {
  /** When set, overrides the URL :tableId param (used by MultiTablePage) */
  embeddedTableId?: string;
  /** Callback to report table info updates to the multi-table container */
  onTableInfoUpdate?: (info: {
    name?: string;
    stakes?: string;
    isMyTurn?: boolean;
    /** Absolute epoch-ms deadline of the hero's turn (server-authoritative).
     *  The container derives the ticking seconds itself — a snapshot number
     *  here was the bug (it froze at a constant and the urgent auto-switch
     *  could never fire). */
    turnDeadlineMs?: number;
    /** Absolute epoch-ms the hero's turn clock started (server-authoritative).
     *  With the deadline it gives the tab bar a true depleting timer bar —
     *  fraction remaining = (deadline - now) / (deadline - start). */
    turnStartMs?: number;
    pot?: number;
    /**
     * PokerBros parity (Dan 2026-08-20, from live multi-table footage): each
     * tab previews the hero's hole cards AT THAT TABLE. Reported as ONE
     * comma-joined string ("Ah,Qc" / "" when not in a hand or folded) rather
     * than an array on purpose — updateTableInfo in MultiTablePage bails out
     * on shallow !== comparison, and a fresh array identity every snapshot
     * would defeat that and resurrect the P1-2 render-loop bug.
     */
    holeCards?: string;
    /** Hero's last action this street ('fold' | 'check' | 'call' | 'bet' |
     *  'raise' | ...), for the transient badge under the tab. */
    lastAction?: string;
    /** Live Bad Beat Jackpot pool at this table, for the tab bar's JACKPOT
     *  badge (audit 2026-08-20: the badge existed in TableTabBar but nothing
     *  ever passed it — dead wiring since the component was written). */
    jackpot?: number;
    /** Roadmap batch 1 (Dan 2026-08-20): hero folded this hand — the tab
     *  dims so "nothing to do here" reads at a glance. */
    folded?: boolean;
    /** Showdown outcome edge for the tab flash: "win:<hand>" / "loss:<hand>"
     *  ("" = no settled result). Keyed by hand number so consecutive
     *  same-outcome hands still re-flash; a string so the container's
     *  shallow-compare bail-out (P1-2) holds. */
    handResult?: string;
    /** Amount the hero must call right now (0 = check is legal). Only
     *  meaningful while isMyTurn; drives the tile-view action strip. */
    toCall?: number;
    /** Hero's current stack, for the aggregated session view. */
    heroStack?: number;
    /** Hero is sitting out at this table (drives the long-press menu's
     *  Sit Out / I'm Back label and the sit-out-everywhere control). */
    sittingOut?: boolean;
    /** Dan 2026-08-21: the short game code the tab wears when no hand is
     *  live - NLH / PLO5 / SPIN / MTT / HU. Authoritative: this component
     *  knows the variant, the tournament format and the seat count. */
    gameCode?: string;
    /**
     * A TIMED NON-TURN DECISION open at this table, as "kind:absoluteDeadlineMs"
     * ("discard:1787...", "insurance:...", "rit:..."), or '' when there is none.
     * One comma-free STRING so the container's shallow-compare bail-out holds.
     *
     * Dan 2026-08-21: these are the clocks that used to run invisibly on a
     * background table - the modal is mounted inside a display:none subtree, so
     * the deadline passed with nothing on screen and the engine decided for you.
     */
    decision?: string;
    /** Time bank is burning at this table, as "1:absoluteDeadlineMs" or ''. */
    timeBank?: string;
  }) => void;
  /** Whether this table is part of a multi-table session (hides own header if tab bar is shown) */
  isMultiTable?: boolean;
  /**
   * Whether this table is the currently-focused/active one in a multi-table session.
   * Inactive tables suppress most ambient sounds (deal/chip/check/fold/etc.) to
   * prevent audio chaos. Turn alerts and critical events always fire so the player
   * can hear when it's their turn on a background table. Defaults to true so
   * single-table mode (no MultiTablePage wrapper) behaves identically.
   */
  isActive?: boolean;
  /**
   * Roadmap batch 3: per-table mute from the tab's long-press menu. Silences
   * every sound this table makes (ambient, bell, tick-tock) without touching
   * the global sound switch or any other table. Haptics stay - mute is an
   * audio decision.
   */
  muted?: boolean;
}

/**
 * The ticking half of masthead line 2 (Dan 2026-08-20: "Level #, Blinds, and
 * the clock"). Its own component so the 1-second tick re-renders ~40 bytes of
 * DOM instead of the whole table page. Shows mm:ss remaining in the level;
 * clamps at 0:00 while waiting for the engine's level_up broadcast rather than
 * counting negative.
 */
function MastheadLevelClock({
  startedAtMs,
  durationSec,
}: {
  startedAtMs: number;
  durationSec: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, durationSec - Math.floor((now - startedAtMs) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');
  return (
    <span className="table-brand__clock">
      {mm}:{ss}
    </span>
  );
}

export default function TablePage({
  embeddedTableId,
  onTableInfoUpdate,
  isMultiTable = false,
  isActive = true,
  muted = false,
}: TablePageProps = {}) {
  const { tableId: routeTableId } = useParams<{ tableId: string }>();
  const tableId = embeddedTableId || routeTableId;
  const navigate = useNavigate();
  const toast = useToast();

  // ─── MULTI-TABLE SOUND GATE ───
  // In multi-table mode, only the actively-focused tab plays ambient sounds
  // (deal, chips, fold, check, community card, showdown, win celebrations,
  // pot collect, etc.). Turn alerts and player-initiated action sounds always
  // fire so the user knows it's their turn even on a background table and
  // hears feedback for buttons they pressed. Single-table mode (no
  // MultiTablePage wrapper) defaults isActive=true so behavior is unchanged.
  const ambientSoundsAllowed = (!isMultiTable || isActive) && !muted;

  // Prevent Chrome from throttling this tab (keeps horse timers alive)
  useTabKeepAlive();

  // ─── PAGE TITLE ───
  useEffect(() => {
    document.title = tableId ? `${tableId} | Smarter Poker` : 'Table | Smarter Poker';
  }, [tableId]);

  // ─── MOBILE VIEWPORT LOCK — Prevent accidental pinch-zoom during poker play ───
  useEffect(() => {
    let newMeta: HTMLMetaElement | null = null;
    const meta = document.querySelector('meta[name="viewport"]');
    const originalContent = meta?.getAttribute('content') || '';
    const pokerViewport =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

    if (meta) {
      meta.setAttribute('content', pokerViewport);
    } else {
      newMeta = document.createElement('meta');
      newMeta.name = 'viewport';
      newMeta.content = pokerViewport;
      document.head.appendChild(newMeta);
    }

    // Try to lock orientation to portrait (non-blocking, fails silently on unsupported browsers)
    try {
      (screen.orientation as any)?.lock?.('portrait').catch(() => {});
    } catch {
      // Orientation lock not supported — ignore
    }

    return () => {
      // Restore original viewport when leaving the table
      if (newMeta) {
        document.head.removeChild(newMeta);
      } else {
        const restoreMeta = document.querySelector('meta[name="viewport"]');
        if (restoreMeta) {
          restoreMeta.setAttribute(
            'content',
            originalContent || 'width=device-width, initial-scale=1'
          );
        }
      }
      try {
        screen.orientation?.unlock?.();
      } catch {
        // Ignore
      }
    };
  }, []);

  // ─── SCREEN WAKE LOCK — Prevent screen dimming during active poker play ───
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLock) await wakeLock.release().catch(() => {});
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Wake Lock not supported or denied — ignore
      }
    };

    // Reacquire wake lock when tab becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      wakeLock?.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ─── BACKGROUND TAB DETECTION — Pause animations when tab is hidden (saves battery) ───
  useEffect(() => {
    const tablePage = document.querySelector('.table-page');
    if (!tablePage) return;

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        tablePage.classList.add('table-page--backgrounded');
      } else {
        tablePage.classList.remove('table-page--backgrounded');
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      tablePage.classList.remove('table-page--backgrounded');
    };
  }, []);

  // Get current user
  const [userId, setUserId] = useState<string>('guest');

  useEffect(() => {
    if (userId && userId !== 'guest') {
      // CA-412 BUG FIX: A player who sat and played before opening the Challenges tab
      // never got challenges assigned, so progress RPCs zero-matched. Pre-seed here.
      dailyChallengeService.getAllChallenges(userId).catch(() => {});
    }
  }, [userId]);

  // ── Bounty animations (2026-08-20, Dan) ───────────────────────────────────
  // Both are driven by engine broadcasts that already reach EVERY client at
  // the table, so both are shared in real time by construction.
  //
  // The chest additionally needs a client->table message, because the winner
  // TAPS it open and the other nine players must see that same tap. That is
  // `chestChannelRef` below.
  //
  // QUEUED, not a plain useState. A three-way all-in busts two players, the
  // engine processes eliminations one at a time, so two broadcasts land
  // milliseconds apart — a single state slot meant the second overwrote the
  // first and one of the two knockouts was never shown. Two heads taken, one
  // celebration. See src/hooks/useAnimationQueue.ts.
  const knockoutQueue = useAnimationQueue<KnockoutData>();
  const chestQueue = useAnimationQueue<MysteryChestData>();
  const knockout = knockoutQueue.current;
  const mysteryChest = chestQueue.current;
  const [chestRemoteOpened, setChestRemoteOpened] = useState(false);
  // The Spin multiplier draw. Server-decided, shown once per tournament.
  const [spinDraw, setSpinDraw] = useState<SpinWheelData | null>(null);
  const chestChannelRef = useRef<ReturnType<typeof masterBus.getOrCreateChannel> | null>(null);

  /**
   * Tell the rest of the table the winner just tapped the chest open.
   *
   * The winner's own client does NOT wait for this to come back — it opens
   * locally the instant they tap, so their tap feels immediate. This send
   * exists purely so the other seats open at the same moment.
   */
  const broadcastChestOpen = useCallback(() => {
    const chan = chestChannelRef.current;
    if (!chan) return;
    try {
      chan.send({
        type: 'broadcast',
        event: 'mystery_chest_opened',
        payload: { tableId, at: Date.now() },
      });
    } catch (err) {
      // A failed broadcast degrades to each spectator's own failsafe timer.
      // It must never stop the winner from seeing their prize.
      reportError(err, 'TablePage.broadcastChestOpen');
    }
  }, [tableId]);

  // Listen for that tap. Every client subscribes, including the winner's —
  // runOpen() is idempotent, so the echo of their own broadcast is harmless.
  useEffect(() => {
    if (!tableId) return;
    const chan = masterBus.getOrCreateChannel(`mystery-chest-${tableId}`);
    chestChannelRef.current = chan;
    chan.on('broadcast', { event: 'mystery_chest_opened' }, () => {
      setChestRemoteOpened(true);
    });
    if (chan.state !== 'joined') {
      try {
        chan.subscribe();
      } catch (err) {
        reportError(err, 'TablePage.chestChannel.subscribe');
      }
    }
    return () => {
      chestChannelRef.current = null;
      // 2026-08-22: actually release the channel. Nulling the ref alone
      // leaked one subscribed Supabase channel per table mount (x6 in
      // MultiTablePage) for the life of the page.
      try {
        masterBus.removeRegisteredChannel(`mystery-chest-${tableId}`);
      } catch {
        /* best effort */
      }
    };
  }, [tableId]);
  const [username, setUsername] = useState<string>('Player');
  const [heroAvatarUrl, setHeroAvatarUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  // ANIMATION AUDIT 2026-08-19: boardStageKey is GONE. It re-keyed (and so
  // unmounted + remounted) the whole .community-area on every stage change —
  // one frame after CommunityCards had marked the new cards as newly dealt.
  // The fresh instance re-seeded its refs to the current counts, so the flop
  // flip / turn / river reveal classes were never applied and board cards
  // "just appeared". CommunityCards handles its own per-street animation;
  // it must stay mounted to do so.

  // Initialize user on mount
  const isMounted = useIsMounted();

  useEffect(() => {
    async function initUser() {
      const {
        data: { user },
      } = await getAuthUser();
      if (user) {
        if (isMounted.current) setUserId(user.id);
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name, username, avatar_url:arena_avatar_url')
          .eq('id', user.id)
          .maybeSingle();
        if (isMounted.current) {
          setUsername(profile?.display_name || profile?.username || 'Player');
          setHeroAvatarUrl(profile?.avatar_url || '');
        }
      }
      if (isMounted.current) setIsLoading(false);
    }
    initUser();

    // Start Horse Mini-Agent bug reporting system
    horseBugReporter.startCapturing();
    return () => horseBugReporter.stopCapturing();
  }, []);

  /** Safely extract big blind from blinds string (e.g. "1/2" → 2). Never crashes on undefined/null. */
  const safeBB = (blindsStr?: string | null, fallback = 2): number =>
    parseFloat((blindsStr || '?/?').split('/')[1] || String(fallback)) || fallback;

  // WebSocket connection for real-time game state (legacy Supabase Realtime
  // path — still used for presence, chat, and game-state when the feature
  // flag below is off).
  const { isConnected, presence, lastEvent, sendAction, sendChat, updateSeat } = useTableWebSocket(
    tableId || '',
    userId,
    username
  );

  // Phase 1.1 PR-3: authoritative engine WS. Always mounted so the WS
  // connection is warm; the snapshot is only APPLIED to tableState when the
  // feature flag is on. That isolates any behavior change to the flag flip.
  //
  // AUDIT FIX 2026-07-19 (client-3): the client-side authoritative engine was
  // ripped out (PR-5) and the server now publishes ONLY over this WS — there is
  // no legacy fallback. The flag previously DEFAULTED OFF, so any build without
  // the gitignored `.env` setting `VITE_USE_ENGINE_WS=1` (fresh checkout, CI, a
  // new machine) shipped a table that connected to nothing: seats loaded from
  // the DB but no hand state, no timers, no action echo. Default ON now; only an
  // explicit `VITE_USE_ENGINE_WS=0` opts out.
  const USE_ENGINE_WS =
    (import.meta as unknown as { env: Record<string, string | undefined> }).env
      ?.VITE_USE_ENGINE_WS !== '0';
  const {
    snapshot: engineSnapshot,
    status: engineWsStatus,
    lastEvent: engineLastEvent,
    lastError: engineLastError,
  } = useEngineTableState(tableId || undefined, { enabled: USE_ENGINE_WS });
  // Phase 1.2 PR-F: disconnect FSM states per userId, surfaced by the
  // engine WS payload. Drives DisconnectToast below.
  const [disconnectStates, setDisconnectStates] = useState<
    Record<string, import('../utils/mapEngineSnapshot').DisconnectFsmEntry>
  >({});

  // Phase 1.3 PR-C+D: server-side action rejection surfaced as a toast.
  // Set whenever submitAction resolves with success === false. Auto-cleared
  // by the toast component after 4s, or by the user (X button / Snap-to hint).
  const [actionErrorData, setActionErrorData] = useState<ActionErrorData | null>(null);

  // Phase 2 T2-01 (spec §5.6): Fold Protection Dialog. When the player taps
  // Fold while Check is free, we defer the fold and show a confirmation. This
  // state is ONLY the dialog's open flag — the fold itself is committed inside
  // the modal's onFold callback so we don't race two submitActions.
  const [foldProtectOpen, setFoldProtectOpen] = useState(false);

  // State - initialize with empty data (no demo data!)
  const [tableState, setTableState] = useState<TableState>({
    tableId: tableId || '',
    tableName: 'Loading...',
    gameType: 'NLH',
    blinds: '?/?',
    maxPlayers: 6,
    pot: 0,
    sidePots: [],
    communityCards: [],
    communityCards2: [],
    bombPotIn: null,
    boardStage: 'preflop',
    engineStage: 'preflop',
    dealerSeat: 0,
    currentPlayerSeat: 0,
    heroSeat: 0,
    players: createEmptySeats(6),
    jackpotAmount: 0,
    isHandInProgress: false,
    positions: [null, null, null, null, null, null],
    lastActions: [null, null, null, null, null, null],
    lastBetAmounts: [0, 0, 0, 0, 0, 0],
    isTournament: false,
    bountyMap: {},
    isBountyTournament: false,
  });

  // Phase 1.1 PR-3: apply authoritative engine snapshot to tableState when
  // the feature flag is on. This one effect replaces the entire Supabase-
  // Realtime-as-game-state path (which PR-5 deletes). The mapping is pure
  // and idempotent; same snapshot → same patch, so React dedupes renders.
  useEffect(() => {
    if (!USE_ENGINE_WS) return;
    if (!engineSnapshot) return;
    const mapped = mapEngineSnapshot(engineSnapshot, userId, tableState.maxPlayers);
    // Phase 1.2 PR-F: stash disconnect map for the top-level toast
    setDisconnectStates(mapped.disconnectStates);
    setTableState((prev) => {
      // Merge per-seat players carefully: engine provides the full authoritative
      // roster. The SeatPlayer shape the UI wants matches mapped.players[i].
      //
      // CRITICAL (Dan's UX rule, 2026-04-14): when the hero folds, the server
      // scrubs their hole cards from the public broadcast (returns cards=[]).
      // Preserve the hero's previously-delivered cards in local state so the
      // UI can dim them rather than erase them.
      const nextPlayers: (SeatPlayer | null)[] = mapped.players.map((p, i) => {
        if (!p) return null;
        const sp = p as unknown as SeatPlayer;
        if (sp.isHero && (!sp.holeCards || sp.holeCards.length === 0)) {
          const prevHero = prev.players[i];
          if (prevHero && prevHero.isHero && prevHero.holeCards && prevHero.holeCards.length > 0) {
            return { ...sp, holeCards: prevHero.holeCards };
          }
        }
        return sp;
      });
      // ── ANIMATION AUDIT 2026-08-19: board regression guard ──
      // During an all-in runout the engine deals streets via dealNextStreet,
      // and (before the matching server fix) state.stage lagged at 'preflop'
      // while community_cards grew. The snapshot then overwrote the stage the
      // discrete COMMUNITY_CARDS_DEALT event had just set, and the board
      // rendered zero cards (visibleCount is stage-derived). Rules:
      //  1. Within the same hand the board never shrinks.
      //  2. The stage is never behind what the card count proves.
      //  3. Within the same hand the stage never moves backward.
      const STAGE_RANK: Record<string, number> = {
        waiting: -1,
        preflop: 0,
        flop: 1,
        turn: 2,
        river: 3,
        showdown: 4,
      };
      const sameHand = mapped.handNumber > 0 && mapped.handNumber === prev.handNumber;
      let nextCards = mapped.communityCards as Card[];
      if (sameHand && nextCards.length < prev.communityCards.length) {
        nextCards = prev.communityCards;
      }
      // DOUBLE-BOARD BOMB POT 2026-08-20: board 2 follows the same
      // never-shrink-within-a-hand rule as board 1.
      let nextCards2 = (mapped.communityCards2 ?? []) as Card[];
      if (sameHand && nextCards2.length < prev.communityCards2.length) {
        nextCards2 = prev.communityCards2;
      }
      let nextStage = mapped.boardStage as BoardStage;
      const n = nextCards.length;
      const derivedStage = n >= 5 ? 'river' : n === 4 ? 'turn' : n >= 3 ? 'flop' : null;
      if (derivedStage && (STAGE_RANK[nextStage] ?? 0) < (STAGE_RANK[derivedStage] ?? 0)) {
        nextStage = derivedStage as BoardStage;
      }
      if (sameHand && (STAGE_RANK[nextStage] ?? 0) < (STAGE_RANK[prev.boardStage] ?? 0)) {
        nextStage = prev.boardStage;
      }
      // While a seat's chips are mid-collect (cpCollect), a snapshot that
      // zeroes its bet would unmount ChipPhysics and cut the sweep short.
      // Hold the previous amount for the collect window; the sweep's own
      // timer zeroes it when the animation completes.
      const nextBets = mapped.lastBetAmounts.map((amt, i) =>
        collectingChipSeatsRef.current[i] && !(amt > 0) && prev.lastBetAmounts[i] > 0
          ? prev.lastBetAmounts[i]
          : amt
      );
      return {
        ...prev,
        pot: mapped.pot,
        communityCards: nextCards,
        communityCards2: nextCards2,
        bombPotIn: mapped.bombPotIn,
        boardStage: nextStage,
        engineStage: mapped.boardStage,
        dealerSeat: mapped.dealerSeat,
        currentPlayerSeat: mapped.currentPlayerSeat,
        // AUDIT FIX 2026-07-19: the authoritative WS merge dropped handNumber, so
        // the on-table hand number never advanced (froze at the connect-time
        // GAME_START value) and the hand-change effect that drives per-hand
        // stats + the deal animation never re-fired. Carry it through.
        handNumber: mapped.handNumber > 0 ? mapped.handNumber : prev.handNumber,
        players: nextPlayers,
        positions: mapped.positions as PositionBadge[],
        lastActions: mapped.lastActions as LastAction[],
        lastBetAmounts: nextBets,
        currentBet: mapped.currentBet,
        minRaise: mapped.minRaise,
        lastRaise: mapped.lastRaise,
        sidePots: mapped.sidePots.map((sp, i) => ({
          id: `sp_${i}`,
          amount: sp.amount,
          // PotDisplay's SidePot uses eligiblePlayers (player-name strings).
          // Engine gives eligible seat numbers — resolve to names via prev.players.
          eligiblePlayers: sp.eligibleSeats
            .map((seat) => prev.players[seat - 1]?.name)
            .filter((n): n is string => typeof n === 'string'),
        })) as SidePot[],
        actionTimerDeadline: mapped.actionTimerDeadline,
        actionTimerStartTime: mapped.actionTimerStartTime,
        actionTimerPlayerId: mapped.actionTimerPlayerId,
        isHandInProgress:
          mapped.boardStage !== 'waiting' &&
          (mapped.handNumber > 0 || mapped.players.some((p) => p !== null)),
        // Phase 2 T1-01: winners map for +N floating text.
        engineWinners: mapped.winners,
        // Walkthrough Step 4 fix 2026-04-29: waiting-for-BB user IDs.
        waitingForBBUserIds: mapped.waitingForBBUserIds,
      };
    });
  }, [engineSnapshot, USE_ENGINE_WS, userId, tableState.maxPlayers]);

  /**
   * Crazy Pineapple discard.
   *
   * The engine has had the whole path since FIX 120 — a `pineapple_discard`
   * stage, PINEAPPLE_DISCARD_REQUIRED, `performDiscard`, a discard timer and
   * `GameServerAPI.submitDiscard`. The client had none of it: `submitDiscard`
   * had zero call sites anywhere in src/, so on all 103 pineapple tables the
   * timer expired every hand and the engine's fallback threw away each human's
   * LAST card regardless of the flop. Horses meanwhile ran
   * `HorseLogic.decideDiscard` and picked the best card — the bots played the
   * variant correctly and the people never got to play it at all.
   */
  const [pineappleDeadline, setPineappleDeadline] = useState<number | null>(null);
  const heroPineappleCards = useMemo(() => {
    if (tableState.engineStage !== 'pineapple_discard') return null;
    const hero = tableState.players[tableState.heroSeat - 1];
    if (!hero || hero.status === 'folded') return null;
    const cards = (hero.holeCards ?? []).filter(Boolean);
    return cards.length === 3 ? (cards as NonNullable<(typeof cards)[number]>[]) : null;
  }, [tableState.engineStage, tableState.players, tableState.heroSeat]);

  // The engine starts its auto-discard timer the moment the stage opens, so the
  // countdown is anchored to when we first see the stage rather than to a
  // separate broadcast.
  // `actionTimeSeconds` is declared further down this component, so naming it in
  // the dep array would be a temporal-dead-zone error rather than a lint gripe.
  // Same ref pattern the all-in hotkey uses.
  const actionTimeSecondsRef = useRef(15);
  useEffect(() => {
    if (heroPineappleCards) {
      setPineappleDeadline((prev) => prev ?? Date.now() + actionTimeSecondsRef.current * 1000);
    } else {
      setPineappleDeadline(null);
    }
  }, [heroPineappleCards]);

  // Mirror the discard clock into the shared decision channel so the tab strip
  // can show and alarm it on a table the player is not looking at.
  useEffect(() => {
    if (pineappleDeadline) {
      setDecisionDeadline({ kind: 'discard', at: pineappleDeadline });
    } else {
      setDecisionDeadline((prev) => (prev?.kind === 'discard' ? null : prev));
    }
  }, [pineappleDeadline]);

  const handlePineappleDiscard = useCallback(
    async (cardIndex: number): Promise<boolean> => {
      if (!tableId) return false;
      const res = await GameServerAPI.submitDiscard(tableId, cardIndex);
      if (!res?.success) {
        reportError(
          new Error(res?.error || 'submitDiscard rejected by engine'),
          'TablePage.Pineapple_discard_refused'
        );
        return false;
      }
      soundService.playFold();
      return true;
    },
    [tableId]
  );

  /**
   * Keyboard entry into the ActionPanel's raise UI.
   *
   * This replaces `showRaiseSlider`, which was state that nothing rendered.
   * `handleRaise` and `onBetPreset` both set it true, no component ever
   * read it, and it fed `isModalOpen` below — so the documented R / E hotkey and
   * the 1/2/3/4 pot-fraction keys did nothing visible AND disabled F, C and A
   * until the player pressed Escape. Hero could be facing a bet, press the
   * shortcut the UI advertises, and lose every shortcut they had.
   *
   * ActionPanel owns the sizing UI, so the intent is handed to it there.
   */
  const [raiseIntent, setRaiseIntent] = useState<{
    nonce: number;
    open: boolean;
    amount?: number;
  }>({ nonce: 0, open: false });
  const openRaisePanel = useCallback((amount?: number) => {
    setRaiseIntent((prev) => ({ nonce: prev.nonce + 1, open: true, amount }));
  }, []);
  const closeRaisePanel = useCallback(() => {
    setRaiseIntent((prev) => ({ nonce: prev.nonce + 1, open: false }));
  }, []);
  const [actionError, setActionError] = useState<ActionErrorData | null>(null);
  /** FIX 185: Bible V8 §4.15 — Added 'call' (auto_call) distinct from 'callAny' (auto_call_any) */
  const [preAction, setPreAction] = useState<'fold' | 'check' | 'call' | 'callAny' | null>(null);
  // P2-1 FIX: only send a server 'clear' if a pre-action was actually armed
  // before — prevents a junk serverSetPreAction(clear) firing on every mount
  // (preAction starts null).
  const hadPreActionRef = useRef(false);
  /**
   * Dan 2026-08-21 (items 11 + 16): did THIS hand reach a showdown, and how
   * many hands were shown? Drives how long the table holds the finished hand
   * on screen — the same two inputs the engine feeds `handCompletionHoldMs`,
   * so client and engine agree on when the hand is actually over.
   * Set in the SHOWDOWN handler, reset at HAND_STARTED.
   */
  const handShowdownRef = useRef<{ wentToShowdown: boolean; hands: number }>({
    wentToShowdown: false,
    hands: 2,
  });
  /**
   * Dan 2026-08-21 (bug list item 1): the Fold toggle in the pre-action bar
   * renders as "Check/Fold" whenever checking is free, but the effect below
   * mapped it to `auto_fold` either way — so arming the button labelled
   * "Check/Fold" threw away a free check. Record what the bar was actually
   * offering at the moment the player armed it, and map accordingly.
   */
  const preActionCanCheckRef = useRef(false);

  // Deal Animation State — triggers card dealing visual at start of new hand
  const [dealAnimationKey, setDealAnimationKey] = useState(0);
  const prevHandNumberForDealRef = useRef(0);
  // Per-seat deal animation — true for ~600ms after HAND_STARTED so SeatSlot
  // applies seat__cards--dealing class (card slide-in at each seat)
  const [isSeatDealing, setIsSeatDealing] = useState(false);

  // BOMB POT 2026-08-20: true from BOMB_POT_TRIGGERED until the next
  // HAND_STARTED. Drives the magenta "BOMB" pill on every live seat
  // (SeatSlot bombPotAnte) for the duration of the bomb-pot hand.
  const [bombPotActive, setBombPotActive] = useState(false);
  // IMPROVEMENT PASS 2026-08-20: in the reference capture the flop is dealt
  // only AFTER the bomb's explosion finishes — the engine, which skips
  // preflop betting, sends the flop while the bomb is still falling. Hold
  // the board's visual stage at preflop until the overlay's explosion beat
  // (2.15s, scaled), then release — CommunityCards then runs its normal
  // face-down-land-and-fan flop animation, exactly like the reference.
  // Purely presentational: pot, stacks and action state are never held.
  const [bombPotHoldFlop, setBombPotHoldFlop] = useState(false);
  const bombPotHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Delayed seat→pot ante flights for the bomb-pot explosion beat. */
  const bombPotChipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Time Bank State
  const [showTimeBank, setShowTimeBank] = useState(false);
  const [timeBankActive, setTimeBankActive] = useState(false);
  const [timeBanksRemaining, setTimeBanksRemaining] = useState(4);
  /**
   * Dan 2026-08-19, bug list item 6: "pot-push animation to the winner after
   * every hand showing chip amounts, not auto-advancing."
   *
   * Pixel offset from the pot's own centre toward the winning seat. While it is
   * set, PotDisplay slides the whole pot - amount and all - that way and fades,
   * instead of the number simply blinking out of existence when the hand ends.
   * Null between hands.
   */
  const [potCollectTo, setPotCollectTo] = useState<{ dx: number; dy: number } | null>(null);
  // Dan 2026-08-21 (with PokerBros screenshot): "we need to add a moving
  // number, that tells them the pot size they just won, that number is
  // attached to the chips and pot that gets pushed to the player." Each float
  // rides pot -> seat with the chip fan, then rises and fades as "+N" above
  // the winner's avatar.
  const [potWinFloats, setPotWinFloats] = useState<
    Array<{ id: number; fromX: number; fromY: number; toX: number; toY: number; label: string }>
  >([]);
  const potWinFloatIdRef = useRef(0);
  const potWinFloatTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const spawnPotWinFloat = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number, amount: number) => {
      if (!(amount > 0)) return;
      const label =
        '+' + (amount >= 1 ? Math.round(amount).toLocaleString('en-US') : amount.toFixed(2));
      const id = ++potWinFloatIdRef.current;
      setPotWinFloats((prev) => [...prev, { id, fromX, fromY, toX, toY, label }]);
      // Self-clean after the CSS animation (2.2s) has fully played out.
      // REVIEW FIX 2026-08-21: timers tracked so unmount clears them — no
      // setState on a dead page during rapid table hops.
      const timer = setTimeout(() => {
        potWinFloatTimersRef.current.delete(timer);
        setPotWinFloats((prev) => prev.filter((f) => f.id !== id));
      }, 2400 * getAnimationSpeed());
      potWinFloatTimersRef.current.add(timer);
    },
    []
  );
  useEffect(
    () => () => {
      for (const t of potWinFloatTimersRef.current) clearTimeout(t);
      potWinFloatTimersRef.current.clear();
    },
    []
  );
  const potCollectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Dan 2026-08-20: the pot ships in two ORDERED beats — bets sweep into the
   * pot, then the pot travels to the winner. These two timers hold the
   * deferred second beat (chip fan + pot push) so it starts only once the
   * sweep has landed instead of running on top of it. Both are cancelled at
   * the hand boundary and on unmount.
   */
  const potShipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const potPushDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards the diamond charge in handleBuyTimeBank against a double-tap. */
  const buyingTimeBankRef = useRef(false);
  /**
   * Real diamond price of one time-bank extension, read from `feature_pricing`
   * (the same row `fn_purchase_feature` prices from, so the button cannot
   * advertise a number the server will not charge). The TimeBank component
   * used to hard-code 5; the price is whatever `feature_pricing` says.
   * Dan 2026-08-21 (item 3) set it to 5 diamonds per bank; the seed below is
   * only what renders for the ~1 frame before the real row lands.
   */
  const [timeBankDiamondCost, setTimeBankDiamondCost] = useState(5);
  /** Dan 2026-08-21, item 3: the buy-more sheet (1/10/25/100/500 presets). */
  const [showTimeBankStore, setShowTimeBankStore] = useState(false);
  const [diamondBalance, setDiamondBalance] = useState<number | null>(null);
  // Bible V8 §6.2: one bank = 20 seconds, not the 15s decision clock.
  const [timeBankTimeRemaining, setTimeBankTimeRemaining] = useState(20);
  /**
   * Seconds the CURRENT bank granted. The TimeBank panel's progress bar is
   * `timeRemaining / totalTime`, and totalTime used to be the 15s action clock
   * — so a 20s bank rendered a bar 133% wide that only reached 100% after five
   * seconds had already burned. These are two different clocks; keep them apart.
   */
  const [timeBankGrantedSeconds, setTimeBankGrantedSeconds] = useState(20);

  // FIX 126: Cross-tab BroadcastChannel for multi-table time bank warnings
  // Players can have up to 4 tables open simultaneously — warnings must appear on ALL tabs
  const timeBankChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    try {
      const channel = new BroadcastChannel('club-arena-timebank-warnings');
      timeBankChannelRef.current = channel;

      channel.onmessage = (event) => {
        const data = event.data;
        if (!data || !data.type) return;

        if (data.type === 'time_bank_timeout') {
          if (data.showBuyMore) {
            toast.warning(
              `You were auto-${data.timedOutAction === 'check' ? 'checked' : 'folded'} , no time banks remaining. Visit the Diamond Store to purchase more!`,
              2500
            );
          } else {
            toast.info(
              `You were auto-${data.timedOutAction === 'check' ? 'checked' : 'folded'} (time expired)`,
              2500
            );
          }
        } else if (data.type === 'time_bank_low') {
          const usesLeft = data.usesLeft as number;
          if (usesLeft <= 0) {
            toast.warning(
              `That was your last time bank! Visit the Diamond Store to purchase more.`,
              2500
            );
          } else {
            toast.warning(
              `Warning: Only ${usesLeft} time bank${usesLeft === 1 ? '' : 's'} remaining!`,
              2500
            );
          }
        }
      };

      return () => {
        channel.close();
        timeBankChannelRef.current = null;
      };
    } catch (e) {
      reportError(e, 'TablePage.return');
      // BroadcastChannel not supported in this browser — multi-table relay disabled
      return;
    }
  }, [toast]);

  // Bible V8 §4.15: Pre-actions are server-managed — notify server when player sets/clears a pre-action
  useEffect(() => {
    if (tableId) {
      if (preAction) {
        const serverAction =
          preAction === 'fold'
            ? preActionCanCheckRef.current
              ? 'auto_check_fold'
              : 'auto_fold'
            : preAction === 'check'
              ? 'auto_check'
              : preAction === 'call'
                ? 'auto_call' // FIX 185: Bible V8 §4.15 — auto_call (current bet only)
                : 'auto_call_any';
        // Tell server about pre-action so it can auto-execute on player's turn
        hadPreActionRef.current = true;
        // 2026-08-20: `setPreAction` NEVER throws — it resolves
        // `{ success: false }` on a non-OK status, on an unreachable engine, and
        // for a full 30s whenever GameServerAPI's circuit breaker is open. The
        // `.catch` was dead code and the result was discarded, so the bar lit up
        // whether or not the engine had armed anything.
        //
        // Both directions cost the player a hand. A failed SET means they arm
        // "call any", walk away, and get folded on the shot clock instead. A
        // failed CLEAR (below) means they change their mind, the bar goes dark,
        // and the engine still folds the hand they wanted to play — pre-actions
        // are only disposed at hand end, so the whole rest of the hand is
        // exposed.
        void serverSetPreAction(tableId, serverAction).then((res) => {
          if (!res?.success) {
            reportError(
              new Error(res?.error || 'setPreAction rejected by engine'),
              'TablePage.PreAction_set_refused'
            );
            hadPreActionRef.current = false;
            setPreAction(null); // the bar must not claim something the engine has not armed
            toast?.error?.(res?.error || 'Could not arm that pre-action - play it manually.');
          }
        });
        // Also emit to MasterBus for local telemetry
        masterBus.emit('PRE_ACTION_SET', {
          tableId,
          playerId: userId || '',
          action: serverAction,
        });
      } else if (hadPreActionRef.current) {
        // Clear pre-action on server (only if one was previously armed —
        // P2-1: avoids a junk clear request on initial mount when null).
        hadPreActionRef.current = false;
        void serverSetPreAction(tableId, 'clear').then((res) => {
          if (!res?.success) {
            // The engine still holds the old pre-action and WILL execute it.
            // Say so plainly — this is the direction that folds a live hand.
            reportError(
              new Error(res?.error || 'clear pre-action rejected by engine'),
              'TablePage.PreAction_clear_refused'
            );
            hadPreActionRef.current = true;
            toast?.error?.('Could not cancel your pre-action - it may still run this hand.');
          }
        });
      }
    }
  }, [preAction, tableId, userId, toast]);

  // Bible V8 §6.3: Heartbeat every 5 seconds while at the table
  // Server uses this to detect disconnected players and trigger auto-fold/sit-out
  // 2026-08-22: `toast` lives in a ref so the heartbeat effect depends only on
  // (tableId, userId). With `toast` in the dependency array, every toast
  // add/remove re-created the interval, fired an extra immediate heartbeat,
  // and RESET consecutiveMisses/warned — during an outage (when toasts fire
  // most) the 3-miss warning could never accumulate and the "Reconnected"
  // recovery toast was lost.
  const heartbeatToastRef = useRef(toast);
  heartbeatToastRef.current = toast;
  useEffect(() => {
    if (!tableId || !userId) return;
    // 2026-08-20: both `.catch`es here were dead — `sendHeartbeat` resolves
    // `{ success: false }` rather than throwing — and the result was discarded,
    // so heartbeat loss was completely invisible.
    //
    // This is not telemetry. Bible V8 §6.3 heartbeats are what stop
    // DisconnectEngine treating the player as gone: when they stop landing the
    // server auto-folds their hands and eventually forces a sit-out. The player
    // meanwhile sees a perfectly normal table. Tell them.
    let consecutiveMisses = 0;
    let warned = false;
    const beat = async () => {
      const res = await sendHeartbeat(tableId);
      if (res?.success) {
        if (warned) {
          heartbeatToastRef.current?.success?.('Reconnected to the table.');
          warned = false;
        }
        consecutiveMisses = 0;
        return;
      }
      consecutiveMisses += 1;
      // Three misses is 15s of silence — well before the server's own
      // disconnect thresholds, so the warning arrives while it still helps.
      if (consecutiveMisses >= 3 && !warned) {
        warned = true;
        reportError(
          new Error(`heartbeat missed ${consecutiveMisses}x`),
          'TablePage.Heartbeat_lost'
        );
        heartbeatToastRef.current?.error?.(
          'Connection lost - the server may fold for you. Check your connection.'
        );
      }
    };
    void beat();
    const heartbeatInterval = setInterval(() => void beat(), 5000);
    return () => clearInterval(heartbeatInterval);
  }, [tableId, userId]);

  // ── Dan 2026-08-21: "the games can never freeze or die" — last-resort
  // auto-recovery. EngineStateClient now retries forever, but if the socket
  // has been in 'failed' (10+ straight failures) for 20 more seconds while
  // this tab is VISIBLE, something deeper than the network is wedged (dead
  // service worker, poisoned auth token, leaked socket state). A full reload
  // is safe at any moment — the engine is authoritative and the seat
  // restores server-truth on mount — so take it rather than sitting dead.
  // Guarded to once per 2 minutes via sessionStorage so a hard outage cannot
  // reload-loop the browser.
  // 2026-08-22 review: count consecutive 4404 (table not found) closes. The
  // engine returns 4404 for ~2 minutes after every restart while tables
  // rehydrate — that must keep retrying quietly. But a table that answers
  // 4404 over and over is genuinely gone, and reloading the page cannot
  // resurrect it: the old failsafe reload-looped the browser every 2 minutes
  // forever. After 3 consecutive 4404s we suppress the reload failsafe and
  // tell the player once instead.
  const notFoundCountRef = useRef(0);
  const tableClosedToastShownRef = useRef(false);
  useEffect(() => {
    if (!engineLastError) return;
    if (engineLastError.code === 4404) {
      notFoundCountRef.current += 1;
      if (notFoundCountRef.current >= 3 && !tableClosedToastShownRef.current) {
        tableClosedToastShownRef.current = true;
        heartbeatToastRef.current?.info?.('This Table Is No Longer Running');
      }
    } else if (engineLastError.code !== undefined) {
      notFoundCountRef.current = 0;
    }
  }, [engineLastError]);
  useEffect(() => {
    if (engineWsStatus === 'connected') {
      notFoundCountRef.current = 0;
      tableClosedToastShownRef.current = false;
    }
  }, [engineWsStatus]);

  useEffect(() => {
    if (engineWsStatus !== 'failed') return;
    const t = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      // A repeatedly-404ing table is closed, not wedged — a reload cannot
      // help and used to loop the browser every 2 minutes indefinitely.
      if (notFoundCountRef.current >= 3) return;
      const KEY = 'ca_ws_autoreload_at';
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 120_000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
      reportError(
        new Error('engine WS failed >20s - auto-refresh failsafe'),
        'TablePage.wsAutoReload'
      );
      window.location.reload();
    }, 20_000);
    return () => window.clearTimeout(t);
  }, [engineWsStatus]);

  const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);
  const [showBuyInModal, setShowBuyInModal] = useState(false);
  // 2026-04-14 per Dan: bust rebuy flow
  const [bustRebuyOpen, setBustRebuyOpen] = useState(false);
  const [bustWalletBalance, setBustWalletBalance] = useState<number | null>(null);
  const [bustRebuyProcessing, setBustRebuyProcessing] = useState(false);
  // bustPromptFiredRef provided by useTableSession hook
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [showPlayerNotes, setShowPlayerNotes] = useState(false);
  const [selectedPlayerForNotes, setSelectedPlayerForNotes] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [showHandReplay, setShowHandReplay] = useState(false);
  // Dan 2026-08-21: PokerBros-style hand breakdown — opened by the
  // previous-hand card; the animated replay + share live INSIDE it now.
  const [showHandDetail, setShowHandDetail] = useState(false);
  const [lastHandId, setLastHandId] = useState<string | null>(null);
  const [showGameRules, setShowGameRules] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);

  // Hand Reveal (show/muck after winning without showdown)
  const [showHandRevealModal, setShowHandRevealModal] = useState(false);

  /**
   * Dan 2026-08-18: "a user should be able to click on any card in their hand,
   * and when clicked that card or cards always get shown after the hand is
   * over." Indexes of the hero's own hole cards marked for reveal at hand end.
   * Cleared per hand - a pick belongs to the hand it was made in.
   */
  const [shownCardIndexes, setShownCardIndexes] = useState<number[]>([]);

  const handleToggleShowCard = useCallback(
    (cardIndex: number) => {
      setShownCardIndexes((prev) => {
        const next = prev.includes(cardIndex)
          ? prev.filter((i) => i !== cardIndex)
          : [...prev, cardIndex].sort((a, b) => a - b);
        // Fire-and-forget: the engine stores the full selection each time, so
        // an un-click is expressed by sending the smaller list. A failure here
        // costs a reveal, never the hand, so it must not block the UI.
        if (tableId) void setShownCards(tableId, next);
        return next;
      });
    },
    [tableId]
  );
  const [handRevealWinnerId, setHandRevealWinnerId] = useState('');
  const [handRevealWinnerName, setHandRevealWinnerName] = useState('');
  const [handRevealCards, setHandRevealCards] = useState<
    Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>
  >([]);
  const [handRevealHandId, setHandRevealHandId] = useState('');

  const [showSitOut, setShowSitOut] = useState(false);
  const [sitOutNextHand, setSitOutNextHand] = useState(false);
  // HONESTY FIX 2026-08-16: was `sitOutTimeRemaining = 300`, a countdown to a
  // deadline that does not exist. setSitOutTimeRemaining had zero call sites,
  // so it never moved, and SitOutModal warned the player they would be removed
  // from a table they were never at risk of losing. Track when sit-out started
  // instead and report elapsed time.
  const [sitOutSince, setSitOutSince] = useState<number | null>(null);
  // SIT-OUT REVIEW FIX 2026-08-21: authoritative set of seated user ids whose
  // table_seats row says is_sitting_out. The engine snapshot's per-hand flag
  // is (correctly) always false — a sat-out tournament player is a full hand
  // participant — so without this the greyed seat was overwritten to
  // active/folded by the very next snapshot. Fed by the initial seats load
  // and the realtime table_seats subscription; read by the snapshot mapping
  // and the footer bar.
  const sittingOutIdsRef = useRef<Set<string>>(new Set());
  const [showWaitList, setShowWaitList] = useState(false);
  // Stamp the clock off the SERVER's view of the hero's seat, not off any
  // local button press — a player can be put into sit-out by the engine
  // (repeated action timeouts) without ever touching the menu, and the
  // reconnect path re-derives it from the snapshot too.
  const heroIsSittingOut =
    tableState.heroSeat > 0 &&
    tableState.players[tableState.heroSeat - 1]?.status === 'sitting_out';
  useEffect(() => {
    setSitOutSince((prev) => {
      if (heroIsSittingOut) return prev ?? Date.now();
      return null;
    });
  }, [heroIsSittingOut]);

  // showSessionSummary REMOVED (Phase 2 2026-08-22): it was never set true —
  // the Session Complete card is published to SessionSummaryHost at the app
  // root (services/pendingSessionSummary) and renders in the lobby.
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showSessionHUD, setShowSessionHUD] = useState(false);
  const {
    sessionStartRef,
    handsPlayedRef,
    handsWonRef,
    biggestPotRef,
    peakStackRef,
    sessionPLRef,
    totalBuyInRef,
    totalRebuysRef,
    bustPromptFiredRef,
    heroWonCurrentHandRef,
    hadShowdownRef,
    resetSession,
  } = useTableSession(tableId);
  const actionLockRef = useRef(false); // Debounce rapid action button taps (300ms)

  // LIVE E2E FIX 2026-08-15 (first change shipped via the agent-patch
  // pipeline): tick-accurate session peaks. The Session Complete modal used
  // to show "BIGGEST POT 0" (ref never written here) and a stale peak stack
  // (only moved on buy-ins). Track both from the authoritative tableState on
  // every update while the hero is seated; the MasterBus-based tracking in
  // useTableSession stays as a fallback for values these updates miss.
  useEffect(() => {
    if (tableState.heroSeat > 0) {
      if (tableState.pot > biggestPotRef.current) {
        biggestPotRef.current = tableState.pot;
      }
      const heroStack = tableState.players[tableState.heroSeat - 1]?.stack || 0;
      if (heroStack > peakStackRef.current) {
        peakStackRef.current = heroStack;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableState.pot, tableState.players, tableState.heroSeat]);

  // Previous hand tracking for bottom-left HUD card
  const [prevHandResult, setPrevHandResult] = useState<{
    handNumber: number;
    result: number;
    didWin: boolean;
    didFold: boolean;
    handDescription?: string;
  } | null>(null);

  // VPIP count tracking for mini stats card
  /* The pending tournament-exit navigation, so the subscription's cleanup can
     cancel it. See goToLobbyWithResult. */
  const tournamentExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vpipCountRef = useRef(0);
  // Dan 2026-08-15 (Session Stats fix): per-HAND voluntary-action flags.
  // vpipCountRef above is cumulative and cannot answer "did hero VPIP THIS
  // hand", which is what sessionStatsService.recordHand() needs. Set on the
  // hero's own preflop action, cleared when the hand number advances.
  const heroVpipThisHandRef = useRef(false);
  const heroPfrThisHandRef = useRef(false);
  // (triggerChipAnimationRef removed 2026-08-19 — see the note at the old
  // triggerChipAnimation definition site.)
  const [waitListPlayers, setWaitListPlayers] = useState<
    Array<{
      playerId: string;
      playerName: string;
      avatar?: string;
      position: number;
      joinedAt: Date;
    }>
  >([]);

  // Tournament — extracted to useTableTournament hook
  const {
    rebuyProcessing,
    setRebuyProcessing,
    tournamentBreak,
    setTournamentBreak,
    breakChannelRef,
    announcement,
    setAnnouncement,
    showRebuyModal,
    setShowRebuyModal,
    rebuyData,
    setRebuyData,
    addOnPeriod,
    setAddOnPeriod,
    addOnChannelRef,
    bountyChannelRef,
    tournamentWinner,
    setTournamentWinner,
  } = useTableTournament();

  /**
   * Sit out for real.
   *
   * Every entry point used to just call `setShowSitOut(true)`: the modal opened
   * saying "You are sitting out" and started its away timer, but nothing was
   * ever told to the server. The player stayed live, kept getting dealt in, and
   * blinded off while a modal assured them they were away.
   *
   * `GameServerAPI.setSitOut` never throws — it resolves `{ success: false }` —
   * so the result has to be inspected, not caught.
   */
  const handleSitOut = useCallback(async () => {
    if (!tableId) return;
    const res = await setSitOut(tableId, true);
    if (res?.success) {
      setSitOutSince(Date.now());
      setShowSitOut(true);
    } else {
      toast?.error?.(res?.error || 'Could not sit out - you are still in the game');
    }
  }, [tableId, toast]);

  // ─── Table Menu Actions ────────────────────────────────────────────────
  useMasterBusSubscription('TABLE_MENU_ACTION', (event) => {
    if (event.tableId !== tableId) return;

    switch (event.action) {
      case 'SIT_OUT':
        void handleSitOut();
        break;
      case 'REBUY':
        if (tableState.isTournament) {
          handleTournamentRebuy();
        } else {
          setShowCashier(true);
        }
        break;
      case 'LEADERBOARD':
        setShowLeaderboard(true);
        break;
      case 'SESSION_STATS':
        setShowSessionStats(true);
        break;
      case 'SETTINGS':
        masterBus.emit('TABLE_SETTINGS_OPEN', { tableId: tableId || '' });
        break;
      case 'HAND_HISTORY':
        setShowHandReplay(true);
        break;
      case 'HELP':
        setShowGameRules(true);
        break;
      case 'ADD_ON':
        handleTournamentAddOn();
        break;
      case 'LEAVE_TABLE':
        setShowLeaveConfirm(true);
        break;
      case 'FORCE_LEAVE_TABLE':
        handleForceLeaveTable();
        break;
      case 'CHANGE_AVATAR':
        // Open the Hub avatar selector in a new window
        avatarService.openAvatarSelector();
        break;
      case 'TOGGLE_ALIAS':
        // Instead of hard-toggling, open the new Identity Settings Modal
        setShowIdentityModal(true);
        break;
    }
  });

  // Buy-in processing lock to prevent double-click
  const buyInProcessingRef = useRef(false);
  // FIX 132: Persistent hero seat ref — set IMMEDIATELY on buy-in, never stale
  // Prevents race condition where tableState.heroSeat is 0 during DB query but user tries to sit again
  const heroSeatRef = useRef(0);

  // ── Tournament masthead data (Dan 2026-08-20, from a seat at a live table:
  //    "1st line Date, (game type) Poker Spins, Club Name, Union Name. 2nd
  //    line Level #, Blinds, and the clock. 3rd line hand number.") ──
  // Which tournament family this table belongs to — drives the format word on
  // masthead line 1. null = cash table, which keeps its own layout.
  const [tournamentFormat, setTournamentFormat] = useState<'spin' | 'sng' | 'mtt' | null>(null);
  /**
   * SEAT-FIRST (Dan 2026-08-21): "A PLAYER SITS DOWN AT A TABLE AND BUYS INTO
   * THE SPIN OR HEADS UP, LIKE A CASH GAME." When this table is a Spin or a
   * Heads-Up whose game has not started yet, an empty seat is BOUGHT, not
   * bought-into with a cash range: one price, one tap, atomic via
   * fn_take_seat_and_buy_in. Null means the ordinary cash buy-in modal.
   */
  const [seatFirstBuyIn, setSeatFirstBuyIn] = useState<{
    cost: number;
    seats: number;
    label: string;
  } | null>(null);
  const [seatFirstPending, setSeatFirstPending] = useState(false);
  // The running level countdown. Kept OUT of tableState on purpose: the clock
  // ticks every second, and a per-second re-render belongs in the tiny
  // MastheadLevelClock component, not in a 9,000-line page.
  const [levelClock, setLevelClock] = useState<{
    startedAtMs: number;
    durationSec: number;
  } | null>(null);
  // Blind structure kept for level_up events, whose payload names the new
  // level but not its duration.
  const blindStructRef = useRef<
    Array<{
      level?: number;
      duration?: number;
      duration_minutes?: number;
      durationMinutes?: number;
    }>
  >([]);

  // ─── MEASURED TABLE SCALER ────────────────────────────────────────────────
  // Dan 2026-07-28: bet-chip travel used to be computed with two magic numbers
  // (dx * 0.66, dy * 1.02) derived from the OLD landscape scaler, which was
  // ~300x462. The table is now portrait at a 341:609 aspect, so the vertical
  // constant was ~19% short and chips drifted off the line between the seat
  // and the pot. Measuring the real element removes the constants entirely and
  // keeps "chips rest close to the player who bet" true through any future
  // reshape of the table artwork.
  const tableScalerRef = useRef<HTMLDivElement | null>(null);
  const [scalerSize, setScalerSize] = useState<{ w: number; h: number }>({ w: 320, h: 571 });

  useEffect(() => {
    const el = tableScalerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width <= 0 || r.height <= 0) return;
      setScalerSize((prev) =>
        // Only re-render on a real change; ResizeObserver fires on sub-pixel noise.
        Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: r.width, h: r.height }
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Actual club_id from the table record (NOT the tableId)
  const actualClubIdRef = useRef<string>('');
  const [actualClubIdLoaded, setActualClubIdLoaded] = useState(false); // Tracks when club_id is available
  const [actionTimeSeconds, setActionTimeSeconds] = useState(15);
  useEffect(() => {
    actionTimeSecondsRef.current = actionTimeSeconds;
  }, [actionTimeSeconds]);

  // Chat — extracted to useTableChat hook
  // VISIBLE FIX 2026-08-15: throws are broadcast over chat, but useTableChat
  // is declared before useTableAnimations. Bridge them through a ref so an
  // incoming throw reaches the animation layer instead of being dropped.
  const receiveThrowRef = useRef<
    ((fromSeat: number, toSeat: number, throwableId: string) => void) | null
  >(null);
  const {
    chatMessages,
    setChatMessages,
    isChatCollapsed,
    setIsChatCollapsed,
    isChatMuted,
    setIsChatMuted,
    handleSendChatMessage,
    activeReactions,
    parseIncomingMessage,
    unreadCount,
    clearUnread,
  } = useTableChat(tableId, userId, tableState.players, (fromSeat, toSeat, throwableId) =>
    receiveThrowRef.current?.(fromSeat, toSeat, throwableId)
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Observer chat permission — Admin/Owner roles can chat even when observing
  // Union Owners/Admins, Club Owners/Admins, Super Agents, and smarter.poker Admins
  // can send messages even if they are NOT seated at the table.
  // Regular observers CANNOT post.
  // ═══════════════════════════════════════════════════════════════════════
  const [canChatAsObserver, setCanChatAsObserver] = useState(false);
  useEffect(() => {
    if (!userId || userId === 'guest') return;
    const isSeated = tableState.heroSeat > 0;
    if (isSeated) {
      setCanChatAsObserver(true); // Seated players can always chat
      return;
    }
    // Check if observer has admin/owner role in this club or union
    const checkObserverChatPermission = async () => {
      try {
        const clubId = actualClubIdRef.current;
        if (!clubId) {
          setCanChatAsObserver(false);
          return;
        }
        // Check club membership role
        const { data: membership } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', clubId)
          .eq('user_id', userId)
          .maybeSingle();

        if (membership) {
          const role = membership.role?.toLowerCase() || '';
          // Club Owner, Club Admin, Super Agent can chat as observer
          if (['owner', 'co_owner', 'admin', 'super_agent'].includes(role)) {
            setCanChatAsObserver(true);
            return;
          }
        }

        // Check union-level role (union_owners, union_admins)
        const { data: club } = await supabase
          .from('clubs')
          .select('union_id')
          .eq('id', clubId)
          .maybeSingle();

        if (club?.union_id) {
          // Union owner lives on unions.owner_id; union staff live in union_admins.
          const [{ data: unionRow }, { data: unionAdmin }] = await Promise.all([
            supabase.from('unions').select('owner_id').eq('id', club.union_id).maybeSingle(),
            supabase
              .from('union_admins')
              .select('role')
              .eq('union_id', club.union_id)
              .eq('user_id', userId)
              .maybeSingle(),
          ]);

          const unionRole = unionAdmin?.role?.toLowerCase() || '';
          if (unionRow?.owner_id === userId || ['owner', 'co_owner', 'admin'].includes(unionRole)) {
            setCanChatAsObserver(true);
            return;
          }
        }

        // Check smarter.poker admin status
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', userId)
          .maybeSingle();

        if (profile?.is_admin) {
          setCanChatAsObserver(true);
          return;
        }

        setCanChatAsObserver(false);
      } catch (err) {
        console.warn('[TablePage] Observer chat permission check failed:', err);
        setCanChatAsObserver(false);
      }
    };
    checkObserverChatPermission();
  }, [userId, tableState.heroSeat, actualClubIdLoaded]);

  // Reaction picker state
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);

  // Insurance Modal state
  /**
   * Dan 2026-08-21: "IF YOU ARE PLAYING MULTIPLE TABLES AT ONCE, ALL CLOCKS,
   * COUNTDOWNS AND WARNINGS NEED TO STILL BE WORKING ALL AT THE SAME TIME."
   *
   * Every timed decision now records an ABSOLUTE deadline the moment it opens,
   * so the multi-table strip can run its own clock for a table the player is
   * not looking at. Before this the insurance modal did not even track its own
   * timeout (the engine sends timeoutSeconds and the client dropped it), so a
   * background table's offer expired with nothing on screen anywhere.
   */
  const [decisionDeadline, setDecisionDeadline] = useState<{
    kind: 'insurance' | 'rit' | 'discard';
    at: number;
  } | null>(null);
  const [showInsurance, setShowInsurance] = useState(false);
  const [insuranceOffer, setInsuranceOffer] = useState<InsuranceOffer | null>(null);

  // Run It Twice state — FIX 96: 2-phase flow with chooser model
  const [showRIT, setShowRIT] = useState(false);
  // A closed modal has no clock. Without this the strip would keep alarming a
  // decision the player already answered.
  useEffect(() => {
    setDecisionDeadline((prev) => {
      if (!prev) return prev;
      if (prev.kind === 'insurance' && !showInsurance) return null;
      if (prev.kind === 'rit' && !showRIT) return null;
      return prev;
    });
  }, [showInsurance, showRIT]);
  // rit_result payload for the boards/payout overlay (2026-08-18) — the
  // handler used to discard the event, so nobody ever saw the extra boards.
  const [ritResult, setRitResult] = useState<
    import('../components/table/RunItTwice').RitResultData | null
  >(null);
  const ritResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ritTimer, setRitTimer] = useState(10);
  const [ritOpponent, setRitOpponent] = useState('Opponent');
  const [ritIsChooser, setRitIsChooser] = useState(false);
  const [ritChosenRuns, setRitChosenRuns] = useState<2 | 3>(2);
  const [ritMaxRuns, setRitMaxRuns] = useState<2 | 3>(2);
  const [ritPlayerCount, setRitPlayerCount] = useState(2);

  // Winner state — tracks winning players, hand names, amounts for highlighting + hand history
  const [winnerInfo, setWinnerInfo] = useState<{
    playerIds: string[];
    handName: string;
    cardIndices: number[];
    amounts: Record<string, number>;
    /** Round 2 (double board): winning hand name per board — [top, bottom]. */
    boardHandNames?: [string, string] | null;
  }>({
    playerIds: [],
    handName: '',
    cardIndices: [],
    amounts: {},
    boardHandNames: null,
  });
  /** Mirror of winnerInfo for the WS event handlers, which close over stale
   *  state. Read by the Share Hand snapshot at HAND_COMPLETE. */
  const winnerInfoRef = useRef(winnerInfo);
  winnerInfoRef.current = winnerInfo;

  // Bible V8 §5.1: Winner particle burst emanating from winner's seat position
  const [winnerParticle, setWinnerParticle] = useState<{
    active: boolean;
    origin: { x: number; y: number };
    intensity: number;
  }>({ active: false, origin: { x: 0, y: 0 }, intensity: 1 });

  // ─── Multi-table info reporting ─────────────────────────────────────
  // When embedded in MultiTablePage, report table name/pot/turn status
  //
  // PokerBros parity (Dan 2026-08-20): the tab bar previews the hero's hole
  // cards per table. Derived as a STRING memo so the reporting effect only
  // re-fires when the cards actually change — tableState.players gets a new
  // identity on every engine snapshot, and depending on it directly would
  // re-run the effect (and updateTableInfo's compare loop) many times a hand.
  const heroTabCards = useMemo(() => {
    const hero = tableState.players[tableState.heroSeat - 1];
    if (!hero || !tableState.isHandInProgress || hero.status === 'folded') return '';
    return (hero.holeCards ?? [])
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => `${c.rank}${c.suit}`)
      .join(',');
  }, [tableState.players, tableState.heroSeat, tableState.isHandInProgress]);

  // Hero's last action this street, for the transient badge under the tab.
  // Same memo-to-primitive pattern as heroTabCards, same reason.
  const heroTabLastAction = useMemo(() => {
    const a = tableState.lastActions?.[tableState.heroSeat - 1];
    return typeof a === 'string' ? a : '';
  }, [tableState.lastActions, tableState.heroSeat]);

  // Roadmap batch 1 (Dan 2026-08-20): folded state for tab dimming.
  const heroTabFolded = useMemo(() => {
    const hero = tableState.players[tableState.heroSeat - 1];
    return !!hero && tableState.isHandInProgress && hero.status === 'folded';
  }, [tableState.players, tableState.heroSeat, tableState.isHandInProgress]);

  // Primitive memos (same pattern/reason as heroTabCards): the effect below
  // must not depend on array identities that change every snapshot.
  const heroTabStack = useMemo(
    () => tableState.players[tableState.heroSeat - 1]?.stack,
    [tableState.players, tableState.heroSeat]
  );
  const heroTabToCall = useMemo(
    () =>
      Math.max(
        0,
        (tableState.currentBet || 0) - (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0)
      ),
    [tableState.currentBet, tableState.lastBetAmounts, tableState.heroSeat]
  );

  /** Dan 2026-08-21: the tab's game label. Primitive memo, same reason as
   *  every other reported value - the effect below must not re-fire on an
   *  array identity that changes each snapshot. */
  const heroTabGameCode = useMemo(
    () =>
      gameCode({
        variant: tableState.gameType,
        isTournament: tableState.isTournament,
        tournamentFormat,
        maxPlayers: tableState.maxPlayers,
      }),
    [tableState.gameType, tableState.isTournament, tournamentFormat, tableState.maxPlayers]
  );

  /** "kind:deadline" or '' - see the prop doc. Primitive so the reporting
   *  effect only fires when the decision actually changes. */
  const heroTabDecision = useMemo(
    () => (decisionDeadline ? `${decisionDeadline.kind}:${decisionDeadline.at}` : ''),
    [decisionDeadline]
  );

  /** Time bank as "1:deadline". timeBankTimeRemaining ticks every second, so
   *  the deadline is derived once per activation rather than per tick. */
  const timeBankDeadlineRef = useRef<number | null>(null);
  if (timeBankActive && timeBankDeadlineRef.current === null) {
    timeBankDeadlineRef.current = Date.now() + Math.max(0, timeBankTimeRemaining) * 1000;
  } else if (!timeBankActive && timeBankDeadlineRef.current !== null) {
    timeBankDeadlineRef.current = null;
  }
  const heroTabTimeBank =
    timeBankActive && timeBankDeadlineRef.current ? `1:${timeBankDeadlineRef.current}` : '';

  const heroTabSittingOut = useMemo(() => {
    const hero = tableState.players[tableState.heroSeat - 1];
    return !!hero && hero.status === 'sitting_out';
  }, [tableState.players, tableState.heroSeat]);

  // Win/loss edge for the tab showdown flash. engineWinners only carries a
  // value while the engine is settling a hand, so this collapses back to ''
  // between hands; the hand number key makes back-to-back same outcomes
  // distinct edges.
  const heroTabResult = useMemo(() => {
    const winners = tableState.engineWinners;
    if (!winners || winners.length === 0 || !userId) return '';
    const hero = tableState.players[tableState.heroSeat - 1];
    if (!hero || hero.status === 'sitting_out') return '';
    const won = winners.some((w) => w.userId === userId);
    return `${won ? 'win' : 'loss'}:${tableState.handNumber ?? 0}`;
  }, [
    tableState.engineWinners,
    tableState.players,
    tableState.heroSeat,
    tableState.handNumber,
    userId,
  ]);

  useEffect(() => {
    if (!onTableInfoUpdate) return;
    const isHeroTurn =
      tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;
    onTableInfoUpdate({
      name:
        tableState.tableName !== 'Loading...' && tableState.gameType && tableState.blinds
          ? `${tableState.gameType} ${tableState.blinds}`
          : undefined,
      stakes: tableState.blinds && tableState.blinds !== '?/?' ? tableState.blinds : undefined,
      isMyTurn: isHeroTurn,
      // MULTI-TABLE FIX (2026-08-15): report the server-authoritative absolute
      // deadline. The previous hardcoded `timeRemaining: 15` froze the tab
      // countdown and made the container's urgent auto-switch (< 5s) dead code.
      turnDeadlineMs: isHeroTurn ? tableState.actionTimerDeadline : undefined,
      turnStartMs: isHeroTurn ? tableState.actionTimerStartTime : undefined,
      pot: tableState.pot,
      holeCards: heroTabCards,
      lastAction: heroTabLastAction,
      folded: heroTabFolded,
      handResult: heroTabResult,
      toCall: isHeroTurn ? heroTabToCall : undefined,
      heroStack: heroTabStack,
      sittingOut: heroTabSittingOut,
      gameCode: heroTabGameCode,
      decision: heroTabDecision,
      timeBank: heroTabTimeBank,
    });
  }, [
    tableState.tableName,
    tableState.gameType,
    tableState.blinds,
    tableState.pot,
    tableState.currentPlayerSeat,
    tableState.heroSeat,
    tableState.isHandInProgress,
    tableState.actionTimerDeadline,
    tableState.actionTimerStartTime,
    heroTabToCall,
    heroTabStack,
    heroTabSittingOut,
    heroTabGameCode,
    heroTabDecision,
    heroTabTimeBank,
    heroTabCards,
    heroTabLastAction,
    heroTabFolded,
    heroTabResult,
    onTableInfoUpdate,
  ]);

  // Bad Beat Jackpot state
  const [showBBJ, setShowBBJ] = useState(false);
  const [bbjAmount, setBbjAmount] = useState(0);

  // Audit 2026-08-20: feed the live BBJ pool to the multi-table tab bar. A
  // separate effect (not folded into the main reporting effect above) because
  // bbjAmount is declared here, after that effect's deps close over their
  // values — and the pool moves on its own realtime cadence anyway.
  // Roadmap batch 1: trailing 2s debounce — the pool ticks after every hand
  // at every table, and each report re-renders the whole tab strip.
  useEffect(() => {
    if (!onTableInfoUpdate || bbjAmount <= 0) return;
    const t = setTimeout(() => onTableInfoUpdate({ jackpot: bbjAmount }), 2000);
    return () => clearTimeout(t);
  }, [bbjAmount, onTableInfoUpdate]);

  // Resolved pool id — the last-5-jackpots modal reads its history from this.
  const [bbjPoolId, setBbjPoolId] = useState<string | null>(null);
  // Pinned once per table session so the felt masthead does not silently
  // re-date itself on every render (2026-08-18).
  const tableSessionDate = useMemo(() => new Date(), []);

  // FIX 128: BBJ Celebration overlay state — triggered by server bbj_hit + bbj_payout_complete events
  const [showBBJCelebration, setShowBBJCelebration] = useState(false);
  const bbjHitDataRef = useRef<{
    loserUserId: string;
    loserHandName: string;
    winnerUserId: string;
    winnerHandName: string;
    qualifyingHandLabel: string;
  } | null>(null);
  const [bbjCelebrationData, setBbjCelebrationData] = useState<{
    totalPayout: number;
    loser: { userId: string; username: string; share: number; handName: string };
    winner: { userId: string; username: string; share: number; handName: string };
    tableShare: number;
    perPlayerShare: number;
    tablePlayerCount: number;
    qualifyingLabel: string;
    heroShare: number;
  } | null>(null);
  // BBJ-FLOAT 2026-08-18: per-seat gold "BBJ +$X" floats, keyed by userId.
  // Set alongside the celebration, cleared 4.5s later.
  const [bbjSeatCredits, setBbjSeatCredits] = useState<Record<string, number>>({});
  const bbjSeatCreditsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Q3: Auto-set "Playing At" status for friends to see
  useEffect(() => {
    if (
      tableState.tableName !== 'Loading...' &&
      tableState.heroSeat > 0 &&
      userId &&
      userId !== 'guest' &&
      tableId
    ) {
      playerStatusService.setPlayingAt(
        userId,
        `${tableState.gameType} ${tableState.blinds}`,
        tableId
      );
    }
  }, [
    tableState.tableName,
    tableState.heroSeat,
    tableState.gameType,
    tableState.blinds,
    userId,
    tableId,
  ]);

  // Handle insurance offer — Bible V8 §4.19: Use HTTP POST /insurance endpoint
  // Server's InsuranceEngine calculates premium via Monte Carlo simulation (not hardcoded 10%)
  // coverageAmount param accepted for InsuranceModal compatibility but ignored — server is authoritative
  // FIX 89: Insurance accept with server-authoritative coverage percentage
  const handleInsuranceAccept = async (coverageAmount?: number) => {
    setShowInsurance(false);
    if (tableId) {
      // coverageAmount from slider maps to coveragePercent on server
      // If not provided, defaults to 100% (full insurance)
      const coveragePct =
        coverageAmount && insuranceOffer
          ? Math.round((coverageAmount / insuranceOffer.maxCoverage) * 100)
          : 100;
      const result = await respondToInsurance(tableId, 'accept', coveragePct);
      if (!result.success) {
        reportError(result.error, 'TablePage.Accept_failed');
      }
    }
  };

  // FIX 89: "Decline Now" — may be re-offered on later streets if equity shifts
  const handleInsuranceDecline = async () => {
    setShowInsurance(false);
    if (tableId) {
      const result = await respondToInsurance(tableId, 'decline', 100, false);
      if (!result.success) {
        reportError(result.error, 'TablePage.Decline_failed');
      }
    }
    // After insurance decision, show RIT prompt if set up
    if (ritOpponent !== 'Opponent') {
      setShowRIT(true);
    }
  };

  // FIX 89: "Decline for Hand" — never re-offered on later streets.
  // Per-street pause continues only for the player who is "ahead" (highest equity).
  // If all players decline for hand, remaining streets run out instantly.
  const handleInsuranceDeclineForHand = async () => {
    setShowInsurance(false);
    if (tableId) {
      const result = await respondToInsurance(tableId, 'decline', 100, true);
      if (!result.success) {
        reportError(result.error, 'TablePage.Decline_for_hand_failed');
      }
    }
    if (ritOpponent !== 'Opponent') {
      setShowRIT(true);
    }
  };

  // Insurance auto-decline timeout — prevents hand from stalling if player AFK
  const insuranceTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (showInsurance) {
      // Auto-decline after 15 seconds
      insuranceTimeoutRef.current = workerTimeout(() => {
        if (!isMounted.current) return;
        console.debug('[Insurance] Auto-declined after 15s timeout');
        handleInsuranceDecline();
      }, 15000);
    } else {
      // Cancel the timer when insurance is dismissed (user acted)
      if (insuranceTimeoutRef.current !== null) {
        cancelWorkerTimeout(insuranceTimeoutRef.current);
        insuranceTimeoutRef.current = null;
      }
    }
    // Cleanup on unmount — prevents setState on unmounted component
    return () => {
      if (insuranceTimeoutRef.current !== null) {
        cancelWorkerTimeout(insuranceTimeoutRef.current);
        insuranceTimeoutRef.current = null;
      }
    };
  }, [showInsurance]);

  // FIX 96: Run It Twice handlers — Bible V8 §4.20 + Dan's rules
  // 2-phase flow: Chooser picks runs (1/2/3), others accept/decline
  const handleRITChooserDecide = async (runs: 1 | 2 | 3) => {
    setShowRIT(false);
    if (tableId) {
      const result = await respondToRIT(tableId, { runs });
      if (!result.success) {
        reportError(result.error, 'TablePage.Chooser_decide_failed');
      }
    }
  };

  const handleRITAccept = async () => {
    setShowRIT(false);
    if (tableId) {
      const result = await respondToRIT(tableId, { response: 'accept' });
      if (!result.success) {
        reportError(result.error, 'TablePage.Accept_failed');
      }
    }
  };

  const handleRITDecline = async () => {
    setShowRIT(false);
    if (tableId) {
      const result = await respondToRIT(tableId, { response: 'decline' });
      if (!result.success) {
        reportError(result.error, 'TablePage.Decline_failed');
      }
    }
  };

  // Animations — extracted to useTableAnimations hook
  const {
    showThrowableSelector,
    setShowThrowableSelector,
    throwTargetSeat,
    setThrowTargetSeat,
    activeThrows,
    handleThrowableSelect,
    handleThrowComplete,
    receiveThrow,
    chipAnimations,
    setChipAnimations,
    showConfetti,
    setShowConfetti,
  } = useTableAnimations(tableId, userId, tableState.heroSeat);
  receiveThrowRef.current = receiveThrow;

  // ─────────────────────────────────────────────────────────────────
  // INSTANT SEATING (Dan 2026-08-15, verbatim: "the player needs to be shown
  // 'sitting' as soon as they hit the sit button, then they choose how many
  // chips they want; as soon as they confirm the chips need to appear in
  // their seat").
  //
  // Previously the seat stayed visually empty through TWO sequential network
  // round-trips — a duplicate-seat SELECT and the atomic_table_buyin RPC —
  // and only painted after both resolved. That is the "very long delay", and
  // on a slow link it read as a silent failure, which is why tapping Sit
  // again appeared to do nothing (the re-entrancy guards were working
  // correctly; there was simply no feedback that anything had started).
  //
  // pendingSeat is deliberately NOT merged into tableState.players: the
  // realtime seat feed and the snapshot reconciler both rewrite that array
  // wholesale and would wipe an optimistic entry mid-flight. Holding it in
  // its own state lets the placeholder survive until real data replaces it.
  // ─────────────────────────────────────────────────────────────────
  const [pendingSeat, setPendingSeat] = useState<number | null>(null);
  /**
   * Dan 2026-08-18: the stack the hero just bought in for. Between "buy-in
   * confirmed" and "dealt into a hand" the engine's players array does not
   * contain the hero yet, so without this the seat rendered EMPTY and the
   * player watched their own chair sit vacant.
   */
  const pendingSeatStackRef = useRef<number>(0);

  // ─────────────────────────────────────────────────────────────────
  // Bible V8 §1.16 Real-Time Law — chip-to-pot collection animation.
  // When the engine emits COMMUNITY_CARDS_DEALT or HAND_COMPLETE, every
  // seat with a non-zero bet enters a ~450ms "collecting" state during
  // which ChipPhysics plays cpCollect (scale → 0, translate toward pot,
  // fade out). After the animation completes we clear lastBetAmounts.
  // Using a separate state (not tableState) keeps snapshot sync clean.
  // ─────────────────────────────────────────────────────────────────
  const [collectingChipSeats, setCollectingChipSeats] = useState<boolean[]>(() =>
    Array(9).fill(false)
  );
  const collectSeatsTimerRef = useRef<number | null>(null);
  // ANIMATION AUDIT 2026-08-19: mirror of collectingChipSeats readable inside
  // the snapshot-merge effect. A snapshot arriving mid-collect used to zero
  // lastBetAmounts, which unmounted ChipPhysics and killed the cpCollect
  // sweep mid-flight — chips teleported instead of flying to the pot.
  const collectingChipSeatsRef = useRef<boolean[]>(Array(9).fill(false));
  /**
   * AUDIT-2 FIX 2026-08-20: the mirror used to be assigned in a useEffect,
   * which runs AFTER the snapshot-merge effect in the same commit — so a
   * snapshot batched with setCollectingChipSeats read a stale `false`, zeroed
   * lastBetAmounts, unmounted ChipPhysics and killed cpCollect mid-flight:
   * exactly the bug the ref exists to prevent. Every writer now goes through
   * this setter, which updates the ref SYNCHRONOUSLY before React schedules
   * the render.
   */
  const applyCollectingChipSeats = useCallback((mask: boolean[]) => {
    collectingChipSeatsRef.current = mask;
    setCollectingChipSeats(mask);
  }, []);
  // ANIMATION AUDIT 2026-08-19: per-seat bets recorded from the discrete
  // PLAYER_ACTION / BLINDS_POSTED events. The chips-to-pot sweep used to
  // build its mask from tableStateRef.lastBetAmounts, but the engine's
  // snapshot (applied synchronously, before the deferred event handler runs)
  // zeroes those on every new street — so the sweep usually never fired.
  // This ref survives the snapshot and is cleared only when the sweep runs.
  const streetBetsRef = useRef<number[]>(Array(9).fill(0));
  // ANIMATION AUDIT 2026-08-19: showdown losers' cards fly to the muck
  // instead of blinking out of existence at the 3s reset.
  const [muckingSeats, setMuckingSeats] = useState<boolean[]>(() => Array(9).fill(false));
  const muckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (muckTimerRef.current) clearTimeout(muckTimerRef.current);
    },
    []
  );
  // Cancel the pending chip-collect timer if the component unmounts so we
  // don't invoke setState after unmount (React warning + stale clear).
  useEffect(
    () => () => {
      if (collectSeatsTimerRef.current) {
        window.clearTimeout(collectSeatsTimerRef.current);
        collectSeatsTimerRef.current = null;
      }
    },
    []
  );
  // CA-19 BUG FIX: seatDealTimerRef tracks the 700ms setIsSeatDealing(false) timer.
  const seatDealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CA-20 BUG FIX: handRevealTimerRef tracks the 6s setShowHandRevealModal(false) timer.
  const handRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AUDIT FIX 2026-07-19: hand-aware hero hole-card fetch. heroHandRef tracks the
  // current hand number so the poll never applies a PREVIOUS hand's cards; the
  // fetch fn is exposed so HAND_STARTED can re-arm it (recovering a dropped
  // realtime insert) after clearing stale cards.
  const heroHandRef = useRef<number>(0);
  const heroCardFetchRef = useRef<(() => void) | null>(null);
  // Achievement/challenge wiring: accumulate the hero's outcome across a hand's
  // server events (dealt-in at card populate, showdown, per-pot win) and fire
  // achievementTriggerService.onHandComplete ONCE at HAND_COMPLETE. Without this
  // the entire hand-based achievement + daily-challenge loop is inert.
  const heroHandOutcomeRef = useRef<{
    dealtIn: boolean;
    showdown: boolean;
    won: boolean;
    potWon: number;
    handRank: string;
  }>({ dealtIn: false, showdown: false, won: false, potWon: 0, handRank: '' });
  const achievementFiredHandRef = useRef<number>(0);
  // P1-3 FIX: true only once hole cards were ACTUALLY applied to the hero
  // player object; gates the recovery-poll teardown so it doesn't stop while
  // heroIdx=-1 mid-reload. Reset when the fetch is re-armed for a new hand.
  const heroCardsRecoveredRef = useRef(false);
  // CA-21 BUG FIX: bbjTimerRef tracks the 3s BBJ celebration delay timer.
  const bbjTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CA-22 BUG FIX: handCompleteTimerRef tracks the 3s HAND_COMPLETE table-reset timer.
  const handCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount guard for all four CA-19..CA-22 animation timers.
  useEffect(() => {
    return () => {
      if (seatDealTimerRef.current) clearTimeout(seatDealTimerRef.current);
      if (handRevealTimerRef.current) clearTimeout(handRevealTimerRef.current);
      if (bbjTimerRef.current) clearTimeout(bbjTimerRef.current);
      if (bbjSeatCreditsTimerRef.current) clearTimeout(bbjSeatCreditsTimerRef.current);
      if (handCompleteTimerRef.current) clearTimeout(handCompleteTimerRef.current);
      if (potShipTimerRef.current) clearTimeout(potShipTimerRef.current);
      if (potPushDelayTimerRef.current) clearTimeout(potPushDelayTimerRef.current);
    };
  }, []);

  // Round 2 (double board): the table's bomb pot rules for GameRulesModal —
  // players deserve to know a bomb pot is coming before it explodes on them.
  const [bombPotRules, setBombPotRules] = useState<{
    enabled: boolean;
    frequency: number;
    anteBB: number;
    doubleBoard: boolean;
  } | null>(null);

  // Straddle state
  const [isStraddleEnabled, setIsStraddleEnabled] = useState(false);
  const [tableStraddleEnabled, setTableStraddleEnabled] = useState(false);
  const [straddleBusy, setStraddleBusy] = useState(false);
  // Track whether straddle change originated from server (MasterBus) to avoid echo
  const straddleFromServerRef = useRef(false);

  // A straddle is 2x the big blind. This was hardcoded to `4`, which is only
  // correct at 1/2 — every other table printed the wrong price on the control.
  const straddleAmount = useMemo(() => {
    const bb = safeBB(tableState.blinds);
    return bb > 0 ? Math.round(bb * 2 * 100) / 100 : 0;
  }, [tableState.blinds]);

  // Was hardcoded `true`. Straddles are a cash-game feature the host can switch
  // off per table, and there is nothing to straddle from an empty seat.
  const isStraddleAvailable =
    tableStraddleEnabled && !tableState.isTournament && tableState.heroSeat > 0;

  /**
   * Toggle auto-straddle. Server-authoritative.
   *
   * This used to be a useEffect on [isStraddleEnabled, tableId] with a
   * `.catch()` on the end. Two problems:
   *   1. `GameServerAPI.toggleStraddle` NEVER throws — it resolves
   *      `{ success: false, error }` — so the catch was dead code and a
   *      rejected toggle was completely silent. The switch stayed on while the
   *      server had it off.
   *   2. The effect ran on mount, so simply opening a table POSTed
   *      `straddle=false` to the engine before the player touched anything.
   */
  const handleToggleStraddle = useCallback(
    async (next: boolean) => {
      if (!tableId || straddleBusy) return;
      const previous = isStraddleEnabled;
      setStraddleBusy(true);
      setIsStraddleEnabled(next); // optimistic — reverted below on refusal
      try {
        const res = await serverToggleStraddle(tableId, next);
        if (!res?.success) {
          setIsStraddleEnabled(previous);
          reportError(
            new Error(res?.error || 'toggleStraddle rejected by engine'),
            'TablePage.Toggle_failed'
          );
          toast?.error?.(res?.error || 'Could not change your straddle setting');
        }
      } finally {
        setStraddleBusy(false);
      }
    },
    [tableId, isStraddleEnabled, straddleBusy, toast]
  );

  // Cashier state
  const [showCashier, setShowCashier] = useState(false);
  const [showDiamondWallet, setShowDiamondWallet] = useState(false);
  const [accountBalance, setAccountBalance] = useState(0); // Player Wallet balance from wallets table
  // FIX 136: 2-hour re-entry restriction — minimum buy-in from recent cashout
  const [cashoutMinBuyIn, setCashoutMinBuyIn] = useState(0);

  // Handle cashier add chips (deducts from wallet, adds to table stack)
  // Returns TRUE only when the engine actually credited the stack. The cashier
  // uses this to decide whether to close; before 2026-08-20 it resolved void on
  // every rejection path, so a refused top-up closed the modal looking successful.
  const handleAddChips = async (amount: number): Promise<boolean> => {
    if (!userId || userId === 'guest' || !tableId) {
      reportError(
        new Error('Cannot add chips: not authenticated'),
        'TablePage.Cannot_add_chips_not_authenticated'
      );
      if (typeof window !== 'undefined') {
        toast.error('Sign in to add chips at this table.');
      }
      return false;
    }
    try {
      // P0 FIX (sweep #5): GameServerAPI.addChips -> engine -> atomic_table_addon
      // debits the PLAYER wallet exactly ONCE and credits the stack. The old
      // WalletService.lockForBuyIn call here was a SECOND debit of the same amount
      // (introduced when /addchips gained its own server-side debit on 2026-07-19),
      // so every top-up charged the player twice for a single stack increase.
      // The engine is now the sole authoritative debit; UI/session trackers update
      // only after it acks.
      const res = await GameServerAPI.addChips(tableId, amount);
      if (!res.success) {
        reportError(
          new Error(res.error || 'addChips rejected by engine'),
          'TablePage.addChips_engine_rejected'
        );
        // atomic_table_addon is atomic: on failure the wallet was NOT charged.
        if (typeof window !== 'undefined') {
          toast.error(res.error || 'Unable to add chips \u2014 your wallet was not charged.');
        }
        return false;
      }
      // Engine ack'd the single debit -- reflect it locally + in session trackers.
      setAccountBalance((prev) => Math.max(0, prev - amount));
      totalBuyInRef.current += amount; // Track for session P/L
      totalRebuysRef.current += 1; // Track rebuy count for session summary
      // Dan 2026-08-15: feed the top-up into SessionStatsService too, otherwise
      // its buyInTotal never moves and P&L reads as pure profit after a rebuy.
      sessionStatsService.recordRebuy(tableId, amount);
      // Update peak stack if rebuy pushes hero above previous peak
      const newPeakCandidate = (tableState.players[tableState.heroSeat - 1]?.stack || 0) + amount;
      if (newPeakCandidate > peakStackRef.current) peakStackRef.current = newPeakCandidate;

      // We do NOT optimistic update tableState anymore. The next WebSocket broadcast
      // from the engine (either immediately or at start of next hand) will give
      // us the authoritative stack size.

      // Emit bus event so other pages (Dashboard, Profile) know about the chip change
      const estimatedNewStack = (tableState.players[tableState.heroSeat - 1]?.stack || 0) + amount;
      masterBus.emit('CHIPS_ADDED', { tableId, userId, amount, newStack: estimatedNewStack });
      return true;
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_add_chips');
      // Surface error to user — alert as fallback since toast not always available
      const msg = error instanceof Error ? error.message : 'Failed to add chips';
      if (typeof window !== 'undefined') toast.error(msg);
      return false;
    }
  };

  // Handle cashier withdraw
  // Returns TRUE only when the engine actually credited the wallet. See
  // handleAddChips above for why resolving void was not good enough.
  const handleWithdrawChips = async (amount: number): Promise<boolean> => {
    if (!userId || userId === 'guest' || !tableId) {
      reportError(
        new Error('Cannot withdraw: not authenticated'),
        'TablePage.Cannot_withdraw_not_authenticated'
      );
      if (typeof window !== 'undefined') {
        toast.error('Sign in to cash out chips from this table.');
      }
      return false;
    }
    try {
      // FIX 1 (2026-07-24): server-authoritative partial cash-out. The engine
      // credits the PLAYER wallet AND reduces the seat stack atomically via
      // atomic_table_withdraw (only between hands; rejected mid-hand). No direct
      // table_seats write and no unlockFromTable here \u2014 the engine owns the
      // authoritative stack, exactly mirroring the addChips path.
      const res = await GameServerAPI.removeChips(tableId, amount);
      if (!res.success) {
        reportError(
          new Error(res.error || 'removeChips rejected by engine'),
          'TablePage.removeChips_engine_rejected'
        );
        if (typeof window !== 'undefined') {
          toast.error(res.error || 'Unable to cash out chips.');
        }
        return false;
      }
      // Engine ack'd \u2014 the wallet was credited; reflect it locally. We do
      // NOT optimistic-update tableState; the next engine broadcast carries the
      // authoritative stack.
      setAccountBalance((prev) => prev + amount);
      const estimatedNewStack = Math.max(
        0,
        (tableState.players[tableState.heroSeat - 1]?.stack || 0) - amount
      );
      masterBus.emit('CHIPS_WITHDRAWN', { tableId, userId, amount, newStack: estimatedNewStack });
      return true;
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_withdraw_chips');
      const msg = error instanceof Error ? error.message : 'Failed to withdraw chips';
      if (typeof window !== 'undefined') toast.error(msg);
      return false;
    }
  };

  // Load BBJ pool data — union-aware + LIVE (2026-08-18).
  // Two fixes over the old one-shot load:
  //  1. Union clubs bank the jackpot in the UNION pool (server checks union
  //     first) — the old clubId-only lookup showed those tables a permanent $0.
  //  2. The banner now subscribes to the pool row, so every hand's contribution
  //     ticks the jackpot up live at the table, and it resets after a hit
  //     without a page reload.
  useEffect(() => {
    if (!tableId) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const loadBBJPool = async () => {
      try {
        const { data: tableData } = await supabase
          .from('tables')
          .select('club_id')
          .eq('id', tableId)
          .maybeSingle();
        const actualClubId = tableData?.club_id;
        if (!actualClubId || cancelled) return;

        // OPTIMISED 2026-08-18: one RPC instead of clubs + bbj_pools round
        // trips, and the union rule lives server-side in fn_bbj_pool_for_club
        // rather than being re-implemented here (it was re-implemented in four
        // surfaces and wrong in three).
        const { data: poolRows } = await supabase.rpc('fn_bbj_pool_for_club', {
          p_club_id: actualClubId,
        });
        const pool = Array.isArray(poolRows) ? poolRows[0] : poolRows;
        if (!pool || cancelled || !isMounted.current) return;

        setBbjAmount(Number(pool.main_balance) || 0);
        setBbjPoolId(pool.pool_id);

        channel = supabase
          .channel(`bbj-pool-${pool.pool_id}-${tableId}`)
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'bbj_pools',
              filter: `id=eq.${pool.pool_id}`,
            },
            (payload) => {
              const next = (payload.new as { main_balance?: number | string })?.main_balance;
              const parsed = Number(next);
              if (Number.isFinite(parsed) && isMounted.current) setBbjAmount(parsed);
            }
          )
          .subscribe();
      } catch (error) {
        console.debug('Error loading BBJ pool:', error);
      }
    };

    loadBBJPool();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [tableId]);

  // Rabbit Hunt state
  const [isRabbitAvailable, setIsRabbitAvailable] = useState(false);
  const [currentBoard, setCurrentBoard] = useState<
    Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>
  >([]);
  /** Server-provided remaining deck cards for authentic rabbit hunt reveal */
  const serverRabbitCardsRef = useRef<Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>>([]);

  // Handle rabbit hunt reveal — uses real server-dealt deck cards
  const handleRabbitReveal = async (): Promise<
    Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>
  > => {
    const cardsNeeded = 5 - currentBoard.length;
    if (cardsNeeded <= 0) return [];

    // Use server-provided cards (authentic from the actual deck)
    if (serverRabbitCardsRef.current.length > 0) {
      const cards = serverRabbitCardsRef.current.slice(0, cardsNeeded);
      // Clear after reveal (one-time use)
      serverRabbitCardsRef.current = [];
      setIsRabbitAvailable(false);
      return cards;
    }

    // P2-2 FIX: Do NOT fabricate random cards when the server didn't provide
    // them (edge case: stale state, reconnection). On a real-money platform
    // inventing a card outcome misrepresents the deck, so short-circuit the
    // reveal instead — surface "unavailable" and return no cards.
    toast.error('Rabbit Hunt unavailable - no card data from server.');
    setIsRabbitAvailable(false);
    return [];
  };

  // Leaderboard state
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardPeriod, setLeaderboardPeriod] = useState<
    'session' | 'day' | 'week' | 'month' | 'allTime'
  >('session');
  const [leaderboardPlayers, setLeaderboardPlayers] = useState<
    Array<{
      rank: number;
      playerId: string;
      playerName: string;
      avatar?: string;
      amount: number;
      isPositive: boolean;
      isCurrentUser?: boolean;
    }>
  >([]);

  // DEAD-WIRING FIX 2026-08-15: three table panels were permanently empty
  // because their state setters were never called ANYWHERE in the repo:
  //   leaderboardPlayers -> "Session Leaderboard" always blank
  //   handHistory        -> in-table Hand History blank after a long session
  //   lastHandId         -> Hand Replay always "No recent hand to replay"
  // The services behind them work fine; nothing ever called them. Each panel
  // now loads lazily when it is opened, so a closed panel costs nothing.

  // Leaderboard. Real data only became possible today: player_stats.vpip/pfr
  // and tournaments_played/won had no writer, so this board would have been
  // all zeros even if it had been wired.
  useEffect(() => {
    if (!showLeaderboard) return;
    let cancelled = false;
    const clubId = actualClubIdRef.current;
    if (!clubId) {
      setLeaderboardPlayers([]);
      return;
    }
    const periodMap: Record<string, 'daily' | 'weekly' | 'monthly' | 'all_time'> = {
      session: 'daily',
      day: 'daily',
      week: 'weekly',
      month: 'monthly',
      allTime: 'all_time',
    };
    (async () => {
      try {
        const rows = await LeaderboardService.getClubLeaderboard(
          clubId,
          'profit',
          periodMap[leaderboardPeriod] || 'weekly',
          25
        );
        if (cancelled) return;
        setLeaderboardPlayers(
          (rows || []).map((r) => ({
            rank: r.rank,
            playerId: r.userId,
            playerName: r.username,
            avatar: r.avatar,
            amount: Math.abs(r.value ?? 0),
            isPositive: (r.value ?? 0) >= 0,
            isCurrentUser: r.userId === userId,
          }))
        );
      } catch (e) {
        if (!cancelled) reportError(e, 'TablePage.loadLeaderboard');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showLeaderboard, leaderboardPeriod, userId]);

  // Sound & vibration preferences — extracted to useTableSound hook
  const {
    isSoundEnabled,
    setIsSoundEnabled,
    isVibrationEnabled,
    setIsVibrationEnabled,
    playTurnAlert,
  } = useTableSound();

  // All-in dramatic mode
  const [isAllInMode, setIsAllInMode] = useState(false);

  // FIX 89: All-in equity display — shows equity percentages for all all-in players
  // Populated by server's 'all_in_equity' Realtime event, visible to all players/observers
  const [allInEquities, setAllInEquities] = useState<
    Array<{ userId: string; username: string; equity: number; seat: number }>
  >([]);

  // COMPETITOR-PARITY 2026-08-19: table-level ALL IN banner. The per-seat
  // badge existed but the RUNOUT itself had no table-wide moment. Fires once
  // per hand on the first all_in_equity broadcast (exactly when betting is
  // done and the paced runout begins — for players AND observers).
  const [showAllInBanner, setShowAllInBanner] = useState(false);
  const allInBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEquityCountRef = useRef(0);
  useEffect(() => {
    const count = allInEquities.length;
    if (count > 0 && prevEquityCountRef.current === 0) {
      setShowAllInBanner(true);
      if (allInBannerTimerRef.current) clearTimeout(allInBannerTimerRef.current);
      // AUDIT-2 FIX 2026-08-20: this window was the ONE unscaled JS timer left.
      // .allin-banner__text runs calc(1.8s * var(--animation-speed)); at a slow
      // setting the banner was ripped out of the DOM mid-slam at full opacity.
      allInBannerTimerRef.current = setTimeout(() => {
        allInBannerTimerRef.current = null;
        setShowAllInBanner(false);
      }, 1800 * getAnimationSpeed());
    }
    prevEquityCountRef.current = count;
  }, [allInEquities.length]);
  useEffect(
    () => () => {
      if (allInBannerTimerRef.current) clearTimeout(allInBannerTimerRef.current);
    },
    []
  );

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 4 — Premium Features (HUD, Pot Odds, Hand History, Settings)
  // ═══════════════════════════════════════════════════════════════════════════

  // Smart Mini-HUD — track opponent stats (VPIP/PFR/heat)
  const {
    getStats: getPlayerHUDStats,
    recordHandPlayed,
    recordVPIP,
    recordPFR,
    recordWin: recordHUDWin,
  } = usePlayerStats();

  // User settings with persistence
  const { settings: userSettings, updateSetting } = useTableSettings();
  const userSettingsRef = useRef(userSettings);
  useEffect(() => {
    userSettingsRef.current = userSettings;
  }, [userSettings]);

  // Bible V8 §11.1: Supabase-backed user table preferences (12 toggles)
  const {
    settings: v8Settings,
    loading: v8SettingsLoading,
    toggleSetting: toggleV8Setting,
  } = useUserTableSettings(userId !== 'guest' ? userId : null);

  // FIX-232: Ref for cards_pre_sort to avoid stale closure in hole card callbacks
  const cardsPreSortRef = useRef(v8Settings.cards_pre_sort);
  cardsPreSortRef.current = v8Settings.cards_pre_sort;

  // Bible V8 §11.2: Per-game-type theme from Supabase
  const { theme: v8Theme } = useUserThemeSettings(
    userId !== 'guest' ? userId : null,
    tableState.gameType,
    tableState.isTournament,
    /**
     * This argument used to be `undefined`, with a comment claiming the type was
     * "resolved internally from gameType". It is not - getThemeGameType has no
     * other source for it, so every tournament fell to its 'MTT' default and a
     * Spin resolved the player's MTT felt, background, deck and button art
     * rather than the SNG row it shares with heads-up. Four data-* theme
     * attributes on the table root come off that same value, so a Spin did not
     * merely miss a preference, it rendered a different table.
     */
    tournamentFormat ?? undefined
  );

  /**
   * Dan 2026-08-20 — THE CARDS TAB NEVER APPLIED ANYTHING.
   *
   * Theme Settings' Cards tab wrote `cards_id` into user_theme_settings, and
   * this page read it into exactly one place: the `data-cards-theme` attribute
   * below, which sets two CSS custom properties nothing consumes. The card
   * backs that actually render come from `userSettings.cardBack` (settingsBridge),
   * a completely separate value. So you could pick a card back in the modal,
   * see "Theme applied", and watch the felt keep dealing the old design forever.
   *
   * The theme selection is the more specific choice (it is per game type), so
   * it wins when set; the global setting is the fallback. Both go through
   * normalizeCardBack so a stale id can never blank a card.
   */
  const activeCardBack = useMemo(
    () => normalizeCardBack(v8Theme.cards_id || userSettings.cardBack),
    [v8Theme.cards_id, userSettings.cardBack]
  );

  // Bible V8 §9.1.3: Frame budget monitoring (dev mode only — warns on >16ms frames)
  useFrameBudgetMonitor();

  // ── Dan 2026-08-18: animations are not optional ──
  //
  // This effect used to zero out every animation duration when
  // skip_animations was set. The toggle is gone from the settings list, and
  // the override goes with it - otherwise anyone whose cached settings still
  // carry skip_animations: true would keep a permanently animation-free table
  // with no control left to turn it back on.
  //
  // The durations are deliberately CLEARED rather than merely left alone, so a
  // stale value in the localStorage settings cache (user_table_settings_cache)
  // cannot leave --deal-duration: 0s stuck on the document from a prior
  // session. Reduced-motion is still honoured where it belongs: the CSS
  // prefers-reduced-motion queries in animations.css and ChipAnimations.css,
  // which are an accessibility setting rather than a gameplay preference.
  // REGRESSION FIX, same day: this list began with '--animation-speed', which
  // was wrong. That property is not a skip-animations artefact - it is the
  // live Animation Speed preference, written from saved settings by
  // useTableSettings' own effect. That hook is called at the top of this
  // component, so its effect flushes first and this one then deleted the value
  // it had just written. Net effect: the Animation Speed control did nothing
  // on any table load, and only appeared to work if changed while a table was
  // already open. The other eight ARE skip-animations duration overrides and
  // are correct to clear.
  useEffect(() => {
    const root = document.documentElement;
    for (const prop of [
      '--deal-duration',
      '--flip-duration',
      '--fold-duration',
      '--win-glow-duration',
      '--chip-bet-duration',
      '--chip-win-duration',
      '--chip-merge-duration',
      '--chip-allin-duration',
    ]) {
      root.style.removeProperty(prop);
    }
  }, []);

  // Bible V8 §11.1: enhanced_view → document-level flag so themes and
  // component CSS can branch on body[data-enhanced-view="1"]. Single source
  // so future visual effects can opt in without plumbing the prop through.
  useEffect(() => {
    if (v8Settings.enhanced_view) {
      document.documentElement.setAttribute('data-enhanced-view', '1');
    } else {
      document.documentElement.removeAttribute('data-enhanced-view');
    }
    return () => {
      document.documentElement.removeAttribute('data-enhanced-view');
    };
  }, [v8Settings.enhanced_view]);

  // Sync sound volume from persisted settings on mount (and when slider changes)
  useEffect(() => {
    soundService.setMasterVolume(userSettings.soundVolume / 100);
  }, [userSettings.soundVolume]);

  // Hand history state — load from localStorage for session continuity
  const [handHistory, setHandHistory] = useState<HandRecord[]>(() => {
    try {
      const saved = localStorage.getItem(`hand_history_${tableId || 'default'}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showHandHistory, setShowHandHistory] = useState(false);

  // Hand history panel — hydrate from the service the Hand History PAGE
  // already uses. The local list only ever held what localStorage had cached,
  // and nothing wrote to it, so it was empty for everyone.
  //
  // Dan 2026-08-22 mobile audit item 5: "THE PREVIOUS HAND HAS NO
  // FUNCTIONALITY, IT NEVER LOGS ANY OF THE HANDS." It didn't, and the reason
  // was here: this effect only fired for showHandHistory (the panel), while
  // the Previous Hand card opens showHandDetail (the breakdown modal) — which
  // therefore paged through an empty array for anyone without a localStorage
  // cache. Both openers hydrate now.
  useEffect(() => {
    if ((!showHandHistory && !showHandDetail) || !userId || userId === 'guest') return;
    let cancelled = false;
    (async () => {
      try {
        const hands = await handHistoryService.getPlayerHands(userId, 50);
        if (!cancelled && hands && hands.length > 0) {
          setHandHistory(hands.map((h) => adaptServiceHandToPanel(h, userId)));
        }
      } catch (e) {
        if (!cancelled) reportError(e, 'TablePage.loadHandHistoryPanel');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showHandHistory, showHandDetail, userId]);

  // Hand replay — resolve the most recent hand id lazily when the panel opens
  // rather than paying a lookup on every completed hand.
  useEffect(() => {
    if (!showHandReplay || lastHandId || !userId || userId === 'guest') return;
    let cancelled = false;
    (async () => {
      try {
        const hands = await handHistoryService.getPlayerHands(userId, 1);
        if (!cancelled && hands && hands.length > 0 && hands[0]?.id) {
          setLastHandId(hands[0].id);
        }
      } catch (e) {
        if (!cancelled) reportError(e, 'TablePage.resolveLastHandId');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showHandReplay, lastHandId, userId]);

  // Persist hand history to localStorage (debounced to prevent rapid-fire writes)
  const localStorageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (handHistory.length > 0 && tableId) {
      if (localStorageTimerRef.current) clearTimeout(localStorageTimerRef.current);
      localStorageTimerRef.current = setTimeout(() => {
        try {
          localStorage.setItem(`hand_history_${tableId}`, JSON.stringify(handHistory.slice(0, 50)));
        } catch {
          /* localStorage full — ignore */
        }
      }, 500);
    }
    return () => {
      if (localStorageTimerRef.current) clearTimeout(localStorageTimerRef.current);
    };
  }, [handHistory, tableId]);

  // Clean up stale hand history keys older than 7 days on mount
  useEffect(() => {
    try {
      const now = Date.now();
      const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith('hand_history_') && key !== `hand_history_${tableId}`) {
          try {
            const data = JSON.parse(localStorage.getItem(key) || '[]');
            const lastTimestamp = data[0]?.timestamp || 0;
            if (lastTimestamp && now - lastTimestamp > MAX_AGE_MS) {
              localStorage.removeItem(key);
            }
          } catch {
            localStorage.removeItem(key!);
          } // Corrupt data — remove
        }
      }
    } catch {
      /* localStorage not available */
    }
  }, [tableId]);

  // Hand history recording refs — accumulate actions during a hand
  const handActionsRef = useRef<
    Array<{ seat: number; action: string; amount?: number; street: string }>
  >([]);
  const historyHandCountRef = useRef(0);
  const handStartStacksRef = useRef<Record<number, number>>({});
  /** Button seat captured at HAND_STARTED — the live dealerSeat has already
   *  rotated by the time the hand completes. */
  const shareButtonSeatRef = useRef(0);
  // Per-street pot tracking — records pot at each stage transition for accurate hand history
  const streetPotsRef = useRef<Record<string, number>>({ preflop: 0, flop: 0, turn: 0, river: 0 });

  // Play win sound — escalates based on pot size
  const playWinSound = (potAmount?: number) => {
    // NEW-BUG-2 FIX: use dynamic isEnabled() not stale isSoundEnabled closure
    if (!soundService.isEnabled()) return;
    // #175 multi-table sound mixing: suppress ambient win celebration on background tables
    if (!ambientSoundsAllowed) return;
    // Use ref for fresh blinds (this function is called from event handlers that may have stale closures)
    const currentBlinds = tableStateRef.current.blinds;
    const bb = safeBB(currentBlinds);
    const bbWon = (potAmount || tableStateRef.current.pot) / bb;

    if (bbWon >= 50) {
      soundService.playBigWin();
      // Confetti disabled — annoying on repeated wins
    } else {
      soundService.playWin();
    }
    soundService.playPotCollect();
  };

  // GTO advisor state
  const [gtoSolution, setGtoSolution] = useState<GTOSolution | null>(null);
  const [isGtoLoading, setIsGtoLoading] = useState(false);
  const [showGtoAdvisor, setShowGtoAdvisor] = useState(false);

  // Fetch GTO advice for current situation
  const fetchGtoAdvice = async (
    position: string,
    street: string,
    board: string[] | null = null
  ) => {
    setIsGtoLoading(true);
    try {
      const solution = await GTOQueryService.getGTOAction(
        position,
        'SRP', // Single Raised Pot
        street,
        board,
        'check',
        100
      );
      setGtoSolution(solution);
    } catch (error) {
      reportError(error, 'TablePage.Error_fetching_GTO_advice');
    }
    setIsGtoLoading(false);
  };

  // Rake state
  const [sessionRake, setSessionRake] = useState(0);

  // [MIGRATION] handleHandComplete REMOVED — FIX 181
  // Rake calculation and waterfall execution are server-authoritative (Bible V8 Law 1.4).
  // The server's PokerEngine.ts calculates rake and supabase.ts distributes it.
  // This client-side duplicate was dead code (never called after HandController removal).

  // Leave-table notification state (replaces blocking alert())
  const [leaveNotice, setLeaveNotice] = useState<string | null>(null);

  // Handle tournament rebuy
  const handleTournamentRebuy = async () => {
    if (!tableState.tournamentId || !userId) return;
    try {
      const rebuyCheck = await tournamentService.canRebuy(tableState.tournamentId, userId);
      if (!rebuyCheck.allowed) {
        toast.error(rebuyCheck.reason || 'Rebuy not available');
        return;
      }
      // Get tournament info to get rebuy cost and chips.
      // 2026-08-20: quote through TournamentService so the modal prints the same
      // base + house fee that processRebuy actually debits. It used to show the
      // base only, which enabled Confirm for players who could not pay the total.
      const tournament = await tournamentService.getTournament(tableState.tournamentId);
      if (tournament) {
        const quote = tournamentService.quoteFromTournament(tournament, 'rebuy');
        setRebuyData({ cost: quote.baseCost, fee: quote.fee, chips: quote.chips });
        setShowRebuyModal(true);
      }
    } catch (err) {
      toast?.error((err as Error).message || 'Failed to load rebuy info');
    }
  };

  // Handle tournament add-on
  const handleTournamentAddOn = async () => {
    if (!tableState.tournamentId || !userId || rebuyProcessing) return;
    setRebuyProcessing(true);
    try {
      const addOnCheck = await tournamentService.canAddOn(tableState.tournamentId);
      if (!addOnCheck.allowed) {
        toast.error(addOnCheck.reason || 'Add-on not available');
        return;
      }
      await tournamentService.processAddOn(tableState.tournamentId, userId);
      toast?.success('Add-on successful - chips added');
      setShowRebuyModal(false);
    } catch (err) {
      toast?.error((err as Error).message || 'Add-on failed');
    } finally {
      setRebuyProcessing(false);
    }
  };

  // Handle leave table - cleans up and returns chips (non-blocking)
  // 2026-04-14 Dan feedback — "when a player busts or gets felted, it needs
  // to check if the player has enough chips in his wallet to rebuy. I was
  // straight booted from the table when I lost all my chips."
  //
  // Watch for the hero's stack to drop to 0 AND the hand to complete; at
  // that moment, look up the wallet balance and pop the BuyInModal (reused
  // in rebuy mode). The existing `atomic_table_rebuy` RPC tops up the seat.
  useEffect(() => {
    if (!tableId || !userId || tableState.heroSeat <= 0) return;
    if (tableState.isTournament) return; // Tournaments have their own rebuy flow
    const heroPlayer = tableState.players[tableState.heroSeat - 1];
    if (!heroPlayer) return;
    const stack = heroPlayer.stack ?? 0;
    // Only prompt when the hand is NOT in progress to avoid popping mid-hand.
    // Also only once per bust — bustPromptFiredRef guards against repeat.
    if (stack > 0) {
      bustPromptFiredRef.current = false;
      return;
    }
    if (tableState.isHandInProgress) return;
    if (bustPromptFiredRef.current) return;
    if (bustRebuyOpen || showBuyInModal) return;
    bustPromptFiredRef.current = true;

    (async () => {
      try {
        const { data } = await supabase
          .from('wallets')
          .select('balance')
          .eq('user_id', userId)
          .eq('wallet_type', 'PLAYER')
          .maybeSingle();
        setBustWalletBalance(Number(data?.balance ?? 0));
      } catch {
        setBustWalletBalance(0);
      }
      setBustRebuyOpen(true);
    })();
  }, [
    tableId,
    userId,
    tableState.heroSeat,
    tableState.players,
    tableState.isHandInProgress,
    tableState.isTournament,
    bustRebuyOpen,
    showBuyInModal,
  ]);

  const confirmBustRebuy = useCallback(
    async (amount: number) => {
      if (!tableId || !userId) return;
      setBustRebuyProcessing(true);
      try {
        const { error } = await supabase.rpc('atomic_table_rebuy', {
          p_user_id: userId,
          p_table_id: tableId,
          p_amount: amount,
        });
        if (error) {
          toast?.error(error.message || 'Rebuy failed');
          setBustRebuyProcessing(false);
          return;
        }
        toast?.success(`Rebought for ${amount.toLocaleString()}`);
        setBustRebuyOpen(false);
        // Guard so a zero-stack state immediately after the RPC succeeds
        // doesn't re-trigger another prompt before the snapshot updates.
        bustPromptFiredRef.current = true;
      } catch (err) {
        toast?.error((err as Error).message || 'Rebuy failed');
      } finally {
        setBustRebuyProcessing(false);
      }
    },
    [tableId, userId, toast]
  );

  // Forward-ref so cancelBustRebuy() (declared above) can invoke the real
  // handleLeaveTable (declared below) without a circular definition.
  const handleLeaveTableRef = useRef<(() => void) | null>(null);
  const cancelBustRebuy = useCallback(() => {
    setBustRebuyOpen(false);
    // User chose to leave — trigger a real leave so their seat is cleared.
    handleLeaveTableRef.current?.();
  }, []);

  /**
   * Where leaving a table puts you.
   *
   * Dan 2026-08-23: "when you leave a table, it should take you to the club in
   * game lobby, not the actual lobby." Both exit paths below called
   * `navigate('/')`, which is the Club Arena home carousel — Create A Club /
   * Find A Player / Join A Club. You stood up from a seat in Club JAQK and
   * landed on a screen for choosing a club, with no trace of the one you were
   * just sitting in.
   *
   * `actualClubIdRef` is stamped from `table.club_id` when the table loads, so
   * it is the club this seat actually belonged to rather than whatever the URL
   * happened to carry. '/' remains the fallback for the case that ref is empty
   * — a table with no club is the only way back to nowhere in particular.
   */
  const exitDestination = () => {
    const clubId = actualClubIdRef.current;
    return clubId ? `/clubs/${clubId}` : '/';
  };

  const handleLeaveTable = async () => {
    if (!tableId || !userId) return;
    setLeaveNotice(null);

    // Capture hero stack BEFORE leave (seat data may be cleared by leaveTable)
    const heroPlayer = tableState.players[tableState.heroSeat - 1];
    const stackAtLeave = heroPlayer?.stack || 0;
    // Dan 2026-08-18: TABLE_LEFT now fires here rather than from the summary's
    // close handler, and by then heroSeat has already been zeroed just below.
    // Capture it while it is still valid.
    const seatAtLeave = tableState.heroSeat;

    try {
      const result = await tableService.leaveTable(tableId, tableState.heroSeat, userId);
      if (result.success) {
        // FIX 132: Clear heroSeatRef so player can re-seat at another table
        heroSeatRef.current = 0;
        // Dan 2026-08-19: the REF was cleared but tableState.heroSeat was not,
        // so after leaving, the chair still rendered "YOUR SEAT" (and counted
        // as occupied by hero) until a snapshot happened to correct it. Clear
        // the state too: the seat is immediately open to other players.
        setTableState((prev) => ({ ...prev, heroSeat: 0 }));
        pendingSeatStackRef.current = 0;
        console.debug(`[Leave] Success - ${result.chipsReturned} chips returned to wallet`);

        // Notify system (TABLE_LEFT is deliberately delayed until Session Summary closes)
        masterBus.emit('SESSION_ENDED', { tableId, userId });

        // Q3: Clear "Playing At" status when leaving table
        playerStatusService.clearPlayingAt(userId);

        // P/L = chips returned to wallet minus total chips invested at table.
        //
        // Dan 2026-08-22 (Session Complete "not pulling the real stats"): a
        // mid-hand leave defers the cashout to settlement and reports
        // chipsReturned 0, which used to render the ENTIRE buy-in as a loss
        // (screenshot: stack 1,157 at leave, card said LOSS -1,000). When the
        // service says the cashout is deferred, estimate with the live stack
        // captured above — that is what settlement will return, give or take
        // the hand in flight.
        sessionPLRef.current =
          (result.deferred ? stackAtLeave : result.chipsReturned || 0) - totalBuyInRef.current;

        // ── Dan 2026-08-18: leaving always lands you in the lobby ──
        //
        // This used to open the summary ON the table and defer everything -
        // TABLE_LEFT, closing the tab, and the navigate - until the player
        // dismissed it, so you sat looking at a table you had already left.
        //
        // Every number in that modal lived in refs owned by THIS component, so
        // it could not outlive the navigation. Hand the payload to the app-root
        // host first: it renders over whichever lobby the player lands on
        // (HomePage, ClubHomePage or ClubLobby) and survives this unmounting.
        /* Dan 2026-08-20: "tournaments are never displayed by chips, only what
           place you finished and how much you made."

           A tournament seat used to publish the cash payload, so the summary
           showed a chip-denominated "profit", a biggest pot and a peak stack —
           numbers that mean nothing once the tournament is over, and which
           rendered as a grid of zeroes next to a bogus profit figure. Fetch the
           actual result instead; the modal switches on the presence of this
           block. The fetch is awaited before publishing because the host reads
           the payload once, on arrival. */
        const tournamentResult = tableState.tournamentId
          ? await fetchTournamentResult(tableState.tournamentId, userId)
          : undefined;

        publishSessionSummary({
          duration: Math.floor((Date.now() - sessionStartRef.current) / 1000),
          handsPlayed: handsPlayedRef.current,
          handsWon: handsWonRef.current,
          totalRebuys: totalRebuysRef.current,
          profitLoss: sessionPLRef.current,
          biggestPot: biggestPotRef.current,
          peakStack: peakStackRef.current,
          tableName: tableState.tableName,
          tournament: tournamentResult,
          // Dan 2026-08-22: the card shows VPIP (not hands/hour), the total
          // buy-in, and the session's date + time.
          vpipPercent:
            handsPlayedRef.current > 0
              ? Math.round((vpipCountRef.current / handsPlayedRef.current) * 100)
              : 0,
          totalBuyIn: totalBuyInRef.current,
          sessionStart: sessionStartRef.current,
          sessionEnd: Date.now(),
          // Phase 3 (2026-08-22): when the cashout is deferred the P/L above
          // is an estimate (live stack at leave); the card annotates it
          // "Pending Settlement" so the estimate is never read as settled.
          plPending: !!result.deferred,
          // Phase 4 (2026-08-22): and the app-root host reconciles it — it
          // polls for the settlement's wallet_transactions cashout row and
          // swaps the estimate for the settled figure. This component is
          // about to navigate away and unmount, so the host must be able to
          // find the row on its own.
          pendingCashout: result.deferred ? { tableId, userId, sinceMs: Date.now() } : undefined,
        });

        // Now actually leave. These three used to fire together from the
        // modal's close handler, where they raced each other for the
        // destination (club lobby vs an in-page lobby tab vs '/') and the last
        // one silently won. Emitting them here, before navigating, keeps the
        // order deterministic.
        masterBus.emit('TABLE_LEFT', { tableId: tableId ?? '', seat: seatAtLeave });
        masterBus.emit('TABLE_MENU_ACTION', {
          tableId: tableId ?? '',
          action: 'CLOSE_TABLE_TAB',
        });
        navigate(exitDestination());

        // Phase E: Route session end to Notifications tab for async review
        if (userId && userId !== 'guest') {
          const pl = sessionPLRef.current;
          const plText = pl >= 0 ? `+${pl.toLocaleString()}` : pl.toLocaleString();
          notificationService
            .create({
              userId,
              type: 'system',
              title: 'Session Complete',
              message: `Session ended at ${tableState.tableName}. P/L: ${plText} chips over ${handsPlayedRef.current} hands.`,
              metadata: { tableId: tableId || '', plChips: pl, hands: handsPlayedRef.current },
            })
            .catch(() => {
              /* non-critical — don't block leave flow */
            });
        }
      } else {
        // Non-success leave is expected when: player is mid-hand (leave_pending is set),
        // seat already cleared, or double-tap. Not a Sentry-worthy production bug.
        // With the user_id-based seat resolution in leaveTable, success:false now
        // means the player genuinely holds no active seat (already left / double-tap),
        // NOT "mid-hand" (that path returns success:true with leave_pending set). So
        // the message no longer misleadingly blames an active hand.
        console.warn('[Leave] leaveTable returned false - no active seat found for user', {
          tableId,
          userId,
          heroSeat: tableState.heroSeat,
        });
        if (result.error) {
          // Engine explicitly refused (unreachable / cashout blocked) — the
          // seat is still live with chips in it, so the player must stay.
          setLeaveNotice(result.error);
        } else {
          // Dan 2026-08-20 (leave-stuck fix): no error means the player
          // genuinely holds no active seat row (already left / never fully
          // seated / reservation cleaned up server-side). The old code showed
          // a notice but KEPT the client-side seat claim, so the felt read
          // "YOUR SEAT" and the footer "Seat Reserved, You'll Be Dealt In
          // Next Hand" forever — the exact "I left but never actually left"
          // state. There is nothing to cash out, so release the claim and
          // exit to the lobby like a normal leave.
          heroSeatRef.current = 0;
          pendingSeatStackRef.current = 0;
          setTableState((prev) => ({ ...prev, heroSeat: 0 }));
          playerStatusService.clearPlayingAt(userId);
          masterBus.emit('SESSION_ENDED', { tableId, userId });
          masterBus.emit('TABLE_LEFT', { tableId: tableId ?? '', seat: seatAtLeave });
          masterBus.emit('TABLE_MENU_ACTION', {
            tableId: tableId ?? '',
            action: 'CLOSE_TABLE_TAB',
          });
          navigate(exitDestination());
        }
      }
    } catch (error) {
      reportError(error, 'TablePage.Exception');
      setLeaveNotice('Error leaving table. Please try again.');
    }
  };

  // Bind the forward-ref used by cancelBustRebuy so the Decline button on
  // the bust prompt invokes the real leave flow.
  useEffect(() => {
    handleLeaveTableRef.current = handleLeaveTable;
  });

  // Handle force leave (triggered by closing tab 'X' button or when already cashed out)
  const handleForceLeaveTable = async () => {
    if (!tableId || !userId) return;
    try {
      // (The old "already viewing summary" early-return is gone with the dead
      // in-table SessionSummary modal — the summary now renders in the lobby,
      // after this table is already torn down.)
      // Force cashout instantly without triggering the UI summary.
      //
      // 2026-08-20: this discarded the result. `leaveTable` never throws — its
      // own outer catch resolves `{ success: false, chipsReturned: 0 }` — so the
      // catch below was dead too. On a failed cash-out the tab still closed and
      // TABLE_LEFT / SESSION_ENDED still fired, so the player landed in the
      // lobby believing they had cashed out while their seat stayed active and
      // kept posting blinds with their chips in it. The sibling handler at the
      // normal leave path already checks this; the tab X did not.
      const forced = await tableService.leaveTable(tableId, tableState.heroSeat, userId);
      if (!forced?.success && forced?.error) {
        // Engine explicitly refused a REAL seated leave — chips are live, stay.
        reportError(
          new Error(forced.error || 'force leave rejected'),
          'TablePage.handleForceLeaveTable.refused'
        );
        setLeaveNotice(
          forced.error || 'Could not leave the table - your chips are still in your seat.'
        );
        return; // stay on the table; the seat is still live
      }
      // Dan 2026-08-20: success:false WITHOUT an error means the player holds
      // no active seat — they are a SPECTATOR (or already cashed out). There
      // is nothing to refuse; closing the tab is exactly what they asked for.
      // The old guard showed "your chips are still in your seat" to people
      // with no seat and made the table impossible to close while watching.
      heroSeatRef.current = 0; // FIX 132: Clear on force leave
      masterBus.emit('TABLE_LEFT', { tableId, seat: tableState.heroSeat });
      masterBus.emit('SESSION_ENDED', { tableId, userId });
      playerStatusService.clearPlayingAt(userId);
    } catch (e) {
      reportError(e, 'TablePage.handleForceLeaveTable');
      // Fallback: forcefully close tab to prevent freeze
      masterBus.emit('TABLE_LEFT', { tableId, seat: tableState.heroSeat });
    }
  };

  // ─── beforeunload: warn user and attempt seat cleanup on tab close/refresh ───
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Only warn if the player is actually seated
      if (tableState.heroSeat > 0 && tableId && userId && userId !== 'guest') {
        // Fire seat cleanup (best-effort, may not complete before tab closes)
        // sendBeacon with Blob to include Content-Type and apikey headers
        const beaconUrl = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/player_leave_table?apikey=${import.meta.env.VITE_SUPABASE_ANON_KEY}`;
        const blob = new Blob([JSON.stringify({ p_table_id: tableId, p_user_id: userId })], {
          type: 'application/json',
        });
        navigator.sendBeacon?.(beaconUrl, blob);
        event.preventDefault();
        event.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [tableId, userId, tableState.heroSeat]);

  // Subscribe to table updates using TableService
  useEffect(() => {
    if (!tableId) return;

    const unsubscribe = tableService.subscribeToTable(tableId, (updatedTable) => {
      // Update local state from table updates
      setTableState((prev) => ({
        ...prev,
        tableName: updatedTable.name,
        gameType: updatedTable.game_variant as any,
        blinds:
          updatedTable.small_blind != null && updatedTable.big_blind != null
            ? `${updatedTable.small_blind}/${updatedTable.big_blind}`
            : prev.blinds,
      }));
    });

    return () => unsubscribe();
  }, [tableId]);

  // SECURE HOLE CARD PROVISIONING RECEIVER (ANTI-GOD-MODE)
  // Subscribes directly to Postgres RLS-protected table to bypass public WebSocket leak

  // Callback for handling new hole cards
  const handleHoleCardPayload = useCallback(
    (payload: any) => {
      const row = payload.new;
      if (row && row.user_id === userId && row.cards) {
        // Play deal sound if enabled (#175 gated for multi-table)
        if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playDeal();

        setTableState((prev) => {
          const updatedPlayers = [...prev.players];
          const heroIdx = updatedPlayers.findIndex((p) => p && p.id === userId);

          if (heroIdx >= 0 && updatedPlayers[heroIdx]) {
            let rawCards = [];
            try {
              rawCards = typeof row.cards === 'string' ? JSON.parse(row.cards) : row.cards;
            } catch (e) {
              rawCards = row.cards as any;
            }

            let formattedCards = (rawCards || []).map((c: any) => ({
              rank: c.rank,
              suit: ENGINE_SUIT_MAP[c.suit] || (c.suit as 'h' | 'd' | 'c' | 's'),
            }));
            // Bible V8 §11.1: cards_pre_sort — sort by rank high→low
            // FIX-232: Use ref to avoid stale closure (callback deps are [userId] only)
            if (cardsPreSortRef.current) formattedCards = sortCardsByRank(formattedCards);

            updatedPlayers[heroIdx] = {
              ...updatedPlayers[heroIdx]!,
              holeCards: formattedCards,
              showCards: true,
            };
            // Hero was dealt into this hand → counts toward hands-played achievements.
            if (formattedCards.length >= 2) heroHandOutcomeRef.current.dealtIn = true;
          }
          return { ...prev, players: updatedPlayers };
        });
      }
    },
    [userId]
  );

  useMasterBusChannel({
    channelName: `table-cards-secure-${tableId}-${userId}`,
    table: 'table_hole_cards',
    filter: tableId ? `table_id=eq.${tableId}` : null,
    event: 'INSERT',
    onPayload: handleHoleCardPayload,
    enabled: !!tableId && !!userId,
  });

  // Fallback: Check active hand if page reloads mid-hand and misses the INSERT event.
  // FIX-232: Polls at 0s/2s/5s intervals but STOPS once cards are received (Bug #7).
  // FIX-232: Uses cardsPreSortRef to avoid stale closure (Bug #6).
  useEffect(() => {
    if (!tableId || !userId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const fetchExistingHand = async () => {
      if (cancelled) return;
      const { data } = await supabase
        .from('table_hole_cards')
        .select('cards, hand_number')
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;

      // AUDIT FIX 2026-07-19: don't apply a row from a DIFFERENT (older) hand.
      // Once we know the current hand number (set on HAND_STARTED), require the
      // fetched row to match it — otherwise a delayed insert would let the
      // previous hand's cards render on the new hand.
      if (
        data &&
        heroHandRef.current > 0 &&
        typeof (data as any).hand_number === 'number' &&
        (data as any).hand_number !== heroHandRef.current
      ) {
        return;
      }

      if (data && data.cards) {
        let cardsApplied = false;
        setTableState((prev) => {
          const updatedPlayers = [...prev.players];
          const heroIdx = updatedPlayers.findIndex((p) => p && p.id === userId);

          if (
            heroIdx >= 0 &&
            updatedPlayers[heroIdx] &&
            (!updatedPlayers[heroIdx]!.holeCards ||
              updatedPlayers[heroIdx]!.holeCards!.length === 0)
          ) {
            let rawCards = [];
            try {
              rawCards = typeof data.cards === 'string' ? JSON.parse(data.cards) : data.cards;
            } catch (e) {
              rawCards = data.cards as any;
            }
            let parsedCards = (rawCards || []).map((c: any) => ({
              rank: c.rank,
              suit: ENGINE_SUIT_MAP[c.suit] || (c.suit as any),
            }));
            if (cardsPreSortRef.current) parsedCards = sortCardsByRank(parsedCards);
            updatedPlayers[heroIdx] = {
              ...updatedPlayers[heroIdx]!,
              holeCards: parsedCards,
              showCards: true,
            };
            if (parsedCards.length >= 2) heroHandOutcomeRef.current.dealtIn = true;
            cardsApplied = true;
            heroCardsRecoveredRef.current = true;
          }
          return cardsApplied ? { ...prev, players: updatedPlayers } : prev;
        });

        // P1-3 fix: Only stop polling once cards were ACTUALLY applied to the
        // hero player object. The old `cardsApplied || data.cards` always
        // stopped after the first fetched row (data.cards is truthy here), and
        // `cardsApplied` is set inside the setTableState updater which React
        // may run after this line — so gate teardown on the ref, which the
        // updater sets on real application and a later poll observes.
        if (heroCardsRecoveredRef.current) {
          if (retryTimer) clearTimeout(retryTimer);
          if (pollTimer) clearInterval(pollTimer);
        }
      }
    };
    // Initial fetch + retry at 2s, then poll every 5s.
    // 2026-08-22: BOUNDED. For an observer or a sat-out player no hole-card
    // row ever appears, and the old unconditional setInterval polled Supabase
    // every 5s forever — x6 tables in MultiTablePage. The poll now stops
    // after ~2 minutes without a recovery; every HAND_STARTED re-arms a fresh
    // bounded cycle, so a player who gets dealt in is always covered.
    const MAX_POLL_ATTEMPTS = 24;
    let pollAttempts = 0;
    const startPolling = () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
      pollAttempts = 0;
      fetchExistingHand();
      retryTimer = setTimeout(fetchExistingHand, 2000);
      pollTimer = setInterval(() => {
        if (heroCardsRecoveredRef.current || ++pollAttempts > MAX_POLL_ATTEMPTS) {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        fetchExistingHand();
      }, 5000);
    };
    startPolling();
    // Expose so HAND_STARTED can re-arm the fetch for the new hand.
    heroCardFetchRef.current = () => {
      if (!cancelled) {
        // New hand: re-arm recovery so the bounded poll runs again.
        heroCardsRecoveredRef.current = false;
        startPolling();
      }
    };
    return () => {
      cancelled = true;
      heroCardFetchRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [tableId, userId]);

  // Phase 1.1 PR-5 (NO-GO-2): Migrated from subscribeToHandState (deleted)
  // to the engine WebSocket EVENT channel. Regular hand-state updates now
  // flow through mapEngineSnapshot + setTableState above. This effect
  // handles only the transient EVENT payloads: insurance_offers, rit_*,
  // time_bank_*, bbj_*, all_in_equity, rabbit_hunt_available.
  useEffect(() => {
    if (!tableId) return;
    const handState = engineLastEvent;
    if (!handState) return;
    // IIFE so the existing event-type early-return pattern still works
    // without the enclosing useEffect continuing to regular-state code
    // (that code has been deleted — mapEngineSnapshot owns game state).
    (() => {
      // ═══════════════════════════════════════════════════════════════════════
      // FIX 89: Dispatch server Realtime event types.
      // The server sends different event types on the same hand-state channel:
      // - Regular hand state: players, stage, community_cards, etc.
      // - insurance_offers: insurance offer data for InsuranceModal
      // - all_in_equity: equity percentages for all-in display
      // ═══════════════════════════════════════════════════════════════════════
      const eventType = handState.type as string | undefined;

      // Dan 2026-08-15 (item 3): the server now emits the hand_history row id
      // at the instant the row is written (ServerTableEngineSettlement,
      // postHandTasks). Capture it so Replay opens THIS hand.
      //
      // The lazy "fetch my most recent hand when the panel opens" fallback
      // below still exists for players who joined mid-session and have not
      // seen a hand finish yet, but it races the insert — tapping Replay
      // straight after a hand could return the PREVIOUS hand. This event is
      // authoritative and arrives before the player can realistically tap.
      if (eventType === 'hand_history_saved') {
        const savedId = handState.hand_id as string | undefined;
        if (savedId) setLastHandId(savedId);
        return;
      }

      if (eventType === 'insurance_offers') {
        // Server insurance offers — show InsuranceModal with server-calculated data
        const serverOffers = handState.offers as any[];
        if (!serverOffers || serverOffers.length === 0) return;

        // Find the offer for the current hero player
        const heroOffer = serverOffers.find((o: any) => o.playerId === userId);
        if (heroOffer) {
          // Map server offer format to InsuranceModal's InsuranceOffer format
          setInsuranceOffer({
            maxCoverage: heroOffer.fullInsuredAmount || heroOffer.insuredAmount || 0,
            equityPercent: heroOffer.equity || 50,
            premiumRate:
              heroOffer.fullPremium && heroOffer.fullInsuredAmount
                ? heroOffer.fullPremium / heroOffer.fullInsuredAmount
                : 0.2,
            potAmount: (handState.pot as number) || 0,
            yourStack: 0, // All-in — stack is 0
            opponentStack: 0,
            yourCards: [], // Cards already displayed on table
            board: [],
          });
          setShowInsurance(true);
          // The engine publishes how long the offer stands; honour it.
          const insSecs = Number((handState as Record<string, unknown>).timeoutSeconds) || 15;
          setDecisionDeadline({ kind: 'insurance', at: Date.now() + insSecs * 1000 });
        }
        return; // Don't process as regular state
      }

      // FIX 96: RIT offer — show prompt to chooser or wait for chooser's decision
      if (eventType === 'rit_offer') {
        const chooserId = handState.chooserPlayerId as string;
        const allPlayerIds = handState.allPlayerIds as string[];
        const maxRuns = (handState.maxRuns as number) || 2;

        // Only show to all-in players involved in the RIT offer
        if (!userId || !allPlayerIds?.includes(userId)) return;

        if (userId === chooserId) {
          // This user is the CHOOSER (best hand) — show 1/2/3 options, 5 second timer
          setRitIsChooser(true);
          setRitMaxRuns((maxRuns === 3 ? 3 : 2) as 2 | 3);
          setRitPlayerCount(allPlayerIds.length);
          setRitTimer(5); // Chooser gets 5 seconds per Dan's rules
          setShowRIT(true);
          setDecisionDeadline({ kind: 'rit', at: Date.now() + 5000 });
        }
        // Non-choosers wait for rit_chooser_decided event
        return;
      }

      // FIX 96: Chooser decided — show accept/decline to other players
      if (eventType === 'rit_chooser_decided') {
        const chooserId = handState.chooserPlayerId as string;
        const chosenRuns = handState.chosenRuns as number;
        const waitingFor = handState.waitingFor as string[];

        if (!userId || userId === chooserId) return;
        if (!waitingFor?.includes(userId)) return;

        setRitIsChooser(false);
        setRitChosenRuns((chosenRuns === 3 ? 3 : 2) as 2 | 3);
        // 2026-08-18: resolve to a display name HERE - this string renders
        // verbatim in the responder prompt, and passing the raw chooserId
        // showed players a UUID instead of who is asking to run it twice.
        setRitOpponent(
          tableStateRef.current?.players?.find((pp) => pp?.id === chooserId)?.name || 'Player'
        );
        setRitTimer(10); // Others get 10 seconds
        setShowRIT(true);
        return;
      }

      // FIX 97 → 2026-08-18: RIT result — show the boards and payouts. The
      // extra boards exist ONLY in this event (they never enter the engine's
      // community-card state), so discarding it meant players watched the
      // pot ship with no runout shown. Auto-dismisses before the next hand
      // gets going; tap/OK dismisses sooner.
      if (eventType === 'rit_result') {
        setShowRIT(false);
        const boards = (handState.boards as string[][]) || [];
        const distribution = (handState.distribution as Record<string, number>) || {};
        const pots = (handState.pots as Array<{ amount: number }>) || [];
        if (boards.length >= 2) {
          setRitResult({
            runs: (handState.runs as number) || boards.length,
            boards,
            distribution,
            perBoardWinners: (handState.per_board_winners as string[][]) || undefined,
            potTotal: pots.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
          });
          if (ritResultTimerRef.current) clearTimeout(ritResultTimerRef.current);
          ritResultTimerRef.current = setTimeout(() => setRitResult(null), 12_000);
        }
        return;
      }

      // FIX 124: Player timed out without time bank — show buy-more popup if depleted
      // FIX 126: All time bank toasts auto-dismiss after 2500ms + relay to other tables via BroadcastChannel
      if (eventType === 'time_bank_timeout') {
        const targetPlayer = handState.player_id as string;
        if (targetPlayer === userId) {
          const showBuyMore = handState.show_buy_more as boolean;
          const timedOutAction = handState.timed_out_action as string;
          if (showBuyMore) {
            // Player has ZERO time banks left — prompt to buy more
            toast.warning(
              `You were auto-${timedOutAction === 'check' ? 'checked' : 'folded'} , no time banks remaining. Visit the Diamond Store to purchase more!`,
              2500
            );
          } else {
            toast.info(
              `You were auto-${timedOutAction === 'check' ? 'checked' : 'folded'} (time expired)`,
              2500
            );
          }
          // FIX 126: Relay to other open table tabs so multi-table players see it everywhere
          try {
            timeBankChannelRef.current?.postMessage({
              type: 'time_bank_timeout',
              showBuyMore,
              timedOutAction,
            });
          } catch (e) {
            reportError(e, 'TablePage');
            /* BroadcastChannel not supported or closed */
          }
        }
        return;
      }

      // FIX 125: Low time bank warning — alert when down to last 5 (includes 0 = just used last one)
      // FIX 126: 2500ms auto-dismiss + multi-table relay
      if (eventType === 'time_bank_low') {
        const targetPlayer = handState.player_id as string;
        if (targetPlayer === userId) {
          const usesLeft = handState.uses_remaining as number;
          if (usesLeft <= 0) {
            toast.warning(
              `That was your last time bank! Visit the Diamond Store to purchase more.`,
              2500
            );
          } else {
            toast.warning(
              `Warning: Only ${usesLeft} time bank${usesLeft === 1 ? '' : 's'} remaining!`,
              2500
            );
          }
          // FIX 126: Relay to other open table tabs
          try {
            timeBankChannelRef.current?.postMessage({ type: 'time_bank_low', usesLeft });
          } catch (e) {
            reportError(e, 'TablePage');
            /* BroadcastChannel not supported or closed */
          }
        }
        return;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // FIX 128: Bad Beat Jackpot event handlers
      // Server sends bbj_hit first (with hand names), then bbj_payout_complete (with dollar amounts)
      // We store the hit data in a ref, then combine with payout data to show the celebration overlay.
      // ═══════════════════════════════════════════════════════════════════════
      if (eventType === 'bbj_hit') {
        // FIX 128: BBJ hit detected — store hand names silently.
        // DO NOT trigger celebration yet. The server sends bbj_hit during HAND_COMPLETE
        // processing, but we need to let the showdown animation finish before showing
        // the celebration overlay. The actual celebration triggers on bbj_payout_complete
        // (which arrives after postHandTasks DB writes — a natural 1-3s delay).
        const loserData = handState.loser as { userId: string; hand: { name: string } };
        const winnerData = handState.winner as { userId: string; hand: { name: string } };
        bbjHitDataRef.current = {
          loserUserId: loserData?.userId || '',
          loserHandName: loserData?.hand?.name || 'Unknown',
          winnerUserId: winnerData?.userId || '',
          winnerHandName: winnerData?.hand?.name || 'Unknown',
          qualifyingHandLabel: (handState.qualifyingHandLabel as string) || '',
        };
        // Don't show toast or HUD hit yet — wait for payout_complete after showdown finishes
        return;
      }

      // NEAR-MISS 2026-08-18: someone made a qualifying losing hand and missed
      // the jackpot on exactly one condition. Teaches the rule in the moment.
      if (eventType === 'bbj_near_miss') {
        const nmUser = handState.user_id as string;
        const nmMessage = handState.message as string;
        if (nmMessage) {
          // The player who held the hand gets the personal framing; the rest
          // of the table sees it happened (jackpot awareness) without noise.
          toast.info(
            nmUser === userId ? nmMessage : nmMessage.replace('So close!', 'Bad Beat Jackpot:'),
            4000
          );
        }
        return;
      }

      if (eventType === 'bbj_payout_complete') {
        // FIX 128: BBJ payout calculated — NOW show the celebration.
        // This event arrives from postHandTasks() which runs AFTER the hand is fully complete,
        // AFTER showdown cards are displayed, AFTER winners are shown.
        // Add a 3-second delay so players can see the winning/losing hands before the overlay.
        const totalPayout = (handState.totalPayout as number) || 0;
        const loserPayout = handState.loser as { userId: string; share: number };
        const winnerPayout = handState.winner as { userId: string; share: number };
        const tblShare = (handState.tableShare as number) || 0;
        const perPlayer = (handState.perPlayerShare as number) || 0;
        const tablePlayerIds = (handState.tablePlayerIds as string[]) || [];
        const updatedStacks =
          (handState.updatedStacks as Array<{ userId: string; stack: number }>) || [];

        // Update local player stacks immediately (so stacks reflect BBJ payout)
        if (updatedStacks.length > 0) {
          setTableState((prev) => ({
            ...prev,
            players: prev.players.map((p) => {
              if (!p) return p;
              const updated = updatedStacks.find((s) => s.userId === p.id);
              return updated ? { ...p, stack: updated.stack } : p;
            }),
          }));
        }

        // Delay celebration overlay by 3s so showdown cards + winner display are visible first
        // CA-21: track so unmount can cancel — prevents setBbjCelebrationData/setShowBBJ on dead page
        if (bbjTimerRef.current) clearTimeout(bbjTimerRef.current);
        bbjTimerRef.current = setTimeout(() => {
          bbjTimerRef.current = null;
          // Resolve usernames from current player list at time of display
          const resolveUsername = (uid: string): string => {
            const player = tableState.players.find((p) => p && p.id === uid);
            return player?.name || `Player`;
          };

          // Use hit data for hand names (stored from prior bbj_hit event)
          const hitData = bbjHitDataRef.current;

          setBbjCelebrationData({
            totalPayout,
            loser: {
              userId: loserPayout?.userId || hitData?.loserUserId || '',
              username: resolveUsername(loserPayout?.userId || hitData?.loserUserId || ''),
              share: loserPayout?.share || 0,
              handName: hitData?.loserHandName || 'Unknown',
            },
            winner: {
              userId: winnerPayout?.userId || hitData?.winnerUserId || '',
              username: resolveUsername(winnerPayout?.userId || hitData?.winnerUserId || ''),
              share: winnerPayout?.share || 0,
              handName: hitData?.winnerHandName || 'Unknown',
            },
            tableShare: tblShare,
            perPlayerShare: perPlayer,
            tablePlayerCount: tablePlayerIds.length,
            // Per-variant qualifying rule from the server bbj_hit event —
            // shown in the celebration so players see WHAT hit (2026-08-18).
            qualifyingLabel: hitData?.qualifyingHandLabel || '',
            // Personalized line: what YOU just won (2026-08-18). Zero for
            // observers who weren't dealt in.
            heroShare:
              userId === (loserPayout?.userId || hitData?.loserUserId)
                ? loserPayout?.share || 0
                : userId === (winnerPayout?.userId || hitData?.winnerUserId)
                  ? winnerPayout?.share || 0
                  : userId && tablePlayerIds.includes(userId)
                    ? perPlayer
                    : 0,
          });

          // NOW trigger the HUD hit animation + full celebration overlay
          setShowBBJ(true);
          setShowBBJCelebration(true);

          // Per-seat gold floats for every SEATED recipient (updatedStacks is
          // exactly the set the engine credited at the table).
          const shareForSeat = (uid: string): number =>
            uid === (loserPayout?.userId || hitData?.loserUserId)
              ? loserPayout?.share || 0
              : uid === (winnerPayout?.userId || hitData?.winnerUserId)
                ? winnerPayout?.share || 0
                : tablePlayerIds.includes(uid)
                  ? perPlayer
                  : 0;
          const credits: Record<string, number> = {};
          for (const su of updatedStacks) {
            const amt = shareForSeat(su.userId);
            if (amt > 0) credits[su.userId] = amt;
          }
          if (Object.keys(credits).length > 0) {
            setBbjSeatCredits(credits);
            if (bbjSeatCreditsTimerRef.current) clearTimeout(bbjSeatCreditsTimerRef.current);
            bbjSeatCreditsTimerRef.current = setTimeout(() => {
              bbjSeatCreditsTimerRef.current = null;
              setBbjSeatCredits({});
            }, 4500);
          }

          // Phase E: Notify all table players via in-app Notifications tab
          if (userId && userId !== 'guest') {
            notificationService
              .create({
                userId,
                type: 'bonus',
                title: 'Bad Beat Jackpot Hit!',
                message: `The BBJ paid out a total of $${totalPayout.toLocaleString()} at ${tableState.tableName}!`,
                metadata: { tableId: tableId || '', totalPayout },
              })
              .catch(() => {
                /* non-critical */
              });
          }

          // Clear the hit ref
          bbjHitDataRef.current = null;
        }, 3000); // 3s delay — lets showdown cards + winner chips animation play out

        return;
      }

      if (eventType === 'all_in_equity') {
        // All-in equity percentages — update equity display overlay
        const equities = handState.equities as Array<{
          userId: string;
          username: string;
          equity: number;
          seat: number;
        }>;
        if (equities && equities.length > 0) {
          setAllInEquities(equities);
        }
        return; // Don't process as regular state
      }

      // Seven-Deuce bounty: a player won a post-flop pot holding 7-2 and
      // collected a bounty from every other dealt-in player. Announce it (the
      // winner's seat is already highlighted by the POT_WIN banner this hand);
      // the bounty-adjusted stacks arrive via the follow-up state broadcast.
      if (eventType === 'seven_deuce_bounty') {
        const collected = Number((handState as any).total_collected ?? 0);
        const amountLabel = `$${collected.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
        setAnnouncement({ type: 'seven_deuce_bounty', data: { amount: amountLabel } });
        return;
      }

      // Rabbit Hunt: Server sends remaining deck cards after hand completes
      if (eventType === 'rabbit_hunt_available') {
        const rabbitCards = (handState.rabbit_cards as any[]) || [];
        if (rabbitCards.length > 0 && heroFoldedInCurrentHandRef.current) {
          // Convert server card format (hearts/diamonds/clubs/spades) to client shorthand (h/d/c/s)
          const suitMap: Record<string, 'h' | 'd' | 'c' | 's'> = {
            hearts: 'h',
            diamonds: 'd',
            clubs: 'c',
            spades: 's',
            h: 'h',
            d: 'd',
            c: 'c',
            s: 's',
          };
          const converted = rabbitCards.map((c: any) => ({
            rank: String(c.rank),
            suit: suitMap[c.suit] || 'h',
          }));
          serverRabbitCardsRef.current = converted;
          setIsRabbitAvailable(true);
        }
        return;
      }

      // Phase 1.1 PR-5: the 270-line "regular hand state" block that used to
      // live here was the OLD Supabase Realtime path that duplicated what
      // mapEngineSnapshot (above, useEffect on engineSnapshot) now does via
      // the engine native WebSocket. Rule 12c: deleted in same PR as the
      // subscribeToHandState switch-flip.
    })();
  }, [engineLastEvent, tableId, userId]);

  const [showSettings, setShowSettings] = useState(false);
  const [showShareHand, setShowShareHand] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  const [showSessionStats, setShowSessionStats] = useState(false);
  const [sharedHandData, setSharedHandData] = useState<any>(null);

  // Real Name vs Alias
  const [useRealName, setUseRealName] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME) === 'true';
  });
  const [heroProfile, setHeroProfile] = useState<{ username: string; display_name: string } | null>(
    null
  );

  // Sync settings when changed from other components (like TableMenu)
  useMasterBusSubscription('SETTINGS_CHANGED', (event: any) => {
    if (event.setting === 'useRealName') {
      setUseRealName(event.value);
    }
  });

  // Fetch Hero profile just once if needed
  useEffect(() => {
    if (userId && userId !== 'guest') {
      supabase
        .from('profiles')
        .select('username, display_name')
        .eq('id', userId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setHeroProfile({
              username: data.username || '',
              display_name: data.display_name || '',
            });
          }
        });
    }
  }, [userId]);

  // Load table info from Supabase on mount
  useEffect(() => {
    let isMounted = true;
    async function loadTableInfo() {
      if (!tableId) return;

      const { data: table, error } = await supabase
        .from('tables')
        .select(
          'id, name, game_variant, game_type, tournament_id, stakes, small_blind, big_blind, max_players, club_id, action_time_seconds, straddle_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board'
        )
        .eq('id', tableId)
        .maybeSingle();

      if (table && !error) {
        setTableState((prev) => ({
          ...prev,
          tableId: table.id,
          tableName: table.name || 'Poker Table',
          gameType: (table.game_variant || table.game_type || 'NLH') as any,
          isTournament: table.game_type === 'tournament' || !!table.tournament_id,
          tournamentId: table.tournament_id || undefined,
          blinds:
            table.stakes &&
            table.stakes !== 'undefined/undefined' &&
            !table.stakes.includes('undefined')
              ? table.stakes
              : table.small_blind != null && table.big_blind != null
                ? `${table.small_blind}/${table.big_blind}`
                : '?/?',
          maxPlayers: table.max_players || 6,
          players: createEmptySeats(table.max_players || 6),
          positions: Array(table.max_players || 6).fill(null),
          lastActions: Array(table.max_players || 6).fill(null),
          lastBetAmounts: Array(table.max_players || 6).fill(0),
        }));

        // The engine refuses toggleStraddle outright when the table has
        // straddles turned off ('Straddles are not enabled at this table'), so
        // the control must know the table setting or it offers players a switch
        // that can only ever fail.
        setTableStraddleEnabled(table.straddle_enabled === true);
        setBombPotRules(
          (table as any).bomb_pot_enabled === true
            ? {
                enabled: true,
                frequency: Number((table as any).bomb_pot_frequency) || 0,
                anteBB: Number((table as any).bomb_pot_ante_multiplier) || 0,
                doubleBoard: (table as any).bomb_pot_double_board === true,
              }
            : null
        );

        // Store actual club_id for persistence and rake
        actualClubIdRef.current = table.club_id || '';
        setActualClubIdLoaded(true); // Signal observer chat permission check
        setActionTimeSeconds(table.action_time_seconds || 15);

        // Fetch club name (and the union it belongs to) for the felt masthead.
        // Dan 2026-08-18: the union name must sit next to the club name when
        // the club is attached to one. Joined in the same query rather than a
        // follow-up round trip.
        if (table.club_id) {
          supabase
            .from('clubs')
            .select('name, unions:union_id (name)')
            .eq('id', table.club_id)
            .maybeSingle()
            .then(async ({ data: clubData }) => {
              if (!clubData?.name) return;
              const rawUnion = (clubData as { unions?: { name?: string } | { name?: string }[] })
                .unions;
              const unionName = Array.isArray(rawUnion) ? rawUnion[0]?.name : rawUnion?.name;
              // Dan 2026-08-20: fleet tables hang off the union's own hub club,
              // which shares the union's name — the masthead read
              // "MIDWAY UNION • MIDWAY UNION". The club slot should carry the
              // club the PLAYER is inside of (their current club), with the
              // union next to it. Fall back to the table's own club, and never
              // print the same name twice.
              let clubName: string | undefined = clubData.name;
              const viewerClubId = useUserStore.getState().currentClubId;
              if (
                unionName &&
                clubName === unionName &&
                viewerClubId &&
                viewerClubId !== table.club_id
              ) {
                const { data: viewerClub } = await supabase
                  .from('clubs')
                  .select('name')
                  .eq('id', viewerClubId)
                  .maybeSingle();
                if (viewerClub?.name) clubName = viewerClub.name;
              }
              if (unionName && clubName === unionName) {
                // Still identical (no distinct viewer club) — show it once.
                clubName = undefined;
              }
              setTableState((prev) => ({
                ...prev,
                clubName,
                unionName: unionName || undefined,
              }));
            });
        }

        // ─── Load bounty data for KO/PKO tournaments ───
        if (table.tournament_id) {
          const { data: tournData } = await supabase
            .from('tournaments')
            .select(
              'is_bounty, is_pko, is_mystery_bounty, bounty_amount, spin_multiplier, spin_locked_tiers, buy_in_amount, buy_in_fee, max_players, status, blind_structure, current_level, level_started_at, started_at, variant, tournament_type'
            )
            .eq('id', table.tournament_id)
            .maybeSingle();

          // ─── Resolve initial tournament blind level ───
          // Tournament tables don't have static small_blind/big_blind columns —
          // blinds come from the blind_structure array at current_level.
          if (tournData) {
            const blindStructure = tournData.blind_structure as Array<{
              level?: number;
              smallBlind?: number;
              small_blind?: number;
              bigBlind?: number;
              big_blind?: number;
              ante?: number;
              duration?: number;
              duration_minutes?: number;
              durationMinutes?: number;
            }> | null;
            // LEVEL INDEXING 2026-08-21: tournaments.current_level is a
            // 0-BASED INDEX into blind_structure (engine convention: the
            // active entry is struct[current_level], whose 'level' field is
            // current_level + 1). The old code treated it as the 1-based
            // display number: the masthead read "Level 1" during level 2,
            // and at tournament start entryFor(0) fell through to
            // struct[-1] = undefined, so there was NO level clock at all
            // until the first level-up.
            const levelIdx = Number(tournData.current_level ?? 0);
            const currentLevel = levelIdx + 1; // display number
            blindStructRef.current = blindStructure || [];
            const entryAt = (idx: number) => {
              const struct = blindStructure || [];
              if (struct.length === 0) return undefined;
              return (
                struct[Math.min(Math.max(idx, 0), struct.length - 1)] ||
                struct.find((bl) => bl.level === idx + 1)
              );
            };
            const levelEntry = entryAt(levelIdx);
            const durSec = levelEntry
              ? Number(levelEntry.duration) ||
                (Number(levelEntry.duration_minutes ?? levelEntry.durationMinutes) || 0) * 60
              : 0;
            if (durSec > 0) {
              const startedAtMs = tournData.level_started_at
                ? Date.parse(tournData.level_started_at as string)
                : Date.now();
              setLevelClock({
                startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
                durationSec: durSec,
              });
            }
            const fmt =
              String(tournData.variant ?? '').toLowerCase() === 'spin' ||
              String(tournData.tournament_type ?? '').toUpperCase() === 'SPIN'
                ? ('spin' as const)
                : String(tournData.tournament_type ?? '').toUpperCase() === 'SNG'
                  ? ('sng' as const)
                  : ('mtt' as const);
            setTournamentFormat(fmt);
            // Seat-first = a Spin (3 seats) or a Heads-Up (2 seats) that has
            // not started. Once it is RUNNING the seats are no longer for
            // sale and the normal tournament table rules apply.
            {
              const maxP = Number(tournData.max_players ?? 0);
              const openForSeats =
                String(tournData.status ?? '') === 'REGISTERING' ||
                String(tournData.status ?? '') === 'ANNOUNCED';
              const isSeatFirst = fmt === 'spin' || maxP <= 2;
              if (isSeatFirst && openForSeats) {
                const cost =
                  Number(tournData.buy_in_amount ?? 0) + Number(tournData.buy_in_fee ?? 0);
                setSeatFirstBuyIn({
                  cost,
                  seats: maxP || (fmt === 'spin' ? 3 : 2),
                  label: fmt === 'spin' ? 'Spin' : 'Heads Up',
                });
              } else {
                setSeatFirstBuyIn(null);
              }
            }
            if (blindStructure && blindStructure.length > 0) {
              if (levelEntry) {
                const sb = levelEntry.smallBlind ?? levelEntry.small_blind ?? 0;
                const bbl = levelEntry.bigBlind ?? levelEntry.big_blind ?? 0;
                if (sb > 0 && bbl > 0) {
                  setTableState((prev) => ({
                    ...prev,
                    blinds: `${sb}/${bbl}`,
                    currentLevel,
                  }));
                }
              }
            }
          }

          if (
            tournData &&
            (tournData.is_bounty || tournData.is_pko || tournData.is_mystery_bounty)
          ) {
            // Load current bounty values for all players in this tournament
            const { data: bountyData } = await supabase
              .from('tournament_players')
              .select('user_id, current_bounty')
              .eq('tournament_id', table.tournament_id)
              .gt('current_bounty', 0);

            const bMap: Record<string, number> = {};
            if (bountyData) {
              bountyData.forEach((p: any) => {
                bMap[p.user_id] = p.current_bounty;
              });
            }
            setTableState((prev) => ({
              ...prev,
              bountyMap: bMap,
              isBountyTournament: true,
              spinMultiplier: tournData.spin_multiplier || undefined,
            }));

            // Subscribe to real-time bounty updates (store in ref for cleanup)
            const bountyChannelKey = `bounty-${table.tournament_id}`;

            if (!isMounted) return;
            const bountyChannel = masterBus.getOrCreateChannel(bountyChannelKey);
            bountyChannel
              .on(
                'postgres_changes',
                {
                  event: 'UPDATE',
                  schema: 'public',
                  table: 'tournament_players',
                  filter: `tournament_id=eq.${table.tournament_id}`,
                },
                (payload: any) => {
                  if (payload.new) {
                    const { user_id, current_bounty } = payload.new;
                    setTableState((prev) => ({
                      ...prev,
                      bountyMap: {
                        ...prev.bountyMap,
                        [user_id]: current_bounty || 0,
                      },
                    }));
                  }
                }
              )
              .subscribe((status: string, err?: Error) => {
                if (status === 'CHANNEL_ERROR') {
                  console.debug('[TablePage] Realtime channel error:', err?.message || err);
                }
                if (status === 'TIMED_OUT') {
                  console.debug('[TablePage] Realtime channel timed out');
                }
              });
            bountyChannelRef.current = bountyChannel;
          } else if (tournData?.spin_multiplier) {
            setTableState((prev) => ({
              ...prev,
              spinMultiplier: tournData.spin_multiplier,
            }));
          }

          // ── SPIN WHEEL (2026-08-20, Dan) ──────────────────────────────────
          // In a Spin the DRAW is the product — the seconds deciding whether
          // you play for 2x or 100x are why the format exists. We used to skip
          // it entirely: the table simply opened with a multiplier already
          // stamped on the tournament name.
          //
          // The multiplier is a SERVER fact (crypto-grade draw at creation),
          // so every seat receives the same value and the wheel is told where
          // to stop. Nothing is decided on the client, and all three players
          // watch the same result land at the same moment.
          //
          // Shown once per table visit, gated on sessionStorage so a reconnect
          // mid-tournament does not replay a draw that already happened.
          if (tournData?.spin_multiplier && tournData.spin_multiplier > 0) {
            const seenKey = `ca_spin_seen:${table.tournament_id}`;
            let alreadySeen = false;
            try {
              alreadySeen = sessionStorage.getItem(seenKey) === '1';
            } catch {
              /* storage unavailable — show it, a repeat beats never seeing it */
            }
            // sessionStorage is per-TAB, so a fresh tab used to replay a draw
            // from minutes ago as if it were happening now — a fake reveal of
            // an old result, which is the same dishonesty as the spoiler in
            // the other direction. The draw happens at start, so the wheel is
            // only a live moment within ~90s of started_at; after that the
            // persistent badge is the record and the wheel stays down.
            const startedAtMs = tournData.started_at ? Date.parse(tournData.started_at) : NaN;
            const drawIsFresh = Number.isFinite(startedAtMs)
              ? Date.now() - startedAtMs < 90_000
              : true; // no started_at (older rows): keep the old behaviour
            /**
             * FALLBACK ONLY (Dan 2026-08-21). The wheel is now driven by the
             * engine's SPIN_REVEAL broadcast so every seat sees one shared
             * moment. This DB-derived path remains for a client that was not
             * connected when the event went out — a refresh mid-reveal, or a
             * socket that reconnected a second late. It marks the same
             * sessionStorage key the event handler uses, so whichever arrives
             * first wins and the wheel never plays twice.
             */
            const sharedKey = `spin-reveal-${table.tournament_id}`;
            let sharedAlreadyShown = false;
            try {
              sharedAlreadyShown = !!sessionStorage.getItem(sharedKey);
            } catch {
              /* private mode */
            }
            if (!alreadySeen && drawIsFresh && !sharedAlreadyShown) {
              try {
                sessionStorage.setItem(sharedKey, '1');
              } catch {
                /* ignore */
              }
              try {
                sessionStorage.setItem(seenKey, '1');
              } catch {
                /* ignore */
              }
              setSpinDraw({
                multiplier: Number(tournData.spin_multiplier),
                buyIn: Number(tournData.buy_in_amount) || 0,
                tiers: DEFAULT_SPIN_TIERS,
                // The tiers the Reserve Pool could not fund AT THE MOMENT OF
                // THIS DRAW, recorded on the row by fn_spin_draw_multiplier.
                // SpinWheel had rendered locked segments, shipped the CSS and
                // been tested since the day it was written; nothing had ever
                // passed the value, so the feature was dead on arrival.
                // Older Spins have no column value and simply show none.
                lockedTiers: parseLockedTiers(tournData.spin_locked_tiers),
              });
            }
          }
        }

        // Subscribe to tournament break + add-on events via Realtime
        if (table.tournament_id) {
          const breakChanKey = `t-break-${table.tournament_id}`;

          if (!isMounted) return;

          /* ── Leaving a finished tournament: ONE implementation, TWO events ──
             Dan 2026-08-20: "at the end of the tournament when you lose, you
             need to be auto removed from the table, placed inside the lobby
             and your tournament result card shown … winners should be auto
             removed at the end as well."

             This used to be declared INSIDE the `player_eliminated` branch,
             which is why only the losing half of that sentence worked: the
             winner's exit had no function to call. It is hoisted to the
             subscription scope so `tournament_winner` can use the identical
             path — same payload, same card, same navigation — rather than a
             second copy that drifts from this one.

             `exitStarted` lives here, at the lifetime of the subscription, so
             a duplicate or retried broadcast cannot schedule two navigations.
             A player finishes a tournament exactly once.

             ── AUDIT 2026-08-22: this did not actually LEAVE the table ──
             It published the card and navigated, and that was all. Every
             manual leave in this file sends four more signals, and none of
             them fired for a tournament finisher:

               SESSION_ENDED            nothing closed the session
               clearPlayingAt(userId)   "Playing At" still pointed at a table
                                        the engine had already closed
               TABLE_LEFT               the tab stayed open
               CLOSE_TABLE_TAB          ditto — MultiTablePage subscribes to
                                        both and each removes the tab

             So Dan's "you kick the current players ... and move them to the
             lobby" half-happened: the player was navigated away while the
             finished table sat in their tab bar and their status said they
             were still sitting at it.

             ── AND THE NAVIGATE WAS ACTIVELY DESTRUCTIVE IN MULTI-TABLE ──
             TablePage runs as up to FOUR embedded instances inside
             MultiTablePage. An unconditional `navigate('/clubs/...')` from one
             of them tears down the whole container, taking the other three
             LIVE tables with it — bust out of a three-minute Spin on tab 2 and
             your cash games are yanked off the screen mid-hand.

             In multi-table mode the signals ARE the exit: MultiTablePage
             removes just that tab and calls goToLobby() itself only when it
             was the last one. Single-table mode has no such subscriber, so it
             still navigates here. */
          let exitStarted = false;

          const goToLobbyWithResult = (position: number, prize: number, delayMs: number) => {
            if (exitStarted) return;
            exitStarted = true;

            const tid = table.tournament_id || tableStateRef.current.tournamentId;

            /* Held so the effect's cleanup can cancel it. Without that, a
               player who closes this tab (or is moved off it) inside the 7s
               winner beat is force-navigated out of wherever they went next —
               which, in multi-table, is somebody else's live table. */
            tournamentExitTimerRef.current = setTimeout(() => {
              void (async () => {
                const full = tid ? await fetchTournamentResult(tid, userId) : undefined;
                publishSessionSummary({
                  duration: Math.floor((Date.now() - sessionStartRef.current) / 1000),
                  handsPlayed: handsPlayedRef.current,
                  handsWon: handsWonRef.current,
                  totalRebuys: totalRebuysRef.current,
                  profitLoss: 0,
                  biggestPot: biggestPotRef.current,
                  peakStack: peakStackRef.current,
                  tableName: tableStateRef.current.tableName,
                  sessionStart: sessionStartRef.current,
                  sessionEnd: Date.now(),
                  /* Parity with the cash summary (#243). A tournament finisher
                     bought in too, and played a measurable session; there is no
                     reason their card should know less about it than a cash
                     player's does. */
                  vpipPercent:
                    handsPlayedRef.current > 0
                      ? Math.round((vpipCountRef.current / handsPlayedRef.current) * 100)
                      : 0,
                  totalBuyIn: totalBuyInRef.current,
                  tournament: {
                    ...(full ?? {
                      entrants: null,
                      bountyWinnings: 0,
                      knockouts: 0,
                      rebuys: 0,
                      addOns: 0,
                      prize: 0,
                      finishPlace: null,
                    }),
                    name: full?.name || tableStateRef.current.tableName || 'Tournament',
                    /* The broadcast is authoritative for these two: it is what
                       the engine just decided, whereas the row may not have
                       been written yet when we read it. */
                    finishPlace: position || full?.finishPlace || null,
                    prize: prize || full?.prize || 0,
                  },
                });

                /* ── Now actually leave. ──
                   The same four signals, in the same order, as every manual
                   leave above. Emitted AFTER the publish so the card is
                   already handed to the app-root host before this instance
                   starts being torn down, and before the navigate so the
                   destination is deterministic — the ordering the manual path
                   settled on after three racing exits fought over it. */
                const seatAtExit = tableStateRef.current.heroSeat;
                heroSeatRef.current = 0;
                setTableState((prev) => ({ ...prev, heroSeat: 0 }));

                masterBus.emit('SESSION_ENDED', { tableId: tableId ?? '', userId });
                playerStatusService.clearPlayingAt(userId);
                masterBus.emit('TABLE_LEFT', { tableId: tableId ?? '', seat: seatAtExit });
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: tableId ?? '',
                  action: 'CLOSE_TABLE_TAB',
                });

                /* MultiTablePage owns the destination whenever it is mounted:
                   it removes this tab and calls its own goToLobby() only if
                   this was the last one. Navigating here as well would close
                   the other three tables.

                   The test is `embeddedTableId`, NOT `isMultiTable`. That prop
                   is a sound/UX flag — MultiTablePage passes
                   `tables.length > 1 || hidden`, so it is FALSE for a single
                   visible table even though the container is mounted and
                   subscribed to both signals above. Branching on it would
                   leave the commonest case with two navigators racing for the
                   destination (this one to the club, goToLobby() to the club
                   or '/'), which is the same race the manual leave path had to
                   be untangled from. `embeddedTableId` is set exactly when
                   this instance lives inside the container. */
                if (embeddedTableId) return;

                const clubId = actualClubIdRef.current;
                if (clubId) {
                  navigate(`/clubs/${clubId}`);
                } else {
                  // No club to land in (should not happen) — the old results
                  // page beats stranding them at a dead table.
                  navigate(`/tournament-results?id=${tid ?? ''}`);
                }
              })();
            }, delayMs);
          };

          const breakChan = masterBus.getOrCreateChannel(breakChanKey);
          breakChan
            .on('broadcast', { event: 'tournament_event' }, (payload: any) => {
              const data = payload.payload;
              if (data?.type === 'tournament_break' || data?.type === 'BREAK_START') {
                setTournamentBreak({
                  active: true,
                  timeRemaining:
                    (data.payload?.breakDurationMinutes || data.payload?.durationMinutes || 5) * 60,
                  nextLevel: data.payload?.nextLevel,
                });
              } else if (data?.type === 'break_ended' || data?.type === 'BREAK_END') {
                setTournamentBreak({ active: false, timeRemaining: 0 });
              } else if (data?.type === 'ADDON_PERIOD_START') {
                // Add-on period: 60 seconds, show popup to all players
                const addonData = data.payload || {};
                // Fetch fresh wallet balance
                (async () => {
                  try {
                    let walBal = 0;
                    if (userId && userId !== 'guest') {
                      walBal = await WalletService.getPlayerBalance(userId, { tableId });
                    }
                    // 2026-08-20: `addonData.addOnCost || 0` silently priced the
                    // add-on at ZERO whenever the broadcast omitted the field --
                    // which made canAfford unconditionally true and let players
                    // buy at a price the modal had never shown them. Fall back to
                    // the authoritative tournament row, and include the house fee
                    // that processAddOn charges on top.
                    let cost = Math.round(Number(addonData.addOnCost)) || 0;
                    let chips = Number(addonData.addOnChips) || 0;
                    let fee = Math.round(Number(addonData.addOnFee)) || 0;
                    if (!cost || !chips || !fee) {
                      const quote = await tournamentService.getChipPurchaseQuote(
                        table.tournament_id as string,
                        'addon'
                      );
                      if (quote) {
                        if (!cost) cost = quote.baseCost;
                        if (!chips) chips = quote.chips;
                        fee = quote.fee;
                      }
                    }
                    if (!cost) {
                      // Still no price. Opening the modal here would show
                      // "0 chips" over a live Accept button. Don't.
                      reportError(
                        new Error('ADDON_PERIOD_START with no resolvable add-on cost'),
                        'TablePage.Addon_period_missing_cost'
                      );
                      return;
                    }
                    setAddOnPeriod({
                      active: true,
                      addOnCost: cost,
                      addOnFee: fee,
                      addOnChips: chips,
                      walletBalance: walBal,
                      timeRemaining: 60,
                    });
                  } catch (e) {
                    reportError(e, 'TablePage.Addon_period_wallet_fetch_error');
                  }
                })();
              } else if (data?.type === 'ADDON_PERIOD_END') {
                setAddOnPeriod((prev) => ({ ...prev, active: false }));
              } else if (data?.type === 'hand_for_hand') {
                // Bubble mode — hand-for-hand play activated
                setTableState((prev) => ({
                  ...prev,
                  handForHand: data.payload?.active === true, // BUG-10 FIX: strict boolean check
                  bubbleInfo: data.payload
                    ? {
                        playersRemaining: data.payload.playersRemaining,
                        paidPositions: data.payload.paidPositions,
                      }
                    : undefined,
                }));
                if (data.payload?.active) {
                  setAnnouncement({ type: 'hand_for_hand', data: data.payload });
                  toast?.info?.('Hand-for-hand play activated - bubble approaching');
                }
              } else if (data?.type === 'final_table') {
                // DEAD-WIRING FIX 2026-08-15: the server has always broadcast
                // `final_table` (TournamentManager: once, when <= 9 players are
                // still 'playing'), and this switch had no case for it, so the
                // signal was dropped on the floor. FinalTableOverlay IS mounted
                // (TableModalsLayer) but listens for the bus event
                // FINAL_TABLE_REACHED, whose only emitter is
                // TournamentTimerService.checkTableSize -- a function with ZERO
                // callers anywhere in the repo. So reaching the final table,
                // the single biggest moment in a tournament, announced nothing.
                //
                // The broadcast carries only { playerCount }; the overlay wants
                // the seated field, so fetch it. Non-blocking: a failed fetch
                // must not swallow the announcement, so fall through to the
                // toast either way.
                {
                  const tid = tableStateRef.current.tournamentId;
                  const ftName = tableStateRef.current.tableName || 'Tournament';
                  if (tid) {
                    (async () => {
                      let ftPlayers: Array<{
                        userId: string;
                        username: string;
                        chips: number;
                      }> = [];
                      let prizePool = 0;
                      try {
                        const { data: rows } = await supabase
                          .from('tournament_players')
                          .select('user_id, username, chips')
                          .eq('tournament_id', tid)
                          .eq('status', 'playing')
                          .order('chips', { ascending: false });
                        ftPlayers = (rows || []).map(
                          (r: { user_id: string; username?: string; chips?: number }) => ({
                            userId: r.user_id,
                            username: r.username || 'Player',
                            chips: Number(r.chips) || 0,
                          })
                        );
                        const { data: trow } = await supabase
                          .from('tournaments')
                          .select('prize_pool')
                          .eq('id', tid)
                          .maybeSingle();
                        prizePool = Number(trow?.prize_pool) || 0;
                      } catch (e) {
                        reportError(e, 'TablePage.final_table_fetch');
                      }
                      try {
                        masterBus.emit('FINAL_TABLE_REACHED', {
                          tournamentId: tid,
                          tournamentName: ftName,
                          prizePool,
                          players: ftPlayers,
                        });
                      } catch {
                        /* bus publish is best-effort */
                      }
                    })();
                  }
                  toast?.success?.(
                    `Final table! ${data.payload?.playerCount ?? 9} players remain.`
                  );
                }
              } else if (data?.type === 'bubble_burst') {
                // Bubble burst — players are now in the money
                setTableState((prev) => ({
                  ...prev,
                  handForHand: false,
                  bubbleInfo: undefined,
                }));
                setAnnouncement({ type: 'bubble_burst', data: data.payload });
                toast?.success?.('Bubble burst - you are in the money!');
              } else if (data?.type === 'player_eliminated') {
                // A player was eliminated from the tournament
                const elimData = data.payload || {};

                /* AUDIT 2026-08-20: PLAYER_ELIMINATED had a listener and no
                   emitter. TournamentTimerService subscribes to it to re-check
                   table size after a bust — the trigger for merging short
                   tables and calling heads-up — and nothing in the codebase
                   ever sent it, so that check only ever ran on its own timer.
                   This broadcast IS the elimination; forward it. */
                try {
                  masterBus.emit('PLAYER_ELIMINATED', {
                    tournamentId: String(
                      table.tournament_id || tableStateRef.current.tournamentId || ''
                    ),
                    userId: String(elimData.userId || ''),
                    position: Number(elimData.position) || 0,
                    prize: Number(elimData.prize) || 0,
                    username: String(elimData.username || ''),
                  });
                } catch {
                  /* a bus publish must never break the elimination path */
                }
                console.debug(
                  `[TablePage] Player eliminated: ${elimData.userId?.slice(0, 8)} at position ${elimData.position}`
                );

                // DEAD-WIRING FIX 2026-08-15: heads-up never announced either.
                // HeadsUpOverlay is mounted in TableModalsLayer but listens for
                // HEADS_UP_SWITCH, whose only emitter is
                // TournamentTimerService.checkTableSize -- zero callers. Derive
                // it here: `position` is the finishing place, so the player who
                // busts in 3rd leaves exactly two behind.
                if (Number(elimData.position) === 3 && tableStateRef.current.tournamentId) {
                  const tid = tableStateRef.current.tournamentId;
                  (async () => {
                    try {
                      const { data: rows } = await supabase
                        .from('tournament_players')
                        .select('user_id, username, chips')
                        .eq('tournament_id', tid)
                        .eq('status', 'playing')
                        .order('chips', { ascending: false });
                      // Only announce if the field really is two-handed; a
                      // simultaneous double bust would make this a 3-way.
                      if (rows && rows.length === 2) {
                        const toP = (r: {
                          user_id: string;
                          username?: string;
                          chips?: number;
                        }) => ({
                          userId: r.user_id,
                          username: r.username || 'Player',
                          chips: Number(r.chips) || 0,
                        });
                        masterBus.emit('HEADS_UP_SWITCH', {
                          tournamentId: tid,
                          player1: toP(rows[0]),
                          player2: toP(rows[1]),
                        });
                      }
                    } catch (e) {
                      reportError(e, 'TablePage.heads_up_detect');
                    }
                  })();
                }

                // Check if the current user was eliminated
                if (elimData.userId === userId) {
                  // ── Dan 2026-08-20, from a live table ─────────────────────
                  // "at the end of the tournament when you lose, you need to
                  //  be auto removed from the table, placed inside the lobby
                  //  and your tournament result card shown … winners should
                  //  be auto removed at the end as well."
                  //
                  // The engine has already closed the busted seat (left_at is
                  // stamped in eliminatePlayer), so "removed from the table"
                  // is a navigation fact, not a server call. Both branches
                  // end the same way: the club lobby, with the result handed
                  // to the app-root summary host on the way out.
                  /* ── AUDIT 2026-08-20: this card had never once rendered ──
                     The result travelled in ROUTER STATE to `/clubs/:clubId`,
                     and the only component that reads it is ClubLobby, which
                     is `/clubs/:clubId/lobby`. `/clubs/:clubId` is
                     ClubHomePage. So the player was auto-removed and landed in
                     the lobby exactly as asked, and the result card was
                     silently dropped on arrival, every single time.

                     Router state was the wrong carrier anyway, for the reason
                     pendingSessionSummary already exists (see its header, and
                     App.tsx): "the lobby" is not one component — it is
                     HomePage OR ClubHomePage OR ClubLobby depending on where
                     the player came from. Publishing to the app-root host
                     instead means the card renders wherever they land, and it
                     survives the navigation that killed it before.

                     Publishing also carries the FULL result — entrants,
                     knockouts, bounties, rebuys — rather than the two numbers
                     that fit in the old state object, because
                     fetchTournamentResult is already written and the elimination
                     broadcast only knows position and prize.

                     2026-08-22: `goToLobbyWithResult` moved up to the
                     subscription scope so the `tournament_winner` branch below
                     shares this exact path. See the note at its declaration. */

                  /* AUDIT 2026-08-20: `=== 1` on a value that arrives as
                     untyped JSON over a realtime broadcast. The same handler
                     already coerces it two lines up (`Number(...) === 3`) and
                     again in the busted branch, so a string "1" would have
                     skipped the winner's celebration overlay and sent the
                     champion out on the 2.5s bust path. Coerce here too. */
                  if (Number(elimData.position) === 1) {
                    // Winner: let the celebration overlay play, then leave.
                    // BUG-G FIX: Use tableStateRef for fresh name (closure has 'Loading...')
                    const tournamentName = tableStateRef.current.tableName || 'Tournament';
                    setTournamentWinner({
                      prize: elimData.prize || 0,
                      name: tournamentName,
                    });
                    goToLobbyWithResult(1, elimData.prize || 0, 7000);
                  } else {
                    // Busted: a short beat so the elimination lands, then out.
                    // The result card in the lobby says everything the old
                    // toast said, in a place you can actually read it.
                    goToLobbyWithResult(
                      Number(elimData.position) || 0,
                      Number(elimData.prize) || 0,
                      2500
                    );
                  }
                }

                // Refresh seated players to reflect elimination
                if (elimData.userId) {
                  setTableState((prev) => ({
                    ...prev,
                    players: prev.players.map((seat: any) =>
                      seat?.id === elimData.userId ? { ...seat, status: 'eliminated' } : seat
                    ),
                  }));
                }
              } else if (data?.type === 'tournament_winner') {
                /* ── The champion's exit (2026-08-22) ─────────────────────
                   Dan 2026-08-20: "winners should be auto removed at the end
                   as well." Until now they never were, and it was not a bug
                   in this file — nothing was ever SENT. finishTournament
                   closed the tables, released the seats and stopped without
                   broadcasting, so the winner branch above (position === 1)
                   was unreachable: eliminatePlayer is only ever called with
                   places >= 2, by construction, precisely so that 1st stays
                   the winner's. The engine now emits `tournament_winner` from
                   finishTournament, and this is where it lands.

                   Its own event rather than `player_eliminated` with position
                   1 because TournamentPage and TournamentLobbyPage both raise
                   an elimination toast on that event — announcing the
                   champion as knocked out is worse than saying nothing.

                   Same 7s beat as the winner branch above, for the same
                   reason: the celebration overlay has to play before the
                   player is moved. */
                const winData = data.payload || {};
                if (winData.userId && winData.userId === userId) {
                  const prize = Number(winData.prize) || 0;
                  setTournamentWinner({
                    prize,
                    name: tableStateRef.current.tableName || 'Tournament',
                  });
                  goToLobbyWithResult(1, prize, 7000);
                }
              } else if (data?.type === 'table_rebalance') {
                // Players moved between tables — check if current user was moved
                console.debug('[TablePage] Table rebalance detected');
                (async () => {
                  try {
                    // BUG-G FIX: Use table.tournament_id (closure-safe local)
                    // instead of stale tableState.tournamentId
                    if (userId && table.tournament_id) {
                      const { data: playerData } = await supabase
                        .from('tournament_players')
                        .select('table_id')
                        .eq('tournament_id', table.tournament_id)
                        .eq('user_id', userId)
                        .maybeSingle();

                      if (playerData?.table_id && playerData.table_id !== tableId) {
                        // Current user was moved to a different table — redirect
                        console.debug(
                          `[TablePage] User moved from ${tableId} to ${playerData.table_id}`
                        );
                        navigate(`/table/${playerData.table_id}`); // FIX: was /clubs/:clubId/table/:tableId which is not a defined route
                      } else if (playerData?.table_id === tableId) {
                        // User stayed at this table — just refresh seats
                        setTableState((prev) => ({ ...prev, refreshTrigger: Date.now() }));
                      }
                    } else {
                      // Not a tournament or no user — just refresh
                      setTableState((prev) => ({ ...prev, refreshTrigger: Date.now() }));
                    }
                  } catch (err) {
                    reportError(err, 'TablePage.Error_checking_player_table_during_rebal');
                    // Fallback: just refresh seats
                    setTableState((prev) => ({ ...prev, refreshTrigger: Date.now() }));
                  }
                })();
              } else if (data?.type === 'late_reg_closed') {
                // Late registration window has closed
                setTableState((prev) => ({
                  ...prev,
                  lateRegOpen: false,
                }));
              } else if (data?.type === 'rebuy') {
                // A player rebuyed — refresh their stack
                const rebuyData = data.payload || {};
                if (rebuyData.userId) {
                  console.debug(
                    `[TablePage] Rebuy: ${rebuyData.userId.slice(0, 8)} +${rebuyData.chips} chips`
                  );
                }
              } else if (
                data?.type === 'bounty_collected' ||
                data?.type === 'mystery_bounty_revealed'
              ) {
                // VISIBLE FIX 2026-08-15: a knockout in a bounty event produced
                // no feedback at the table at all — no overlay, no sound, and
                // the seat head badges never moved. The engine now broadcasts
                // the claim (both names, the mode, the cash amount); celebrate
                // it and keep the badges honest: a PKO knockout grows the
                // winner's head and the eliminated player's head goes to zero.
                const b = data.payload || {};

                // ANIMATION 2026-08-20 (Dan): a knockout is the most dramatic
                // thing that happens in a bounty event, and it used to produce
                // a one-line text banner. Both types now drive a real
                // animation, and each OWNS its sound — so the banner and the
                // duplicate cue here are gone.
                //
                // This handler already runs on every client at the table (the
                // engine broadcasts to the whole table), which is what makes
                // both animations shared in real time with no new plumbing.
                if (data.type === 'mystery_bounty_revealed') {
                  // TABLE SCOPE 2026-08-21: this broadcast rides the TOURNAMENT
                  // channel (t-break-<id>), which every table in the event is
                  // subscribed to. Without this check, a knockout on table 3
                  // played the chest on tables 1 and 2 as well — a full-screen
                  // reveal, over a live hand, for something that happened to
                  // strangers. The engine now stamps the knockout's table;
                  // ignore anything that is not ours. Older engine builds send
                  // no tableId, in which case behave exactly as before.
                  if (b.tableId && b.tableId !== tableId) {
                    return;
                  }
                  chestQueue.enqueue({
                    knockerUserId: b.knockerUserId || '',
                    knockerName: b.knockerName || 'Player',
                    eliminatedName: b.eliminatedName || 'Player',
                    amount: Number(b.amount) || 0,
                    tierLabel: b.tierLabel,
                    isJackpot: !!b.isJackpot,
                    avgBounty: Number(b.avgBounty) || undefined,
                  });
                  setChestRemoteOpened(false);
                } else {
                  knockoutQueue.enqueue({
                    knockerName: b.knockerName || 'Player',
                    eliminatedName: b.eliminatedName || 'Player',
                    amount: Number(b.amount) || 0,
                    addedToHead: Number(b.addedToHead) || 0,
                    isHero: !!b.knockerUserId && b.knockerUserId === userId,
                    eliminatedAvatar: b.eliminatedAvatar || undefined,
                  });
                }
                setTableState((prev) => {
                  const next = { ...prev.bountyMap };
                  if (b.eliminatedUserId) delete next[b.eliminatedUserId];
                  if (b.knockerUserId && b.addedToHead > 0) {
                    next[b.knockerUserId] = (next[b.knockerUserId] || 0) + Number(b.addedToHead);
                  }
                  return { ...prev, bountyMap: next };
                });
              } else if (data?.type === 'level_up') {
                // Blind level increased
                const levelData = data.payload || {};
                // LEVEL INDEXING 2026-08-21: payload.level is the engine's
                // 0-based structure index; the masthead shows index + 1.
                const lvlIdx = Number(levelData.level) || 0;
                setTableState((prev) => ({
                  ...prev,
                  currentLevel: lvlIdx + 1,
                  blinds: levelData.blinds,
                }));
                // Restart the masthead level clock. The broadcast names the
                // new level but not its duration, so that comes from the
                // structure captured at load.
                {
                  const struct = blindStructRef.current;
                  const entry =
                    struct[Math.min(Math.max(lvlIdx, 0), Math.max(struct.length - 1, 0))] ||
                    struct.find((bl) => bl.level === lvlIdx + 1);
                  const durSec = entry
                    ? Number(entry.duration) ||
                      (Number(entry.duration_minutes ?? entry.durationMinutes) || 0) * 60
                    : 0;
                  if (durSec > 0) setLevelClock({ startedAtMs: Date.now(), durationSec: durSec });
                }
                setAnnouncement({ type: 'level_up', data: levelData });
                // COMPETITOR-PARITY 2026-08-19: the level-up banner animated
                // in silence — give it its fanfare.
                if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playLevelUp();
              }
            })
            .subscribe((status: string, err?: Error) => {
              if (status === 'CHANNEL_ERROR') {
                console.debug('[TablePage] Realtime channel error:', err?.message || err);
              }
              if (status === 'TIMED_OUT') {
                console.debug('[TablePage] Realtime channel timed out');
              }
            });
          breakChannelRef.current = breakChan;

          // NOTE: Add-on events handled via break channel above (ADDON_PERIOD_START/END)
          // No duplicate add-on channel needed — prevents race condition from dual subscriptions
        }

        // Load user's Player Wallet balance for buy-in
        if (userId && userId !== 'guest') {
          const balance = await WalletService.getPlayerBalance(userId, { tableId });
          setAccountBalance(balance);

          // FIX 136: Check 2-hour re-entry restriction from recent cashout
          const { data: cashoutHistory } = await supabase
            .from('table_cashout_history')
            .select('cashout_amount, restriction_expires_at')
            .eq('table_id', table.id)
            .eq('user_id', userId)
            .gt('restriction_expires_at', new Date().toISOString())
            .order('cashed_out_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (cashoutHistory) {
            setCashoutMinBuyIn(cashoutHistory.cashout_amount);
          }
        }

        // ─── Load existing seated players from DB (reconnection support) ───
        // If page reloads while players are seated, we must restore their state
        const { data: existingSeats } = await supabase
          .from('table_seats')
          .select(
            'seat_number, user_id, stack, status, horse_id, is_sitting_out, time_bank_remaining, time_bank_uses_remaining'
          )
          .eq('table_id', table.id)
          .is('left_at', null);

        if (existingSeats && existingSeats.length > 0) {
          // Fetch display names for seated players
          const userIds = existingSeats.map((s) => s.user_id).filter(Boolean);
          const { data: profiles } = await supabase
            .from('profiles')
            .select(
              'id, username, display_name, avatar_url:arena_avatar_url, is_horse, horse_profile'
            )
            .in('id', userIds);

          const profileMap = new Map((profiles || []).map((p) => [p.id, p]));

          // BUG-09 FIX: Merged heroSeat update into same setTableState callback
          // (was previously calling setTableState inside setTableState which causes React warnings)
          // CRITICAL: Detect and clean up duplicate seats for the same user
          const heroSeats = existingSeats.filter((s) => s.user_id === userId);
          if (heroSeats.length > 1) {
            reportError('- cleaning up extras', 'TablePage.DUPLICATE_SEATS_DETECTED_for_user');
            // Keep the first seat, remove the rest from DB
            const [keepSeat, ...extraSeats] = heroSeats;
            for (const extra of extraSeats) {
              Promise.resolve(
                supabase
                  .from('table_seats')
                  .update({ left_at: new Date().toISOString() })
                  .eq('table_id', table.id)
                  .eq('seat_number', extra.seat_number)
                  .eq('user_id', userId)
              )
                .then(({ error }) => {
                  if (error) reportError(error, 'TablePage.Failed_to_remove_duplicate_seat');
                  else console.debug('[Seat] Removed duplicate seat', extra.seat_number);
                })
                .catch((e) => reportError(e, 'TablePage.Duplicate_seat_cleanup_error'));
            }
            // Filter existingSeats to exclude duplicates for local state
            const cleanedSeats = existingSeats.filter(
              (s) => s.user_id !== userId || s.seat_number === keepSeat.seat_number
            );
            existingSeats.length = 0;
            existingSeats.push(...cleanedSeats);
          }

          setTableState((prev) => {
            // FIX: Start from CLEAN slate — DB is the source of truth for seated players.
            // This prevents ghost players from stale engine broadcasts or failed buy-ins.
            const updatedPlayers: ((typeof prev.players)[0] | null)[] = Array(
              prev.players.length
            ).fill(null) as any;
            let resolvedHeroSeat = 0; // Reset — only set if hero is in DB
            let heroAlreadyAssigned = false;

            // Build a set of DB seat numbers for validation
            const dbSeatNums = new Set(existingSeats.map((s) => s.seat_number));

            for (const seat of existingSeats) {
              const seatIdx = seat.seat_number - 1;
              if (seatIdx < 0 || seatIdx >= updatedPlayers.length) continue;
              // Seed the authoritative sit-out set from the seat rows.
              if (seat.is_sitting_out) sittingOutIdsRef.current.add(seat.user_id);
              else sittingOutIdsRef.current.delete(seat.user_id);
              const profile = profileMap.get(seat.user_id);
              // Only the FIRST matching seat gets isHero — prevents duplicates
              const isHero = seat.user_id === userId && !heroAlreadyAssigned;
              if (isHero) heroAlreadyAssigned = true;

              updatedPlayers[seatIdx] = {
                id: seat.user_id,
                name: profile?.display_name || profile?.username || `Player ${seat.seat_number}`,
                avatar: profile?.avatar_url || '',
                stack: seat.stack || 0,
                status: seat.is_sitting_out ? ('sitting_out' as const) : ('active' as const),
                isHero,
                showCards: isHero,
                isHorse: profile?.is_horse || !!seat.horse_id,
                horseProfile: undefined,
              } as any;

              // Restore hero seat for the current user.
              //
              // BUG 027 FIX 2026-04-17: previously auto-released hero seats with
              // stack=0 on mount (calling it a "stuck-bust row"). That kicked
              // legitimately-busted users off the table BEFORE the bust-rebuy
              // useEffect had a chance to pop the RebuyModal, so the user was
              // booted with no chance to top up. New policy: keep the hero
              // seated with stack=0. The bust-rebuy useEffect watches for
              // stack=0 + !isHandInProgress and pops the RebuyModal; if the
              // user declines, cancelBustRebuy → handleLeaveTable stamps
              // left_at. If they rebuy, atomic_table_rebuy refills the stack
              // and play resumes.
              if (isHero) {
                const heroStack = Number(seat.stack || 0);
                resolvedHeroSeat = seat.seat_number;
                if (heroStack <= 0) {
                  console.warn(
                    '[Seat] Hero seat at',
                    seat.seat_number,
                    'has stack=0 - bust-rebuy flow will prompt rebuy or clean up on decline'
                  );
                }
              }
            }

            // Log any ghost seats that were cleared
            for (let i = 0; i < prev.players.length; i++) {
              if (prev.players[i] && !dbSeatNums.has(i + 1)) {
                console.debug(
                  '[Seat] Cleared ghost player from seat',
                  i + 1,
                  '- not in DB:',
                  prev.players[i]?.id
                );
              }
            }

            // FIX 132: Set heroSeatRef immediately so duplicate-seat guard works
            if (resolvedHeroSeat > 0) {
              heroSeatRef.current = resolvedHeroSeat;
            } else {
              heroSeatRef.current = 0; // Hero not seated — ensure ref is clean
            }
            return {
              ...prev,
              players: updatedPlayers as typeof prev.players,
              heroSeat: resolvedHeroSeat,
            };
          });
          // heroSeat already set inside the setTableState callback above (L1796)
          // No second setTableState needed — avoids unnecessary re-render
        }

        // ─── Initialize Time Bank state from DB (server-authoritative) ───
        if (userId && userId !== 'guest') {
          const heroSeatData = existingSeats?.find((s) => s.user_id === userId);
          const dbRemaining = (heroSeatData as any)?.time_bank_remaining;
          const dbUses = (heroSeatData as any)?.time_bank_uses_remaining;
          if (dbRemaining != null) setTimeBankTimeRemaining(dbRemaining);
          if (dbUses != null) setTimeBanksRemaining(dbUses);
        }
      }
    }
    loadTableInfo();

    return () => {
      isMounted = false;
      // P1-4 FIX: tear down the tournament channels in the SAME effect that
      // creates them (deps [tableId, userId]), so a hero-seat change no longer
      // destroys them without recreation. (Previously this teardown lived in
      // the room effect keyed on tableState.heroSeat.)
      if (breakChannelRef.current) {
        // BUG-C FIX: Read tournamentId from tableStateRef (fresh) instead of stale closure
        const tournId = tableStateRef.current.tournamentId || tableId;
        masterBus.removeRegisteredChannel(`t-break-${tournId}`);
        breakChannelRef.current = null;
      }
      if (addOnChannelRef.current) {
        // Add-on events handled via break channel — no separate channel needed
        addOnChannelRef.current = null;
      }
      /* AUDIT 2026-08-22: a scheduled tournament exit must not outlive the
         subscription that scheduled it. The winner's beat is 7s long; a player
         whose tab is closed inside it used to be force-navigated out of
         whatever they were looking at when it fired. */
      if (tournamentExitTimerRef.current) {
        clearTimeout(tournamentExitTimerRef.current);
        tournamentExitTimerRef.current = null;
      }
      if (bountyChannelRef.current) {
        // BUG-C FIX: Read tournamentId from tableStateRef (fresh) instead of stale closure
        const tournId = tableStateRef.current.tournamentId || tableId;
        masterBus.removeRegisteredChannel(`bounty-${tournId}`);
        bountyChannelRef.current = null;
      }
    };
  }, [tableId, userId]);

  // Join/leave multiplayer room
  useEffect(() => {
    if (!tableId || !userId) return;

    // RoomService now consumes the channel created by TableWebSocket.
    // We no longer call roomService.joinRoom() here.

    // Subscribe to room messages
    const unsubscribe = roomService.onMessage(tableId, (msg: RoomMessage) => {
      switch (msg.type) {
        case 'PLAYER_JOINED':
          // ANIMATION/SOUND AUDIT 2026-08-19: these cases were empty — a
          // player joining or leaving the table produced zero audio feedback
          // on the room-message path. (The seat-INSERT path at handleSeatInsert
          // covers DB inserts but skips the hero and misses this bus.)
          // REVIEW FIX 2026-08-19: gated for background multi-table tabs (#175).
          if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playSeatTaken();
          break;
        case 'PLAYER_LEFT':
          if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playPlayerLeft();
          break;
        case 'PLAYER_ACTION': {
          // DISABLED: Engine WS now handles PLAYER_ACTION (line ~3805).
          // Keeping this case empty to prevent the old Supabase Realtime path
          // from double-firing sounds and chip animations.
          break;
        }
        case 'CHAT': {
          // Parse special messages (reactions, throws) — filter from chat display
          const chatPayload = msg.payload as any;
          const content = chatPayload?.message || chatPayload?.content || '';

          // CRITICAL FIX: RoomService puts sender at msg.sender, not inside payload
          const senderId = msg.sender || chatPayload?.user_id || '';

          // Get player name if seated, otherwise fallback
          if (!content) break;

          // Check if it's a special message (reaction/throw).
          // Processes animation for all users (including sender).
          // Normal chat messages return false and are safely ignored,
          // as they are handled natively by the useTableChat Supabase Postgres listener.
          parseIncomingMessage(content, senderId);
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      roomService.leaveRoom(tableId);
      // Time bank cleanup handled server-side — no client engine to dispose
      // P1-4 FIX: tournament break/bounty channel teardown moved to the
      // loadTableInfo effect (which creates them); this effect no longer
      // depends on tableState.heroSeat, so a seat change won't destroy them.
    };
  }, [tableId, userId]);

  // ── Bus Listener: cross-tab live balance sync (Triple-Wallet sync) ──
  useMasterBusSubscription('BALANCE_UPDATED', (payload: any) => {
    if (!payload.userId || payload.userId === userId) {
      if (payload.balance !== undefined) {
        setAccountBalance(payload.balance);
      } else {
        WalletService.getPlayerBalance(userId, { tableId })
          .then(setAccountBalance)
          .catch((e) => reportError(e, 'TablePage.balanceSync'));
      }
    }
  });

  // ── Bus Listener: live settings sync (theme, sound, deck changes) ──
  useMasterBusSubscription('SETTINGS_UPDATED', (payload: any) => {
    const s = payload?.settings || payload;
    if (!s) return;
    // Apply sound preference if changed
    if (typeof s.soundEnabled === 'boolean') {
      localStorage.setItem(STORAGE_KEYS.SOUNDS, String(s.soundEnabled));
    }
    // 2026-08-18: a `deckStyle` branch used to live here writing
    // STORAGE_KEYS.DECK_STYLE. Nothing ever sent that key and nothing ever read
    // that storage entry, and its presence made this listener look like the
    // route by which the settings page reached the table. It was not — the real
    // route is useTableSettings' SETTINGS_CHANGED subscription, which the
    // settings page now feeds via updateSettings(). Deck style, card back, pot
    // odds, animation speed and the rest all arrive that way.
  });

  // ── Bus Listeners: Phase 8 — Action Rejection + Timer Events ──
  useMasterBusSubscription('ACTION_REJECTED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    if (payload.playerId === userId) {
      showActionError({
        error: payload.reason || 'Invalid action',
        code: payload.code,
        hint: payload.hint,
      });
    }
  });

  useMasterBusSubscription('ACTION_TIMER_STARTED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    setTableState((prev) => ({
      ...prev,
      actionTimerDeadline: payload.deadline,
      /**
       * Dan 2026-08-18: the countdown ring drained far faster than the real
       * 15s clock. SeatSlot computes the ring duration as
       * (deadline - startTime), but this handler only ever wrote the
       * DEADLINE — actionTimerStartTime stayed undefined/stale, so the
       * animation duration collapsed. Record the start alongside it: prefer
       * the server's own value, else derive it from the deadline and the
       * table's action clock so the ring always spans the true turn length.
       */
      actionTimerStartTime:
        payload.startTime ??
        payload.startedAt ??
        (typeof payload.deadline === 'number'
          ? payload.deadline - actionTimeSeconds * 1000
          : Date.now()),
      actionTimerPlayerId: payload.playerId,
    }));
  });

  useMasterBusSubscription('ACTION_TIMER_EXPIRED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    setTableState((prev) => ({
      ...prev,
      actionTimerDeadline: undefined,
      actionTimerStartTime: undefined,
      actionTimerPlayerId: undefined,
    }));
  });

  useMasterBusSubscription('STATE_INTEGRITY_VIOLATION', (payload: any) => {
    if (payload.tableId !== tableId) return;
    reportError(payload.violations, 'TablePage._INTEGRITY_VIOLATION_hand_payloadhandNum');
  });

  useMasterBusSubscription('SESSION_STATS_UPDATE', (payload: any) => {
    if (payload.tableId !== tableId) return;
    setTableState((prev) => ({
      ...prev,
      sessionPL: payload.stats?.profitLoss ?? prev.sessionPL,
      sessionHands: payload.stats?.handsPlayed ?? prev.sessionHands,
    }));
  });

  // NOTE: There is intentionally no PRE_ACTION_SET subscription here. The only
  // emitter of PRE_ACTION_SET is the effect above, and it carries the SERVER
  // action vocabulary ('auto_call', 'auto_call_any', ...) — feeding that back
  // into setPreAction (which holds UI vocabulary: 'call' | 'callAny' | ...)
  // corrupted the value: 'call' -> emit 'auto_call' -> setPreAction('auto_call')
  // -> effect else-branch -> 'auto_call_any'. A player who chose "call current
  // bet" was silently upgraded to "call ANY bet". Pre-action state is owned by
  // the UI control (onPreActionChange) and mirrored to the server; it must never
  // be re-derived from the bus echo.

  // FIX 89: INSURANCE_OFFERED is now server-authoritative via Realtime broadcast.
  // The subscribeToHandState callback handles 'insurance_offers' events.
  // Legacy MasterBus handler removed — server is the single source of truth.

  useMasterBusSubscription('TIME_BANK_ACTIVATED', (payload: any) => {
    if (payload.tableId !== tableId) return;

    // Bible V8 §6.2: one bank is 20 seconds (TimeBankEngine secondsPerUse).
    // The 15 that used to sit here was the DECISION clock, a different number.
    const seconds =
      payload.secondsGranted ?? payload.additionalSeconds ?? payload.secondsAdded ?? 20;

    // FIX 172: Play time bank activation sound (Bible V8 §5.3)
    // #175 gated for multi-table: only play on the active tab
    if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playTimeBankActivated();

    /**
     * Dan 2026-08-21 (bug list item 2): hero was EXCLUDED from the extension.
     *
     * The comment that used to sit here said "the local TimeBankEngine.activate()
     * already extended the timer" — but the local engine was deleted in the
     * server-authoritative migration (see the [MIGRATION] note at the top of
     * this file). Nothing extended hero's clock any more. The bank was spent,
     * the engine granted the seconds, and the only clock the player could see
     * sat at zero.
     *
     * Extend for everyone. Double-counting is not a risk: `extendTimer` adds to
     * the live remainder, and the next engine snapshot reseeds the countdown
     * from the authoritative `turn_deadline_ms` regardless.
     */
    extendTimer(seconds);

    // Update the Hero's specific localized UI if they are the one activating it
    if (payload.playerId === userId) {
      setTimeBankActive(true);
      setTimeBankTimeRemaining(seconds);
      setTimeBankGrantedSeconds(seconds);
      setTimeBanksRemaining(payload.usesRemaining ?? 0);
    }
  });

  // TIME_BANK_STOPPED / DEPLETED / EXPIRED: Update UI + persist hero's time bank state to Supabase
  const persistTimeBankState = useCallback(
    async (payload: any) => {
      if (payload.tableId !== tableId || payload.playerId !== userId) return;
      setTimeBankActive(false);
      setTimeBanksRemaining(payload.usesRemaining ?? 0);
      // Hide time bank UI if fully depleted
      if ((payload.usesRemaining ?? 0) <= 0 || (payload.remainingSeconds ?? 0) <= 0) {
        setShowTimeBank(false);
      }
      try {
        await supabase
          .from('table_seats')
          .update({
            time_bank_remaining: payload.remainingSeconds ?? 0,
            time_bank_uses_remaining: payload.usesRemaining ?? 0,
          })
          .eq('table_id', tableId)
          .eq('user_id', userId);
      } catch (err) {
        reportError(err, 'TablePage.Failed_to_persist_time_bank_state');
      }
    },
    [tableId, userId]
  );

  useMasterBusSubscriptions(
    ['TIME_BANK_STOPPED', 'TIME_BANK_DEPLETED', 'TIME_BANK_EXPIRED'],
    persistTimeBankState
  );

  useMasterBusSubscription('TIME_BANK_EXTENDED', (payload: any) => {
    if (payload.tableId !== tableId || payload.playerId !== userId) return;
    setTimeBanksRemaining(payload.usesRemaining ?? 0);
    setTimeBankTimeRemaining(payload.remainingSeconds ?? 0);
    setShowTimeBank(true);
    const msg =
      payload.diamondsCharged > 0
        ? `Time Bank Extended! (${payload.diamondsCharged} diamonds)`
        : 'Time Bank Extended! (VIP)';
    toast?.success?.(msg);
  });

  useMasterBusSubscription('TIME_BANK_EXTENSION_DENIED', (payload: any) => {
    if (payload.tableId !== tableId || payload.playerId !== userId) return;
    toast?.error?.('Not enough Diamonds for Time Bank extension');
  });

  useMasterBusSubscription('STRADDLE_TOGGLED', (payload: any) => {
    if (payload.tableId !== tableId || payload.playerId !== userId) return;
    // Mark as server-originated to prevent useEffect from echoing back to server
    straddleFromServerRef.current = true;
    setIsStraddleEnabled(payload.enabled);
  });

  useMasterBusSubscription('RAKEBACK_DISTRIBUTED', (payload: any) => {
    if (payload.distributions && payload.distributions[userId]) {
      toast?.success?.(`Received +$${payload.distributions[userId].toFixed(2)} rakeback!`);
    }
  });

  useMasterBusSubscription('TABLE_BALANCE_EXECUTED', (payload: any) => {
    if (payload.moves?.some((m: any) => m.playerId === userId)) {
      toast?.info?.('You were moved to balance the tables.');
    }
  });

  // ── BUG-02 FIX: Action timer countdown ──────────────────────────────────
  // REMOVED: Duplicate timer lived here, conflicting with the timer at line ~3035.
  // The server auto-fold timer handles sendAction() broadcast,
  // error handling, and playFold() sound. This duplicate was removed.

  // ── Time Bank countdown interval — decrement timeBankTimeRemaining when active ──
  useEffect(() => {
    if (!timeBankActive) return;
    const interval = setInterval(() => {
      setTimeBankTimeRemaining((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeBankActive]);

  // ── Show Time Bank button when hero is seated, has banks, and it's their turn ──
  useEffect(() => {
    if (!tableId || !userId) return;
    const isHeroTurn =
      tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;
    if (isHeroTurn && timeBanksRemaining > 0) {
      setShowTimeBank(true);
    } else if (!timeBankActive) {
      // Only hide when time bank is NOT currently counting down
      setShowTimeBank(false);
    }
  }, [
    tableState.currentPlayerSeat,
    tableState.heroSeat,
    tableState.isHandInProgress,
    tableId,
    userId,
    timeBankActive,
  ]);

  // ── Reset timeBankActive when hero's turn ends ──
  useEffect(() => {
    const isHeroTurn =
      tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;
    if (!isHeroTurn && timeBankActive) {
      // Hero acted or hand ended — cancel time bank state
      setTimeBankActive(false);
      setShowTimeBank(false);
      // Server tracks time bank state — no client engine call needed
    }
  }, [
    tableState.currentPlayerSeat,
    tableState.heroSeat,
    tableState.isHandInProgress,
    timeBankActive,
    tableId,
    userId,
  ]);
  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION STATUS TOAST — visible feedback when WebSocket drops/reconnects
  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-08-22: these toasts used to watch the LEGACY Supabase channel, so
  // players saw "Connection lost" on a healthy game (Supabase blip) and saw
  // NOTHING when the actual game socket died. Watch the engine WS instead.
  //
  // Review fix (same day): DEBOUNCED for real this time. The engine socket
  // flips through 'reconnecting' on every watchdog escalation, and the first
  // version fired a toast + sound on every flip — and fired a spurious
  // "Reconnected" on every fresh table mount (idle → connecting → connected
  // counts as a reconnect if you only track booleans). Rules now:
  //   - never toast until the FIRST successful connect has been seen;
  //   - "Connection lost" only after 3s of continuous disconnection;
  //   - "Reconnected" only if the loss toast was actually shown.
  const engineToastStateRef = useRef({ everConnected: false, lossToastShown: false });
  useEffect(() => {
    const st = engineToastStateRef.current;
    if (engineWsStatus === 'connected') {
      st.everConnected = true;
      if (st.lossToastShown) {
        st.lossToastShown = false;
        heartbeatToastRef.current?.success?.('Reconnected');
        if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playReconnect();
      }
      return;
    }
    if (!st.everConnected) return; // initial mount noise
    const t = window.setTimeout(() => {
      if (st.lossToastShown) return;
      st.lossToastShown = true;
      heartbeatToastRef.current?.warning?.('Connection lost - reconnecting…');
      if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playDisconnect();
    }, 3000);
    return () => window.clearTimeout(t);
  }, [engineWsStatus]);

  // ═══════════════════════════════════════════════════════════════════════════
  // HORSE LOADING — Load seated horses from DB into React table state
  // ═══════════════════════════════════════════════════════════════════════════
  const horsesLoadedRef = useRef(false);
  // Track horse seat→profile mapping synchronously (not via React state)
  // so TURN_CHANGE handler can check immediately without waiting for re-render
  const horseMapRef = useRef<
    Map<number, { id: string; profile: string; name: string; stack: number }>
  >(new Map());

  useEffect(() => {
    if (!tableId || horsesLoadedRef.current || _horsesLoadedForTable[tableId]) return;
    // Wait for table info to load first (maxPlayers must be set)
    if (tableState.blinds === '?/?') return;

    // Set IMMEDIATELY to prevent duplicate async calls on re-render AND remount
    horsesLoadedRef.current = true;
    _horsesLoadedForTable[tableId] = true;

    const loadHorses = async () => {
      try {
        // Initialize Hydra
        HydraService.initialize();

        // Get all horses seated at this table via HydraService
        const horses = await HydraService.getActiveHorses(tableId);

        if (horses.length === 0) {
          // No horses found, seed the table
          const bbMatch = tableState.blinds.match(/\/(\d+)/);
          const bigBlind = bbMatch ? parseInt(bbMatch[1]) : 2;
          // Use seedTable return value directly — avoids RLS read issues on table_seats
          const seededHorses = await HydraService.seedTable(tableId, bigBlind);
          if (seededHorses.length > 0) {
            console.debug(
              '[Horses] seedTable returned',
              seededHorses.length,
              'horses, populating UI'
            );
            populateHorsePlayers(seededHorses);
          } else {
            // Fallback: try DB query in case horses were already seated by another client
            const dbHorses = await HydraService.getActiveHorses(tableId);
            if (dbHorses.length > 0) {
              console.debug('[Horses] Fallback DB query found', dbHorses.length, 'horses');
              populateHorsePlayers(dbHorses);
            }
          }
        } else {
          // Load horses into table state
          populateHorsePlayers(horses);
        }
      } catch (err) {
        reportError(err, 'TablePage.Failed_to_load_horses');
        horsesLoadedRef.current = false; // Allow retry on error
        if (tableId) _horsesLoadedForTable[tableId] = false;
      }
    };

    const populateHorsePlayers = (horses: import('../services/HydraService').HorsePlayer[]) => {
      // Set horse map SYNCHRONOUSLY before React state update
      // This ensures TURN_CHANGE handler can detect horses immediately
      for (const horse of horses) {
        const bbMatch = tableState.blinds.match(/\/(\d+)/);
        const bigBlind = bbMatch ? parseFloat(bbMatch[1]) : 2;
        const stack = horse.stack > 0 ? horse.stack : bigBlind * 100;
        horseMapRef.current.set(horse.seatNumber, {
          id: horse.id,
          profile: horse.profile,
          name: horse.name || `Player ${horse.seatNumber}`,
          stack,
        });
      }

      setTableState((prev) => {
        const updatedPlayers = [...prev.players];
        let populated = 0;

        for (const horse of horses) {
          const seatIdx = horse.seatNumber - 1;
          if (seatIdx >= 0 && seatIdx < updatedPlayers.length && !updatedPlayers[seatIdx]) {
            const bbMatch = prev.blinds.match(/\/(\d+)/);
            const bigBlind = bbMatch ? parseFloat(bbMatch[1]) : 2;
            const stack = horse.stack > 0 ? horse.stack : bigBlind * 100;

            updatedPlayers[seatIdx] = {
              id: horse.id,
              name: horse.name || `Player ${horse.playerNumber || seatIdx + 1}`,
              avatar:
                horse.avatar ||
                generateAvatarSvg(horse.id || horse.name || 'horse', horse.name || 'Horse'),
              stack,
              status: 'active' as const,
              isHero: false,
              showCards: false,
              // Extended horse properties for TURN_CHANGE auto-action
              isHorse: true,
              horseProfile: horse.profile,
            } as any;
            populated++;
          }
        }

        // Horses populated into seats
        return { ...prev, players: updatedPlayers };
      });
    };

    loadHorses();
  }, [tableId, tableState.blinds]);

  // ═══════════════════════════════════════════════════════════════════════════
  // REALTIME TABLE_SEATS — Auto-update UI when new players/horses are seated
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!tableId) return;

    const channel = supabase
      .channel(`table-seats-live:${tableId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'table_seats',
          filter: `table_id=eq.${tableId}`,
        },
        async (payload) => {
          const newSeat = payload.new as {
            user_id: string;
            seat_number: number;
            stack: number;
            left_at: string | null;
          };
          if (newSeat.left_at) return; // Already left

          // Don't duplicate the hero player — they're already in state from buy-in flow
          if (newSeat.user_id === userId) return;

          console.debug('[RealtimeSeats] New seat INSERT:', newSeat.seat_number, newSeat.user_id);

          // FIX 172: Play seat-taken sound when new player sits (Bible V8 §5.1)
          // #175 gated for multi-table: only play on the active tab
          if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playSeatTaken();

          // Fetch the player's profile
          const { data: profile } = await supabase
            .from('profiles')
            .select(
              'id, username, display_name, avatar_url:arena_avatar_url, is_horse, horse_profile'
            )
            .eq('id', newSeat.user_id)
            .maybeSingle();

          setTableState((prev) => {
            const seatIdx = newSeat.seat_number - 1;
            if (seatIdx < 0 || seatIdx >= prev.players.length) return prev;
            if (prev.players[seatIdx]) return prev; // Seat already occupied in state

            const updatedPlayers = [...prev.players];

            // FIX: ONE-SEAT-PER-USER — if this user is already in another seat, remove them first
            for (let j = 0; j < updatedPlayers.length; j++) {
              if (updatedPlayers[j]?.id === newSeat.user_id) {
                console.debug(
                  '[RealtimeSeats] Removing user',
                  newSeat.user_id,
                  'from stale seat',
                  j + 1,
                  '(moving to',
                  newSeat.seat_number,
                  ')'
                );
                updatedPlayers[j] = null as any;
              }
            }

            updatedPlayers[seatIdx] = {
              id: newSeat.user_id,
              name: profile?.display_name || profile?.username || `Player ${newSeat.seat_number}`,
              avatar: profile?.avatar_url || '',
              stack: newSeat.stack || 0,
              status: 'active' as const,
              isHero: false,
              showCards: false,
              isHorse: profile?.is_horse || false,
              horseProfile: profile?.horse_profile || undefined,
            } as any;

            return { ...prev, players: updatedPlayers };
          });

          // Also update horse map if this is a horse
          if (profile?.is_horse) {
            horseMapRef.current.set(newSeat.seat_number, {
              id: newSeat.user_id,
              profile: profile.horse_profile || 'reg',
              name: profile.display_name || profile.username || `Player ${newSeat.seat_number}`,
              stack: newSeat.stack || 0,
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'table_seats',
          filter: `table_id=eq.${tableId}`,
        },
        (payload) => {
          const updated = payload.new as {
            user_id: string;
            seat_number: number;
            stack: number;
            left_at: string | null;
            is_sitting_out?: boolean | null;
          };

          // Player left — remove from state
          if (updated.left_at) {
            console.debug('[RealtimeSeats] Player LEFT seat:', updated.seat_number);
            setTableState((prev) => {
              const seatIdx = updated.seat_number - 1;
              if (seatIdx < 0 || seatIdx >= prev.players.length) return prev;
              if (!prev.players[seatIdx]) return prev;

              const updatedPlayers = [...prev.players];
              updatedPlayers[seatIdx] = null as any;
              return { ...prev, players: updatedPlayers };
            });
            horseMapRef.current.delete(updated.seat_number);
          } else {
            // Stack update (e.g., rebuy)
            setTableState((prev) => {
              const seatIdx = updated.seat_number - 1;
              if (seatIdx < 0 || seatIdx >= prev.players.length) return prev;
              if (!prev.players[seatIdx]) return prev;

              const updatedPlayers = [...prev.players];
              const existing = updatedPlayers[seatIdx];
              if (existing) {
                // SIT-OUT VISIBILITY 2026-08-21: the engine now persists
                // is_sitting_out on the seat row. Flip only between
                // sitting_out and active — never clobber a transient in-hand
                // status (folded/all_in) the snapshot stream owns.
                let status = (existing as any).status;
                if (updated.is_sitting_out === true) {
                  status = 'sitting_out';
                  sittingOutIdsRef.current.add(updated.user_id);
                } else if (updated.is_sitting_out === false) {
                  sittingOutIdsRef.current.delete(updated.user_id);
                  if (status === 'sitting_out') status = 'active';
                }
                updatedPlayers[seatIdx] = {
                  ...existing,
                  stack: updated.stack,
                  status,
                } as typeof existing;
              }
              return { ...prev, players: updatedPlayers };
            });
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') {
          console.debug(`[RealtimeSeats] Subscribed to table_seats for ${tableId}`);
        }
        if (status === 'CHANNEL_ERROR') {
          console.debug('[RealtimeSeats] Channel error:', err?.message);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tableId, userId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // WAITLIST → HORSE YIELD — When a real player is waiting & table full, remove a horse
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!tableId || !tableState.blinds || tableState.blinds === '?/?') return;
    if (tableState.isTournament) return; // No horse cap in tournaments

    // Poll waitlist every 10s — if real players are waiting, yield a horse
    const interval = setInterval(async () => {
      try {
        const entries = await waitlistService.getTableWaitlist(tableId);
        if (entries.length > 0) {
          const yielded = await HydraService.checkWaitlistAndYield(tableId, entries.length);
          if (yielded) {
            console.debug('[Horses] Yielded horse seat for waiting real player');
          }
        }
      } catch (err) {
        // Non-critical — silently ignore
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [tableId, tableState.blinds, tableState.isTournament]);

  // ═══════════════════════════════════════════════════════════════════════════
  //HandController removed — server is authoritative
  // Only keeping state needed by other parts of the component
  // ═══════════════════════════════════════════════════════════════════════════

  // Keep a ref to the latest tableState for use inside event closures
  const tableStateRef = useRef(tableState);
  useEffect(() => {
    tableStateRef.current = tableState;
  }, [tableState]);

  // ═══════════════════════════════════════════════════════════════════════════
  // HERO SEAT INVARIANT — heroSeat must agree with the players array.
  //
  // Dan 2026-08-20, live at a Spin table: seated, DEALT IN, hole cards visible,
  // hero glow on — rendered at TOP-RIGHT with no action buttons, blind-folded
  // hand after hand. Both symptoms are one variable: `players[i].isHero` comes
  // from several mappers that each match `user_id === userId` per player, but
  // `heroSeat` — which drives the bottom-centre rotation AND the entire action
  // panel (`currentPlayerSeat === heroSeat`) — is only written by a handful of
  // load paths, each of which can lose a race:
  //
  //   - the table_seats mount load can run in the seconds between the engine
  //     creating the table and it seating the players (a tournament player
  //     navigates at the exact moment the game starts — the normal Spin flow);
  //   - the WS GAME_START reconciliation only helps if that event arrives
  //     after this client's auth resolved and its socket subscribed;
  //   - nothing else ever sets it, so losing both races is permanent for the
  //     session. You are a ghost at your own seat.
  //
  // The repair is the invariant, not another patched race: whenever the
  // players array holds a live player whose id is the signed-in user and
  // heroSeat disagrees, adopt that seat. SET-only, on proof — clearing
  // remains the job of the existing paths that demand proof of eviction
  // (seat stolen, snapshot without hero), so this can never fight them.
  useEffect(() => {
    if (!userId || userId === 'guest') return;
    const idx = tableState.players.findIndex((p) => p && p.id === userId);
    if (idx < 0) return; // not seated — nothing to assert
    const seatNum = idx + 1;
    if (tableState.heroSeat === seatNum) return; // invariant holds
    console.warn(
      `[Seat] heroSeat=${tableState.heroSeat} disagrees with players[] (hero at seat ${seatNum}) - reconciling`
    );
    heroSeatRef.current = seatNum;
    setTableState((prev) => {
      // Re-check against fresh state; also stamp isHero so the seat renders
      // hero styling even when the mapper that placed the row predates auth.
      const liveIdx = prev.players.findIndex((p) => p && p.id === userId);
      if (liveIdx < 0 || prev.heroSeat === liveIdx + 1) return prev;
      const players = [...prev.players];
      const row = players[liveIdx];
      if (row && !row.isHero) players[liveIdx] = { ...row, isHero: true };
      return { ...prev, players, heroSeat: liveIdx + 1 };
    });
  }, [tableState.players, tableState.heroSeat, userId]);

  // ═══════════════════════════════════════════════════════════════════════════
  //startNextHand removed — server manages the game loop
  // The entire HandController creation, event subscription, and hand lifecycle
  // has been removed. The client now receives all state updates from the server
  // via WebSocket/Realtime events below.
  // ═══════════════════════════════════════════════════════════════════════════

  /* REMOVED ~940 lines of client-side HandController logic:
   * - HandController creation and configuration
   * - Event subscription (HAND_START, CARDS_DEALT, COMMUNITY_CARDS, POT_UPDATE,
   *   PLAYER_ACTION, TURN_CHANGE, SHOWDOWN, WINNERS, HAND_COMPLETE)
   * - Horse auto-action logic
   * - Hand persistence wiring
   * - Achievement triggers
   * - Hand history recording
   * - Rake waterfall execution
   * - Auto-rebuy logic
   * - First-hand trigger useEffect
   * All of this is now handled server-side. UI updates come via WebSocket events.
   */

  // Keep actionLockRef for debouncing (used by action handlers below)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _migrationStub = null; // Marker: init block removed

  // Handle incoming game events from WebSocket.
  // 2026-04-16 ROOT-CAUSE FIX: the server sends discrete game events
  // (hand_started, blinds_posted, player_action, community_cards_dealt,
  // pot_win, showdown, hand_complete) via the native WS hub — NOT Supabase
  // Realtime. The handler was only watching `lastEvent` (Supabase), so
  // animations never fired. Now we also watch `engineLastEvent`.
  useEffect(() => {
    if (!engineLastEvent) return;

    const rawType = (engineLastEvent as { type?: string }).type || '';
    const normalizedType = rawType.toUpperCase();
    const normalizedData =
      (engineLastEvent as { data?: Record<string, unknown> }).data ||
      (engineLastEvent as unknown as Record<string, unknown>);
    const evt = { type: normalizedType, data: normalizedData };
    void engineLastEvent;

    switch (evt.type) {
      /**
       * THE SHARED SPIN REVEAL (Dan 2026-08-21).
       *
       * "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD PLAYER PAYS FOR HIS
       *  SEAT... ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST BEGIN
       *  WITH A WHEEL SPIN."
       *
       * The engine names the instant and holds the deal for it. Every seat
       * animates against THAT timestamp, so the three players watch one wheel
       * together instead of three private ones at three different moments —
       * which is what happened while the wheel was started from each client's
       * own page load.
       */
      case 'SPIN_REVEAL': {
        const d = evt.data as {
          multiplier?: number;
          buy_in?: number;
          locked_tiers?: unknown;
          reveal_at?: number;
        };
        const mult = Number(d?.multiplier) || 0;
        if (!mult) break;
        // Only ever show it once per game, however many times the event is
        // replayed by a reconnect.
        const key = `spin-reveal-${(evt.data as { tournament_id?: string })?.tournament_id || tableState.tournamentId || tableId}`;
        try {
          if (sessionStorage.getItem(key)) break;
          sessionStorage.setItem(key, '1');
        } catch {
          /* private mode — showing it twice is better than not at all */
        }
        setSpinDraw({
          multiplier: mult,
          buyIn: Number(d?.buy_in) || 0,
          tiers: DEFAULT_SPIN_TIERS,
          lockedTiers: parseLockedTiers(d?.locked_tiers),
          // The shared clock. A client that joins mid-sequence starts partway
          // through rather than replaying from the top.
          revealAtMs: Number(d?.reveal_at) || Date.now(),
        });
        break;
      }

      /**
       * THE TWO BEATS AFTER THE WHEEL (Dan 2026-08-21).
       *
       *   "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED, BUTTON RANDOMLY
       *    ASSIGNED AND THE SPIN STARTS!"
       *
       * TournamentManagerBase.scheduleSpinPostReveal broadcasts these two
       * events and holds the deal 1.8s to make room for them, saying in as many
       * words that it does so "so the client can animate them rather than
       * discovering them in a state diff". The client had no handler for
       * either. The chips and the puck did still appear - whenever the next
       * snapshot happened to land - so the beats existed on the engine's clock
       * and nowhere on the player's.
       *
       * Neither handler invents anything. Both write the value the engine has
       * already committed, on the instant the engine chose, and let the
       * animations that already exist run: the stack diff drives
       * seat__stack--up / stackDeltaFloat / seatStackGlow, and the button seat
       * mounts .seat__position-chip, whose dealerButtonAppear is a mount
       * animation. The snapshot that follows confirms the same values, so a
       * dropped event costs the choreography and nothing else.
       */
      case 'SPIN_CHIPS': {
        const d = evt.data as { starting_stack?: number };
        const stack = Number(d?.starting_stack) || 0;
        if (stack <= 0) break;
        setTableState((prev) => {
          // Only seats that are occupied and still empty-handed. A seat that
          // already has chips has had its beat, and rewriting it would fire a
          // second delta animation off a number that did not change.
          if (!prev.players.some((pl) => pl && (pl.stack ?? 0) <= 0)) return prev;
          return {
            ...prev,
            players: prev.players.map((pl) => (pl && (pl.stack ?? 0) <= 0 ? { ...pl, stack } : pl)),
          };
        });
        break;
      }

      case 'SPIN_BUTTON': {
        const d = evt.data as { dealer_seat?: number };
        const seat = Number(d?.dealer_seat) || 0;
        if (seat <= 0) break;
        setTableState((prev) => (prev.dealerSeat === seat ? prev : { ...prev, dealerSeat: seat }));
        break;
      }

      case 'GAME_START': {
        // Fast UI recovery via GameServerAPI.getTableState() full snapshot
        const syncData = evt.data as any;
        if (!syncData) break;

        setTableState((prev) => {
          const updatedPlayers = [...prev.players];
          const serverPlayers = syncData.players || [];
          // BUGFIX 2026-07-24: this recovery snapshot rebuilt `players` with isHero
          // but never updated `heroSeat`. When heroSeat had drifted (snapshot race,
          // reconnect), players[heroSeat-1] became null → the footer showed
          // "Spectating, Tap An Open Seat To Join" and the leave path used the wrong
          // seat, even though the hero was clearly seated. Reconcile heroSeat from the
          // authoritative snapshot here so the two never disagree.
          let syncedHeroSeat = 0;

          serverPlayers.forEach((sp: any) => {
            const seatIdx = sp.seat - 1;
            if (seatIdx >= 0 && seatIdx < updatedPlayers.length) {
              const existing = updatedPlayers[seatIdx];
              if (sp.user_id === userId) syncedHeroSeat = sp.seat;
              updatedPlayers[seatIdx] = {
                ...(existing || {}),
                id: sp.user_id,
                name: sp.username || existing?.name || `Seat ${sp.seat}`,
                stack: sp.stack,
                bet: sp.bet || 0,
                holeCards:
                  sp.user_id === userId || (sp.cards && sp.cards.length > 0 && !sp.is_folded)
                    ? sp.cards || existing?.holeCards || []
                    : [],
                // SIT-OUT REVIEW FIX 2026-08-21: the hand-state flag is
                // always false by design (sat-out players are dealt in and
                // blinded off). The seat-row truth lives in sittingOutIdsRef;
                // a sat-out player's seat stays GREY except in the moment
                // they are all-in (impossible while auto-folding, but never
                // hide a live all-in).
                status: sp.is_all_in
                  ? 'all_in'
                  : sittingOutIdsRef.current.has(sp.user_id)
                    ? 'sitting_out'
                    : sp.is_folded
                      ? 'folded'
                      : sp.is_sitting_out
                        ? 'sitting_out'
                        : 'active',
                isHero: sp.user_id === userId,
                showCards: sp.cards && sp.cards.length > 0 && !sp.is_folded,
              } as any;
            }
          });

          // Keep heroSeatRef in sync too (used by the sit/leave guards).
          //
          // AUDIT 2026-08-19: the previous version cleared the hero's claim
          // whenever the snapshot listed ANY player but not the hero. That is
          // wrong — `players` here is the CURRENT HAND's player list, and a
          // player who has bought in but has not yet been dealt in is legally
          // absent from it (that is the whole "Seat Reserved, you'll be dealt
          // in next hand" state). The old rule would have evicted their own
          // seat claim and toasted "you are no longer seated" at them every
          // hand while they waited. Clear ONLY on proof: someone else now
          // occupies the seat the hero believes is theirs.
          const claimed = heroSeatRef.current;
          const seatStolen =
            claimed > 0 &&
            serverPlayers.some(
              (sp: { seat?: number; user_id?: string }) =>
                sp?.seat === claimed && sp.user_id && sp.user_id !== userId
            );
          if (syncedHeroSeat > 0) heroSeatRef.current = syncedHeroSeat;
          else if (seatStolen) {
            heroSeatRef.current = 0;
            toast.info('You are no longer seated at this table. Tap a seat to rejoin.');
          }

          return {
            ...prev,
            handNumber: syncData.hand_number,
            pot: syncData.pot || 0,
            communityCards: normalizeCards(syncData.community_cards) as Card[],
            communityCards2: normalizeCards(syncData.community_cards2 || []) as Card[],
            // P2-5 FIX: TableState uses `boardStage` (typed BoardStage), not
            // `stage`. The old `stage` write was dead, leaving the board stuck
            // in a stale stage after mid-hand reconnect. Map to boardStage.
            boardStage: (syncData.stage || 'preflop') as BoardStage,
            dealerSeat: syncData.dealer_seat || 0,
            players: updatedPlayers,
            // Only overwrite heroSeat when the snapshot actually located the
            // hero, so a partial/empty snapshot never falsely resets a seated
            // player to 0.
            //
            // Dan 2026-08-18 [P0]: the old rule was one-directional — heroSeat
            // could only ever go UP. When the server genuinely removed the
            // seat (a boot sweep did exactly that to Dan), the client kept
            // claiming it forever: the felt showed "YOUR SEAT" and the footer
            // "Seat Reserved" while the player was not in the game at all.
            // A snapshot that DID enumerate players and does not contain the
            // hero is authoritative: the seat is gone, so clear it.
            // AUDIT 2026-08-19: only surrender the seat on proof it was taken
            // (see the heroSeatRef note above) — a hero waiting to be dealt in
            // is deliberately absent from this hand-scoped player list.
            heroSeat: syncedHeroSeat > 0 ? syncedHeroSeat : seatStolen ? 0 : prev.heroSeat,
          };
        });
        break;
      }
      case 'DEAL_CARDS':
        // Update community cards (normalized — accepts string or object cards)
        if ((evt.data as any).communityCards) {
          setTableState((prev) => ({
            ...prev,
            communityCards: normalizeCards((evt.data as any).communityCards) as Card[],
          }));
        }
        break;
      case 'PLAYER_ACTION': {
        // 2026-04-14 USER FEEDBACK FIX: full Bible V8 §5.1/§5.2 visual sequence.
        // Was previously only updating pot; the comprehensive handler that
        // showed the action label, fired chip-to-pot animation, and played
        // the sound was wired to roomService.onMessage which is the dead
        // Supabase Realtime path post-NO-GO-2. Migrated here so it runs off
        // the live engine WS player_action event.
        const data = evt.data as any;
        const action = (data.action || '').toLowerCase() as string;
        const actionSeat = (data.seat as number) || 0;
        const actionAmount = (data.amount as number) || 0;
        const seatIdx = actionSeat - 1;

        // DEAD-WIRING FIX 2026-08-15: record the action for Share Hand.
        // handActionsRef was declared 2,000 lines up and had ZERO writers and
        // ZERO readers, and tableState.actionHistory was declared on the
        // interface and never assigned. With no action log, sharedHandData
        // could never be built -- which is why the ShareHand modal, gated on
        // `showShareHand && sharedHandData`, never opened on a cash table no
        // matter how many times the menu item was tapped.
        if (actionSeat > 0 && action) {
          const log = handActionsRef.current;
          // Ceiling: a pathological hand cannot grow this without bound.
          if (log.length < 400) {
            log.push({
              seat: actionSeat,
              action,
              amount: actionAmount > 0 ? actionAmount : undefined,
              street: tableStateRef.current.boardStage || 'preflop',
            });
          }
        }

        // Step 1: Action label (immediate, persists until next action / new street)
        if (seatIdx >= 0) {
          // ANIMATION AUDIT 2026-08-19: record the wager where the snapshot
          // cannot erase it, so the chips-to-pot sweep always has a mask.
          if (actionAmount > 0) streetBetsRef.current[seatIdx] = actionAmount;
          setTableState((prev) => {
            const newActions = [...prev.lastActions];
            newActions[seatIdx] = action as any;
            const newBets = [...prev.lastBetAmounts];
            if (actionAmount > 0) newBets[seatIdx] = actionAmount;
            // Pot from snapshot is more accurate than locally summing — pot
            // updates arrive in the next snapshot. If client already has it,
            // keep prev.pot; otherwise leave untouched.
            return { ...prev, lastActions: newActions, lastBetAmounts: newBets };
          });
        }

        // Step 2: Sound + chip animation per Bible V8 §5.2.
        // 2026-04-14 fix: build the chip ChipAnimationEvent INLINE here (no
        // ref + no setTimeout). The ref-based path was firing a no-op
        // because triggerChipAnimationRef.current was sometimes null at the
        // time the setTimeout closure ran (ref binding race in the React
        // commit phase). Direct inline + immediate setChipAnimations is
        // the surest path to the chips landing in the pot in real-time.
        // #175 gated for multi-table: only play opponent action SFX on the active tab
        //
        // AUDIT-2 FIX 2026-08-20 (double-fire): this fired for EVERY seat,
        // including the hero — whose action sound already played locally the
        // instant they clicked (handleFold/Check/Call/Raise/AllIn). The server
        // round-trip is far longer than the 50ms priority window, so the hero
        // heard their own action TWICE, and on a raise it was two DIFFERENT
        // sounds (local playRaise cascade, then this echo's playChips clink).
        // The echo is for opponents only; the hero's own feedback is local and
        // immediate.
        const isHeroEcho = actionSeat > 0 && actionSeat === tableStateRef.current.heroSeat;
        if (soundService.isEnabled() && ambientSoundsAllowed && !isHeroEcho) {
          if (action === 'all_in' || action === 'allin') soundService.playAllIn();
          else if (action === 'bet' || action === 'raise' || action === 'call')
            soundService.playChips();
          else if (action === 'check') soundService.playCheck();
          else if (action === 'fold') soundService.playFold();
        }
        // Bible V8 §5.2: All-in dramatic mode activates on ANY player all-in.
        //
        // 2026-08-15 ROOT-CAUSE FIX (Dan: "facing an all-in, it would not let
        // me call"). Dramatic mode dims and (until today) DISABLED hero's own
        // action panel — see the pointer-events note in TablePage.css. Firing
        // it on an opponent's shove that hero still has to answer is wrong on
        // its own terms: the drama belongs to a pot no one can act on any more.
        // Gate it on hero having no live action left. The CSS fix makes this
        // non-load-bearing, but both layers now have to fail to reproduce the
        // bug, and multiway pots (short stack shoves, two deep stacks still to
        // act) no longer black out the panel for players with real decisions.
        if (action === 'all_in' || action === 'allin') {
          const st = tableStateRef.current;
          const heroP = st.heroSeat > 0 ? st.players[st.heroSeat - 1] : null;
          const heroStillHasAction =
            actionSeat !== st.heroSeat &&
            !!heroP &&
            heroP.status !== 'folded' &&
            (heroP.stack || 0) > 0;
          if (!heroStillHasAction) setIsAllInMode(true);
        }
        // Dan 2026-08-20 (pot redesign): NO chip flight to the pot on the
        // action itself. Chips belong IN FRONT of the player (ChipPhysics bet
        // stack at the seat) until the street completes — they sweep to the
        // middle only when the next board card(s) come (COMMUNITY_CARDS_DEALT
        // handler) or the hand ends. The old per-action flight is also what
        // kept stranding lone chip sprites in the middle of the felt.
        break;
      }

      // Bible V8 §1.16 Real-Time Law: discrete WS events trigger every UX
      // change. The four events below were added with this fix; client must
      // act on them directly, never wait for snapshot diff.
      case 'HAND_STARTED': {
        // AUDIT FIX 2026-07-19: track the new hand number and CLEAR hero hole
        // cards so a dropped card-insert can't leave the previous hand's cards
        // showing; then re-arm the hand-aware fetch to recover the new cards.
        {
          const hn = Number((evt.data as any)?.hand_number) || 0;
          if (hn > 0) heroHandRef.current = hn;
        }
        // BOMB POT 2026-08-20: the previous hand's bomb-pot state ends with
        // the hand. If THIS hand is a bomb pot, its own BOMB_POT_TRIGGERED
        // (emitted after HAND_STARTED in the engine's dealing path) re-arms it.
        // Items 11 + 16: a fresh hand has not reached showdown yet.
        handShowdownRef.current = { wentToShowdown: false, hands: 2 };
        setBombPotActive(false);
        setBombPotHoldFlop(false);
        if (bombPotHoldTimerRef.current) {
          clearTimeout(bombPotHoldTimerRef.current);
          bombPotHoldTimerRef.current = null;
        }
        if (bombPotChipTimerRef.current) {
          clearTimeout(bombPotChipTimerRef.current);
          bombPotChipTimerRef.current = null;
        }
        // AUDIT 2026-08-19: drop any in-flight pot push. It is otherwise
        // cleared only by a 700ms timer, and a hand that starts inside that
        // window would render its FRESH pot with .pot-display--collect still
        // applied — an animation that ends at opacity 0 with `forwards`, so the
        // new pot would be invisible until the timer caught up. Background-tab
        // timer throttling makes that window longer than 700ms in practice.
        setPotCollectTo(null);
        if (potCollectTimerRef.current) {
          clearTimeout(potCollectTimerRef.current);
          potCollectTimerRef.current = null;
        }
        // Deferred pot-ship beats belong to the finished hand.
        if (potShipTimerRef.current) {
          clearTimeout(potShipTimerRef.current);
          potShipTimerRef.current = null;
        }
        if (potPushDelayTimerRef.current) {
          clearTimeout(potPushDelayTimerRef.current);
          potPushDelayTimerRef.current = null;
        }
        // ANIMATION AUDIT 2026-08-19: the previous hand's 3s reset timer was
        // NEVER cancelled here. The server's fold-win inter-hand gap is
        // 2000ms, so on every fold-win that stale timer fired ~1s INTO the
        // new hand and blanked the fresh pot/board/winner state. Cancel every
        // cross-hand animation timer at the hand boundary.
        if (handCompleteTimerRef.current) {
          clearTimeout(handCompleteTimerRef.current);
          handCompleteTimerRef.current = null;
        }
        if (collectSeatsTimerRef.current) {
          window.clearTimeout(collectSeatsTimerRef.current);
          collectSeatsTimerRef.current = null;
        }
        applyCollectingChipSeats(Array(9).fill(false));
        streetBetsRef.current = Array(9).fill(0);
        if (muckTimerRef.current) {
          clearTimeout(muckTimerRef.current);
          muckTimerRef.current = null;
        }
        setMuckingSeats(Array(9).fill(false));
        // AUDIT-2 FIX 2026-08-20: the ALL IN banner timer was NOT cancelled at
        // the hand boundary — a hand starting inside the 1.8s window left
        // "ALL IN" splashed over the fresh deal.
        if (allInBannerTimerRef.current) {
          clearTimeout(allInBannerTimerRef.current);
          allInBannerTimerRef.current = null;
        }
        setShowAllInBanner(false);
        prevEquityCountRef.current = 0;
        // The Show/Muck prompt belongs to the finished hand — close it.
        if (handRevealTimerRef.current) {
          clearTimeout(handRevealTimerRef.current);
          handRevealTimerRef.current = null;
        }
        setShowHandRevealModal(false);
        // Fresh hand → reset the accumulated achievement outcome.
        // Dan 2026-08-18: show-card picks are per hand. Clear them here so a
        // card marked last hand is not still marked when the new one is dealt.
        setShownCardIndexes([]);
        heroHandOutcomeRef.current = {
          dealtIn: false,
          showdown: false,
          won: false,
          potWon: 0,
          handRank: '',
        };
        // Fresh hand → reset the Share Hand action log and remember the button
        // and the starting stacks BEFORE any chips move, so the shared replay
        // shows what each player sat down with rather than what they finished
        // with. (The button seat is needed for position labels on the replay.)
        handActionsRef.current = [];
        handStartStacksRef.current = {};
        {
          const st = tableStateRef.current;
          shareButtonSeatRef.current = st.dealerSeat || 0;
          st.players.forEach((p, i) => {
            if (p) handStartStacksRef.current[i + 1] = p.stack || 0;
          });
        }
        // Reset visual state instantly so the new hand starts crisp.
        setTableState((prev) => {
          // ANIMATION AUDIT 2026-08-19: 'folded' is per-hand state. It was
          // never reset here, so DealAnimation (which mounts off this event,
          // often before the first snapshot of the new hand arrives) skipped
          // every seat that folded LAST hand — those players visibly got no
          // cards. sitting_out/away/disconnected persist untouched.
          const players = prev.players.map((p) => {
            if (!p) return p;
            const unfolded = p.status === 'folded' ? { ...p, status: 'active' as const } : p;
            return unfolded.id === userId
              ? { ...unfolded, holeCards: [], showCards: false }
              : unfolded;
          });
          return {
            ...prev,
            players,
            lastActions: prev.lastActions.map(() => null),
            lastBetAmounts: prev.lastBetAmounts.map(() => 0),
            communityCards: [],
            communityCards2: [],
            boardStage: 'preflop',
            engineStage: 'preflop',
          };
        });
        // Re-fetch the hero's cards for the new hand (recovers a dropped insert).
        heroCardFetchRef.current?.();
        setTimeout(() => heroCardFetchRef.current?.(), 1500);
        // BUG 030 fix: clear prior hand's winner state IMMEDIATELY so the
        // "Three of a Kind" hand-strength label and winner banner cannot
        // bleed into the new hand if the table cycles faster than the 3s
        // HAND_COMPLETE cleanup timeout.
        setWinnerInfo({
          playerIds: [],
          handName: '',
          cardIndices: [],
          amounts: {},
          boardHandNames: null,
        });
        setWinnerParticle((prev) => ({ ...prev, active: false }));
        setIsAllInMode(false);
        setAllInEquities([]);
        // Trigger deal animation (legacy DealAnimation already wired to
        // dealAnimationKey; bump it so the cards fly from the dealer).
        setDealAnimationKey((k) => k + 1);
        // Bible V8 §10.1: per-seat card slide-in animation
        setIsSeatDealing(true);
        // CA-19: track so unmount can cancel — prevents setIsSeatDealing on dead page
        if (seatDealTimerRef.current) clearTimeout(seatDealTimerRef.current);
        seatDealTimerRef.current = setTimeout(
          () => {
            seatDealTimerRef.current = null;
            setIsSeatDealing(false);
          },
          // IMPROVEMENT PASS 2026-08-19: scales with --animation-speed like
          // the cardDealIn keyframe it gates.
          700 * getAnimationSpeed()
        );
        // Bible V8 §5.3: new hand indicator + card dealing sound
        // #175 gated for multi-table: only play on the active tab
        if (soundService.isEnabled() && ambientSoundsAllowed) {
          // COMPETITOR-PARITY 2026-08-19: shuffle riffle before the deal —
          // every major room marks the fresh hand with a shuffle.
          soundService.playShuffle();
          setTimeout(() => soundService.playNewHand(), 260);
          // DealAnimation owns the per-card deal sounds (staggered with its
          // visuals). Only when the card-slide animation is disabled does the
          // page play a single deal slide as the audio fallback.
          if (!v8Settings.card_slide) setTimeout(() => soundService.playDeal(), 380);
        }
        break;
      }
      case 'BOMB_POT_TRIGGERED': {
        // DEAD-WIRING FIX 2026-08-15. BombPotOverlay is mounted and has always
        // listened for this bus event; nothing has ever emitted it, and the
        // engine sent no bomb-pot signal at all. A bomb pot therefore looked
        // like a bug: an ante disappeared off every stack and the hand opened
        // on the flop with no preflop action and no explanation.
        //
        // (Note for whoever turns this on: as of today 0 of 54,858 tables have
        // bomb_pot_enabled set, so this path has never run in production. The
        // toggle exists in CreateTableModal and TableConfigPage.)
        {
          const d = evt.data as any;
          // BOMB POT 2026-08-20: tag every live seat with the "BOMB" pill
          // for the rest of the hand (cleared by the next HAND_STARTED).
          setBombPotActive(true);
          // Hold the flop reveal until the bomb explodes (see state decl).
          setBombPotHoldFlop(true);
          if (bombPotHoldTimerRef.current) clearTimeout(bombPotHoldTimerRef.current);
          bombPotHoldTimerRef.current = setTimeout(() => {
            bombPotHoldTimerRef.current = null;
            setBombPotHoldFlop(false);
            // ART UPGRADE 2026-08-21: detonation moved to 3.2s (the drop is
            // now a 1.5s incoming whistle), so the board's flop hold follows
            // it. Must stay >= BombPotOverlay's T_EXPLODE or the flop lands
            // while the bomb is still sitting there with a lit wick.
          }, 3200 * getAnimationSpeed());
          try {
            masterBus.emit('BOMB_POT_TRIGGERED', {
              tableId: tableId || '',
              anteAmount: Number(d?.ante_amount) || 0,
              // DOUBLE-BOARD BOMB POT 2026-08-20: the engine reports it for
              // real now (and downgrades itself when the deck can't cover
              // two boards), so pass it through instead of hardcoding false.
              doubleBoard: Boolean(d?.double_board),
              bbMultiplier: Number(d?.bb_multiplier) || 0,
            });
          } catch {
            /* bus publish is best-effort */
          }
          // ANTE PRESENTATION 2026-08-20 (reference parity): the engine's
          // postings array names every seat that paid the forced ante. Fly
          // each ante to the pot at the overlay's EXPLOSION beat (2.0s,
          // scaled) — in the reference the antes converge right after the
          // blast, not while the bomb is still falling. Presentation only;
          // the pot total was already settled server-side at trigger time.
          {
            const postings = (d?.postings as Array<{ seat: number; amount: number }>) || [];
            if (postings.length > 0) {
              if (bombPotChipTimerRef.current) clearTimeout(bombPotChipTimerRef.current);
              bombPotChipTimerRef.current = setTimeout(() => {
                bombPotChipTimerRef.current = null;
                const potPos = seatPctToViewportPx(tableScalerRef.current, POT_ANCHOR_PCT);
                const events: ChipAnimationEvent[] = [];
                for (const post of postings) {
                  if (!(post.seat > 0) || !(post.amount > 0)) continue;
                  const seatPct = seatPositions[post.seat - 1] || { x: 50, y: 50 };
                  const seatPos = seatPctToViewportPx(tableScalerRef.current, seatPct);
                  events.push(...createChipToPotEvent(seatPos, potPos, post.amount));
                }
                if (events.length > 0) setChipAnimations((prev) => [...prev, ...events]);
                // Fire at the blast (T_EXPLODE), not before it.
              }, 3200 * getAnimationSpeed());
            }
          }
        }
        break;
      }

      case 'BOMB_POT_COMPLETED': {
        // DOUBLE-BOARD BOMB POT 2026-08-20: the engine now emits this at
        // bomb-pot settlement (it was listener-only dead wiring since
        // 2026-08-15). The HAND_COMPLETE fallback emit below stays for older
        // engine builds; the overlay treats duplicates as no-ops.
        try {
          masterBus.emit('BOMB_POT_COMPLETED', { tableId: tableId || '' });
        } catch {
          /* bus publish is best-effort */
        }
        break;
      }

      case 'BLINDS_POSTED': {
        // Animate SB + BB chips from each blind seat into the pot.
        // 2026-04-16 fix: Use direct setChipAnimations instead of the
        // ref-based triggerChipAnimationRef which was sometimes null
        // (same race condition fixed for player_action on 2026-04-14).
        const postings =
          ((evt.data as any).postings as Array<{ seat: number; type: string; amount: number }>) ||
          [];
        // Dan 2026-08-20 (pot redesign): blinds no longer fly to the middle
        // either — they sit in front of the blind seats (ChipPhysics) and are
        // swept into the pot with everything else when the flop comes.
        for (const p of postings) {
          if (p.seat > 0 && p.amount > 0) {
            const seatIdx = p.seat - 1;
            // ANIMATION AUDIT 2026-08-19: blinds count toward the sweep mask.
            streetBetsRef.current[seatIdx] = p.amount;
          }
        }
        // Play chip sound for blinds posting
        // #175 gated for multi-table: only play on the active tab
        if (postings.length > 0 && soundService.isEnabled() && ambientSoundsAllowed) {
          soundService.playChips();
        }
        break;
      }
      case 'TURN_CHANGE': {
        // Discrete-event update of currentPlayerSeat — beats waiting for
        // the snapshot to arrive. The snapshot still self-corrects later.
        const newSeat = (evt.data as any).seat as number;
        if (typeof newSeat === 'number' && newSeat > 0) {
          setTableState((prev) =>
            prev.currentPlayerSeat === newSeat ? prev : { ...prev, currentPlayerSeat: newSeat }
          );
          // Bible V8 §5.4: medium haptic when it's hero's turn
          const heroSeat = tableStateRef.current.heroSeat;
          if (newSeat === heroSeat) {
            // 2026-08-15: hard reset of all-in dramatic mode whenever action
            // reaches hero. isAllInMode was only ever cleared on HAND_STARTED
            // and 3s after HAND_COMPLETE, so a shove earlier in the hand left
            // hero's panel dimmed (and formerly inert) for every remaining
            // street. If hero can act, the panel is fully lit and fully live.
            setIsAllInMode(false);
            import('../services/HapticService').then(({ haptic }) => haptic.medium());
            // Bible V8 §5.3: turn alert sound for hero.
            // Batch 2 tiering: the BELL is the active table's sound; a
            // background table's turn start gets the softer ping from
            // MultiTablePage instead, so four tables never ring four bells.
            if (soundService.isEnabled() && (isActive || !isMultiTable) && !muted) {
              soundService.playTurnAlert();
            }
          }
        }
        break;
      }
      case 'TIMER_COUNTDOWN': {
        // Roadmap batch 6: authoritative countdown pulse from the engine
        // (Law 1.16 timer_countdown). Both the pulse's timestamp and our
        // turn_deadline_ms are engine-clock values, so comparing them needs
        // no client-clock math at all. Re-pin the deadline only when it has
        // actually drifted - the snapshot path is normally right, and a
        // no-op setTableState skip keeps renders quiet.
        const cd = evt.data as {
          seat?: number;
          remaining_ms?: number;
          timestamp?: number;
        };
        const cdSeat = Number(cd?.seat);
        const cdRemaining = Number(cd?.remaining_ms);
        const cdTs = Number(cd?.timestamp);
        if (!Number.isFinite(cdSeat) || !Number.isFinite(cdRemaining) || !Number.isFinite(cdTs)) {
          break;
        }
        setTableState((prev) => {
          if (prev.currentPlayerSeat !== cdSeat) return prev;
          const pinned = cdTs + cdRemaining;
          const current = prev.actionTimerDeadline ?? 0;
          return Math.abs(pinned - current) > 750 ? { ...prev, actionTimerDeadline: pinned } : prev;
        });
        break;
      }
      case 'COMMUNITY_CARDS_DEALT': {
        // Slide the new community cards onto the board the millisecond the
        // engine flips them. The full board is also sent for safety.
        // 2026-08-04 FIX (board morphing to five aces): the engine broadcasts
        // `board` as STRINGS ("9spades") — the hand_history storage format —
        // while the snapshot path sends {rank,suit} objects. Rendering the
        // strings as Card objects made CardImage's unknown-card guard draw
        // EVERY board card as the Ace of Spades until the next snapshot.
        // normalizeCards() accepts both wire formats.
        const board = normalizeCards((evt.data as any).board) as Card[];
        // DOUBLE-BOARD BOMB POT 2026-08-20: board 2 rides the same event.
        const board2 = normalizeCards((evt.data as any).board2 || []) as Card[];
        const stage = ((evt.data as any).stage as string) || 'preflop';

        // Bible V8 §1.16 — chip-to-pot collection animation. Before updating
        // the board, sweep every non-zero bet off the felt into the pot with
        // the cpCollect keyframe (~450ms). After the animation, clear the
        // per-seat bet amounts so the next street starts with empty felt.
        // ANIMATION AUDIT 2026-08-19: the mask used to come solely from
        // tableStateRef.lastBetAmounts — but the engine snapshot (applied
        // synchronously, before this deferred handler runs) zeroes bets on
        // every new street, so `anyToCollect` was usually false and the
        // chips-to-pot sweep never fired. streetBetsRef is written from the
        // discrete PLAYER_ACTION/BLINDS_POSTED events and survives snapshots.
        const currentBets = tableStateRef.current.lastBetAmounts || [];
        const recorded = streetBetsRef.current;
        const collectMask = Array.from({
          length: Math.max(currentBets.length, recorded.length),
        }).map((_, i) => (currentBets[i] || 0) > 0 || (recorded[i] || 0) > 0);
        const anyToCollect = collectMask.some(Boolean);

        if (anyToCollect) {
          // Re-seed any bet the snapshot already zeroed so ChipPhysics is
          // mounted for the sweep it is about to run.
          setTableState((prev) => ({
            ...prev,
            lastBetAmounts: prev.lastBetAmounts.map((amt, i) =>
              collectMask[i] && !(amt > 0) ? recorded[i] || 0 : amt
            ),
          }));
          applyCollectingChipSeats(collectMask);
          // SOUND GAP 2026-08-20: the street sweep — every bet on the felt
          // sliding into the pot, a 550ms cpCollect animation across every
          // seat that wagered — played in COMPLETE SILENCE. It is one of the
          // most physical moments at a real table. Same chip-sweep cue the pot
          // award uses, gated for background multi-table tabs (#175).
          if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playPotCollect();
          if (collectSeatsTimerRef.current) {
            window.clearTimeout(collectSeatsTimerRef.current);
          }
          // cpCollect runs 550ms + 100ms stack stagger; the old 450ms window
          // unmounted the chips at 82% of the keyframe.
          collectSeatsTimerRef.current = window.setTimeout(() => {
            collectSeatsTimerRef.current = null;
            applyCollectingChipSeats(Array(collectMask.length).fill(false));
            // AUDIT-2 FIX 2026-08-20: this used to blind-wipe ALL bets. A wager
            // placed during the 700ms sweep (fast first-to-act on the new
            // street) was erased from the felt AND from streetBetsRef, so the
            // NEXT sweep missed it and those chips just blinked away. Clear
            // only the seats this sweep actually collected.
            streetBetsRef.current = streetBetsRef.current.map((amt, i) =>
              collectMask[i] ? 0 : amt
            );
            setTableState((prev) => ({
              ...prev,
              lastBetAmounts: prev.lastBetAmounts.map((amt, i) => (collectMask[i] ? 0 : amt)),
            }));
          }, 700 * getAnimationSpeed());
        }

        setTableState((prev) => ({
          ...prev,
          communityCards: board,
          communityCards2: board2.length > 0 ? board2 : prev.communityCards2,
          boardStage: stage as BoardStage,
        }));
        // ANIMATION/SOUND AUDIT 2026-08-19: the community-card sound here
        // double-fired with CommunityCards' own stage-transition effect,
        // which plays the nicer per-street stagger (3 snaps on the flop).
        // The component owns the sound now.
        break;
      }
      case 'HOLE_CARDS_UNAVAILABLE': {
        // DEAD-WIRING FIX 2026-08-15: the engine emits this as a last resort
        // after insert_hole_cards fails three times
        // (ServerTableEngineDealing.ts). No client handler existed, so the
        // hero sat dealt-in with no visible cards while the server turn timer
        // ran down and auto-folded them -- a real-money outcome from a
        // transient DB error, with no feedback. Tell the player, and drive the
        // SAME re-fetch path the reconnect flow already uses.
        reportError(
          new Error(`[TablePage] Engine reported hole cards unavailable (table ${tableId})`),
          'TablePage.hole_cards_unavailable'
        );
        toast?.error?.('Could not load your cards - retrying. Use your time bank if needed.');
        heroCardFetchRef.current?.();
        setTimeout(() => heroCardFetchRef.current?.(), 1200);
        break;
      }
      case 'HAND_COMPLETE_EVENT':
      case 'HAND_COMPLETE': {
        /**
         * Dan 2026-08-21 (bug list item 10): "the last player folds, their
         * cards are mucked right away, no need for the countdown light to keep
         * going."
         *
         * The shot clock used to keep draining after the hand was already
         * decided. Nothing here cleared it — the ring only went away when the
         * NEXT state snapshot happened to arrive with currentPlayerSeat 0, and
         * on a fold-around win that is up to a second later. In the meantime a
         * blue countdown was ticking on a seat with no decision left to make.
         *
         * The hand is over the moment this event lands, so the clock stops
         * here, synchronously, on the same frame.
         */
        setTableState((prev) =>
          prev.currentPlayerSeat === 0 && prev.actionTimerDeadline === undefined
            ? prev
            : {
                ...prev,
                currentPlayerSeat: 0,
                actionTimerDeadline: undefined,
                actionTimerStartTime: undefined,
                actionTimerPlayerId: undefined,
              }
        );
        // IMPROVEMENT PASS 2026-08-20: BOMB_POT_COMPLETED had a listener in
        // BombPotOverlay since 2026-08-15 but no emitter anywhere — dead
        // wiring. If an everyone-all-in bomb pot runs out and completes
        // while the 4.5s sequence is still playing, dismiss it with the
        // hand instead of letting the title sit over the showdown.
        // Emitted unconditionally (not gated on bombPotActive, which could
        // be stale in this closure): the overlay ignores it when idle.
        try {
          masterBus.emit('BOMB_POT_COMPLETED', { tableId: tableId || '' });
        } catch {
          /* bus publish is best-effort */
        }
        // ── Share Hand: capture the hand that just finished ─────────────────
        // DEAD-WIRING FIX 2026-08-15. setSharedHandData had zero call sites,
        // and TableModalsLayer gates the modal on `showShareHand &&
        // sharedHandData`. The Share Hand menu item therefore set a flag that
        // could never render anything -- the feature was unreachable on the
        // cash surface for every player. Build the snapshot here, while the
        // board, the pot and the winners are still on screen (they are cleared
        // by the 3s reset timer further down this same case).
        try {
          const st = tableStateRef.current;
          const board = st.communityCards || [];
          const asShareCard = (c: Card): ShareableCard => ({
            rank: c.rank,
            suit: c.suit,
          });
          const asShareAction = (a: {
            seat: number;
            action: string;
            amount?: number;
          }): ShareableAction => {
            const raw = (a.action || '').toLowerCase();
            const mapped: ShareableAction['action'] =
              raw === 'fold'
                ? 'FOLD'
                : raw === 'check'
                  ? 'CHECK'
                  : raw === 'call'
                    ? 'CALL'
                    : raw === 'bet'
                      ? 'BET'
                      : raw === 'raise'
                        ? 'RAISE'
                        : 'ALL_IN';
            return { seat: a.seat, action: mapped, amount: a.amount };
          };
          const byStreet = (name: string) =>
            handActionsRef.current.filter((a) => a.street === name).map(asShareAction);

          const winnerSeats = new Set<number>();
          const winnerRows: { seat: number; amount: number }[] = [];
          for (const [uid, amt] of Object.entries(winnerInfoRef.current?.amounts || {})) {
            const idx = st.players.findIndex((p) => p && p.id === uid);
            if (idx >= 0) {
              winnerSeats.add(idx + 1);
              winnerRows.push({ seat: idx + 1, amount: Number(amt) || 0 });
            }
          }

          const sharePlayers = st.players
            .map((p, i) =>
              p
                ? {
                    seat: i + 1,
                    name: p.name || `Seat ${i + 1}`,
                    // Stack as it was at the top of the hand, not post-payout.
                    stack: handStartStacksRef.current[i + 1] ?? p.stack ?? 0,
                    // Only cards actually visible on screen travel in the link
                    // -- hero's own, plus anything shown down at showdown. A
                    // shared hand must never leak a mucked holding.
                    cards: (p.holeCards || []).length
                      ? (p.holeCards as Card[]).map(asShareCard)
                      : undefined,
                    isHero: i + 1 === st.heroSeat,
                    isWinner: winnerSeats.has(i + 1),
                  }
                : null
            )
            .filter(Boolean) as ShareableHand['players'];

          if (sharePlayers.length > 0) {
            const variant: ShareableHand['variant'] = (
              ['NLH', 'PLO4', 'PLO5', 'PLO6'] as const
            ).includes(st.gameType as any)
              ? (st.gameType as ShareableHand['variant'])
              : 'NLH';
            const flopActions = byStreet('flop');
            const turnActions = byStreet('turn');
            const riverActions = byStreet('river');
            setSharedHandData({
              id: `${tableId || 'table'}-${st.handNumber ?? heroHandRef.current ?? 0}`,
              tableName: st.tableName || 'Club Arena',
              variant,
              stakes: st.blinds || '',
              timestamp: Date.now(),
              buttonSeat: shareButtonSeatRef.current || st.dealerSeat || 0,
              players: sharePlayers,
              preflop: byStreet('preflop'),
              flop:
                board.length >= 3
                  ? { cards: board.slice(0, 3).map(asShareCard), actions: flopActions }
                  : undefined,
              turn:
                board.length >= 4
                  ? { card: asShareCard(board[3]), actions: turnActions }
                  : undefined,
              river:
                board.length >= 5
                  ? { card: asShareCard(board[4]), actions: riverActions }
                  : undefined,
              potTotal: st.pot || 0,
              winners: winnerRows,
            } satisfies ShareableHand);
          }
        } catch (e) {
          // Never let a share snapshot break the table reset.
          reportError(e, 'TablePage.buildSharedHand');
        }

        // ── Achievement / daily-challenge progress ──────────────────────────
        // Fire ONCE per hand for the hero if they were dealt in. Guarded by
        // hand number so HAND_COMPLETE_EVENT + HAND_COMPLETE (or a re-emit)
        // can't double-count. Non-blocking — never delays the table reset.
        {
          const hn = heroHandRef.current;
          const outcome = heroHandOutcomeRef.current;
          if (
            userId &&
            userId !== 'guest' &&
            outcome.dealtIn &&
            hn > 0 &&
            achievementFiredHandRef.current !== hn
          ) {
            achievementFiredHandRef.current = hn;
            // DEAD-WIRING FIX 2026-08-15: MasterBus 'HAND_COMPLETED' has 23
            // subscribers across the app -- SessionHUD profit, Daily
            // Challenges, the Rakeback dashboard, Bankroll / Position / Stake
            // stats, Hand History, the Cashier balance and the BBJ page -- and
            // NOT ONE EMITTER anywhere in the repo. Every one of those
            // surfaces sat stale until a manual reload. Emit it inside the
            // existing once-per-hand guard so a duplicated or re-emitted
            // HAND_COMPLETE cannot double-fire it.
            try {
              /* Dan 2026-08-20: the payload carried only handId + tableId, so
                 nothing downstream could tell a hand the hero WON from one they
                 lost. useTableSession needs exactly that to count handsPlayed
                 and handsWon, which were declared and never written — the
                 Session Complete card showed "0 Hands Played / 0 Hands per
                 Hour / 0% Win Rate" for every session ever played.

                 heroStack rides along for the same reason: peakStack only ever
                 moved on CHIPS_ADDED, so a player who never topped up finished
                 with a Peak Stack of 0 no matter what they held. This is the
                 once-per-hand, dealt-in-guarded emit, which makes it the exact
                 point at which the hero's stack is worth sampling. */
              masterBus.emit('HAND_COMPLETED', {
                handId: String(tableStateRef.current.handNumber ?? hn),
                tableId: tableId || '',
                won: outcome.won === true,
                potWon: Number(outcome.potWon) || 0,
                heroStack:
                  Number(
                    tableStateRef.current.players?.[tableStateRef.current.heroSeat - 1]?.stack
                  ) || 0,
              });
            } catch {
              /* bus publish is best-effort -- never block the table reset */
            }
            achievementTriggerService
              .onHandComplete(userId, {
                won: outcome.won,
                potSize: outcome.potWon,
                handRank: outcome.handRank || undefined,
                showdown: outcome.showdown,
              })
              .catch((e) => reportError(e, 'TablePage.achievementOnHandComplete'));
          }
        }
        // Bible V8 §1.16 — final river bets still on felt must sweep into
        // pot BEFORE the pot-to-winner animation fires (POT_WIN case).
        // ANIMATION AUDIT 2026-08-19: same snapshot-race + short-window fixes
        // as the COMMUNITY_CARDS_DEALT sweep (see that case).
        const finalBets = tableStateRef.current.lastBetAmounts || [];
        const finalRecorded = streetBetsRef.current;
        const finalMask = Array.from({
          length: Math.max(finalBets.length, finalRecorded.length),
        }).map((_, i) => (finalBets[i] || 0) > 0 || (finalRecorded[i] || 0) > 0);
        if (finalMask.some(Boolean)) {
          setTableState((prev) => ({
            ...prev,
            lastBetAmounts: prev.lastBetAmounts.map((amt, i) =>
              finalMask[i] && !(amt > 0) ? finalRecorded[i] || 0 : amt
            ),
          }));
          applyCollectingChipSeats(finalMask);
          if (collectSeatsTimerRef.current) {
            window.clearTimeout(collectSeatsTimerRef.current);
          }
          collectSeatsTimerRef.current = window.setTimeout(() => {
            collectSeatsTimerRef.current = null;
            applyCollectingChipSeats(Array(finalMask.length).fill(false));
            // See the COMMUNITY_CARDS_DEALT sweep: clear only what we collected.
            streetBetsRef.current = streetBetsRef.current.map((amt, i) => (finalMask[i] ? 0 : amt));
            setTableState((prev) => ({
              ...prev,
              lastBetAmounts: prev.lastBetAmounts.map((amt, i) => (finalMask[i] ? 0 : amt)),
            }));
          }, 700 * getAnimationSpeed());
        }
        // ANIMATION AUDIT 2026-08-19: showdown losers' cards used to simply
        // vanish at the 3s reset — no muck animation existed for them. Fly
        // them to the muck during the last ~600ms of the winner display.
        {
          const st = tableStateRef.current;
          // AUDIT-2 FIX 2026-08-20 (winner race): POT_WIN and HAND_COMPLETE can
          // arrive in the SAME frame, and if HAND_COMPLETE is dispatched first
          // winnerInfoRef still holds the PREVIOUS hand's winners — the actual
          // winner would land in loserMask and their cards would fly to the
          // muck. Only build the mask once winners for THIS hand are known;
          // engineWinners (from the snapshot) is a second, independent source.
          const winners = new Set<string>([
            ...(winnerInfoRef.current?.playerIds || []),
            ...(st.engineWinners || []).map((w) => w.userId),
          ]);
          const loserMask = st.players.map(
            (p) => !!(p && !p.isHero && p.showCards && !winners.has(p.id))
          );
          // If we have no winner information at all, a "loser" mask is
          // meaningless — skip the muck rather than risk mucking the winner.
          if (winners.size > 0 && loserMask.some(Boolean)) {
            if (muckTimerRef.current) clearTimeout(muckTimerRef.current);
            // Scaled like the cardFoldOut keyframe it triggers. The showdown
            // result window is 2.6-6.9s server-side, so 2400ms leaves the muck
            // fully visible before the 3s client reset.
            muckTimerRef.current = setTimeout(() => {
              muckTimerRef.current = null;
              setMuckingSeats(loserMask);
              // SOUND GAP 2026-08-20: the losers' cards flying to the muck
              // at showdown animated in silence. The hero's own muck has had
              // a sound since the Show/Muck modal was wired; the table's did
              // not. Same card-slide cue.
              if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playFold();
            }, 2400 * getAnimationSpeed());
          }
        }
        /**
         * Dan 2026-08-21 (items 11 + 16): "the push pot and total animation
         * never triggers" and "the winning hand must be displayed under the
         * board at showdown."
         *
         * Both were this one hard-coded 3000. The engine emits HAND_COMPLETE
         * immediately, then waits `showdownSettleMs` before emitting pot_win —
         * and pot_win is what SETS the winner hand name and STARTS the pot
         * ship. So the clock below was already running for most of the settle
         * before the animation it was supposed to be holding open had even
         * begun. At the old 1600ms settle that left ~1.4s for a 2.2s pot-win
         * float and a hand name nobody had time to read; at the 3 full seconds
         * Dan asked for in item 11 it would have left nothing at all — the
         * label would appear and be wiped in the same frame.
         *
         * The engine already derives its own hold from the shared animation
         * spec (src/config/handCompletionSpec.ts). The client now derives this
         * one from the SAME function, so the table clears exactly when the
         * engine is ready to deal and never a beat before. Changing an
         * animation length in that file moves both sides together.
         */
        const holdMs =
          handCompletionHoldMs({
            wentToShowdown: handShowdownRef.current.wentToShowdown,
            showdownHands: handShowdownRef.current.hands,
          }) * getAnimationSpeed();
        // CA-22: track so unmount can cancel — prevents setTableState on dead page
        if (handCompleteTimerRef.current) clearTimeout(handCompleteTimerRef.current);
        handCompleteTimerRef.current = window.setTimeout(() => {
          handCompleteTimerRef.current = null;
          setTableState((prev) => ({
            ...prev,
            communityCards: [],
            communityCards2: [],
            boardStage: 'preflop',
            engineStage: 'preflop',
            pot: 0,
            sidePots: [],
          }));
          setIsAllInMode(false);
          setAllInEquities([]);
          setWinnerInfo({
            playerIds: [],
            handName: '',
            cardIndices: [],
            amounts: {},
            boardHandNames: null,
          });
          setWinnerParticle((prev) => ({ ...prev, active: false }));
          setMuckingSeats(Array(9).fill(false));
        }, 3000);
        break;
      }

      case 'SHOWDOWN': {
        // This hand reached showdown → feeds the 'showdowns' daily challenge.
        heroHandOutcomeRef.current.showdown = true;
        /**
         * Dan 2026-08-21 (items 11 + 16): the TABLE-level showdown fact, as
         * opposed to `heroHandOutcomeRef.showdown` which is only about hero.
         * The post-hand reset below needs to know whether the board is holding
         * a showdown to read, and how many hands are in it, so it can wait
         * exactly as long as the engine does. Reset at HAND_STARTED.
         */
        handShowdownRef.current = {
          wentToShowdown: true,
          hands: Math.max(
            2,
            (tableStateRef.current.players || []).filter((p) => p && p.showCards).length
          ),
        };
        // Bible V8 §4.6: Showdown — play showdown sound, trigger card reveal animations
        // #175 gated for multi-table: only play on the active tab
        if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playShowdown();
        // Mark board stage so rendering picks up showdown card flips
        setTableState((prev) => ({
          ...prev,
          boardStage: 'showdown',
        }));
        break;
      }

      case 'POT_WIN': {
        // Bible V8 §5.1 + Phase 2 T1-05 (spec §6 Pot Shipping Animation):
        // - Play winner sound
        // - Fire 6-8 staggered chips on a quadratic-bezier arc from the pot
        //   center to each winner's seat position over 400-600ms.
        const winnerIds = ((evt.data as any).winner_ids as string[]) || [];
        const potAmount = ((evt.data as any).pot as number) || 0;
        // 2026-04-16 fix: Server sends hand_name INSIDE the per-winner
        // `winners[]` array, not at the top level. Extract from winners[0]
        // as fallback when top-level hand_name is empty.
        const winnersArray =
          ((evt.data as any).winners as Array<{
            user_id: string;
            amount: number;
            hand_name?: string;
          }>) || [];
        const winHandName =
          ((evt.data as any).hand_name as string) ||
          ((evt.data as any).winning_hand as string) ||
          winnersArray[0]?.hand_name ||
          '';
        const winCardIndices =
          ((evt.data as any).card_indices as number[]) ||
          ((evt.data as any).winning_card_indices as number[]) ||
          [];
        // Round 2 (double board): per-board winner hand names for the board
        // labels — who won the top board with what, who won the bottom.
        const winnersByBoard =
          ((evt.data as any).winners_by_board as Array<{
            board: 1 | 2;
            user_id: string;
            amount: number;
            hand_name?: string;
          }>) || [];
        const boardHandNames: [string, string] | null =
          winnersByBoard.length > 0
            ? [
                winnersByBoard.find((w) => w.board === 1)?.hand_name || '',
                winnersByBoard.find((w) => w.board === 2)?.hand_name || '',
              ]
            : null;

        // Bible V8 §5.1: Set winner info for seat highlight + hand name display
        if (winnerIds.length > 0) {
          // Use per-winner amounts from server when available (accurate for split pots)
          const amounts: Record<string, number> = {};
          if (winnersArray.length > 0) {
            for (const w of winnersArray) amounts[w.user_id] = w.amount;
          } else {
            const sharePerWinner = potAmount / (winnerIds.length || 1);
            for (const wid of winnerIds) amounts[wid] = sharePerWinner;
          }
          setWinnerInfo({
            playerIds: winnerIds,
            handName: winHandName,
            cardIndices: winCardIndices,
            amounts,
            boardHandNames,
          });
          // Write the mirror synchronously too. POT_WIN and HAND_COMPLETE can
          // arrive in the same WS frame, in which case React has not
          // re-rendered yet and the render-time mirror assignment would still
          // hold the previous hand's winners when Share Hand reads it.
          winnerInfoRef.current = {
            playerIds: winnerIds,
            handName: winHandName,
            cardIndices: winCardIndices,
            amounts,
            boardHandNames,
          };
          // Bible V8 §5.1: Tiered celebration per docs/_archive/POKERBROS_UPGRADE_PLAN.md §3.7
          // < 10 BB = gold glow only (default), 10-50 BB = confetti,
          // 50+ BB = confetti + screen shake + bigWin sound
          if (winnerIds.includes(userId)) {
            // Accumulate the hero's win for the achievement/challenge fire at
            // HAND_COMPLETE (POT_WIN can fire once per pot on split/side pots).
            heroHandOutcomeRef.current.won = true;
            heroHandOutcomeRef.current.potWon += amounts[userId] || 0;
            if (winHandName) heroHandOutcomeRef.current.handRank = winHandName;
            const bb = safeBB(tableStateRef.current.blinds, 1);
            const winBB = (amounts[userId] || potAmount) / bb;
            if (winBB >= 10) {
              setShowConfetti(true);
            }
            if (winBB >= 50) {
              // Screen shake for massive win
              const tableEl = document.querySelector('.table-page');
              if (tableEl) {
                tableEl.classList.add('table-page--shake');
                setTimeout(() => tableEl.classList.remove('table-page--shake'), 600);
              }
              // ANIMATION/SOUND AUDIT 2026-08-19: playBigWin fired here AND
              // inside playWinSound (called below) — double celebration.
              // playWinSound owns the escalation now.
            }
          }
          // Bible V8 §5.1: Particle burst from first winner's seat position
          const firstWinnerIdx = tableStateRef.current.players.findIndex(
            (p) => p && winnerIds.includes(p.id)
          );
          if (firstWinnerIdx >= 0) {
            // AUDIT FIX 2026-07-19: seatPositions is physical-seat-indexed
            // (players[] index = seatNumber-1); the +1 sent the burst to the
            // seat one past the winner. The PLAYER_ACTION path uses no offset.
            const seatPct = seatPositions[firstWinnerIdx] || { x: 50, y: 50 };
            setWinnerParticle({
              active: true,
              // 2026-08-04 FIX: scaler-relative percentages, not viewport
              origin: seatPctToViewportPx(tableScalerRef.current, seatPct),
              intensity: potAmount > 500 ? 2 : 1, // Big win = 2x particle intensity
            });
          }
        }

        // Bible V8 §4.19: Show/muck prompt when hero wins without showdown
        // Skip if autoMuckWinners is enabled (user prefers silent muck)
        //
        // ── Dan 2026-08-18: this prompt was appearing AT showdown ──
        //
        // The `boardStage !== 'showdown'` test is the right intent reading the
        // wrong source. boardStage is only moved to 'showdown' by setTableState
        // in the SHOWDOWN handler, and tableStateRef is synced to tableState
        // inside a useEffect - so the ref only catches up after React commits
        // a render. The server emits SHOWDOWN and POT_WIN back to back, so
        // when this line runs the ref still says 'river', the test passes, and
        // the hero is asked "Show or Muck?" on a hand that already went to
        // showdown. That is the Show Cards button at showdown Dan reported.
        //
        // heroHandOutcomeRef.showdown is the same fact recorded synchronously
        // (set in the SHOWDOWN case, reset per hand at HAND_START), so it is
        // already true by the time POT_WIN lands. Test it first, and keep the
        // boardStage check as a fallback for any path that sets the stage
        // without emitting SHOWDOWN.
        if (
          winnerIds.length > 0 &&
          winnerIds.includes(userId) &&
          !heroHandOutcomeRef.current.showdown &&
          tableStateRef.current.boardStage !== 'showdown' &&
          !userSettingsRef.current.autoMuckWinners
        ) {
          const heroPlayer = tableStateRef.current.players.find((p) => p?.id === userId);
          setHandRevealWinnerId(userId);
          setHandRevealWinnerName(heroPlayer?.name || 'You');
          // Dan 2026-08-18: holeCards may contain nulls (cards the player did
          // not elect to show). This modal only ever displays the hero's OWN
          // hand, which is always fully populated, so drop the null slots
          // rather than widen the modal's type.
          setHandRevealCards(
            (heroPlayer?.holeCards || []).filter((c): c is NonNullable<typeof c> => c != null)
          );
          setHandRevealHandId(`${tableStateRef.current.handNumber || Date.now()}`);
          setShowHandRevealModal(true);
          // Auto-close after 6s if no action taken
          // CA-20: track so unmount can cancel — prevents setShowHandRevealModal on dead page
          if (handRevealTimerRef.current) clearTimeout(handRevealTimerRef.current);
          handRevealTimerRef.current = setTimeout(() => {
            handRevealTimerRef.current = null;
            setShowHandRevealModal(false);
          }, 6000);
        }

        if (winnerIds.length > 0 && winnerIds.includes(userId)) {
          playWinSound(potAmount);
          // Bible V8 §5.4: heavy celebration haptic on hero win
          import('../services/HapticService').then(({ haptic }) => haptic.heavy());
        }
        if (winnerIds.length > 0 && potAmount > 0) {
          // ── Dan 2026-08-20: "many steps and animations are being skipped" ──
          //
          // A real hand ships the pot in TWO ordered beats:
          //   1. every remaining bet sweeps off the felt INTO the pot
          //   2. only then does the pot travel to the winner
          //
          // The server emits WINNERS (-> pot_win) BEFORE hand_complete, and the
          // final chip sweep is armed by the HAND_COMPLETE handler. So the pot
          // used to start flying to the winner in the SAME frame the losing
          // bets were still flying toward it — the two beats collapsed into one
          // blur and the pot appeared to teleport. On an uncontested "raise and
          // take it" win, that is the entire animation the player sees.
          //
          // Delay the ship by exactly the sweep window when chips are still on
          // the felt, so the beats read in order. Everything below is captured
          // now and fired later, because tableStateRef will have been cleared
          // by the time the delayed callback runs.
          const betsStillOnFelt =
            (tableStateRef.current.lastBetAmounts || []).some((a) => (a || 0) > 0) ||
            streetBetsRef.current.some((a) => (a || 0) > 0) ||
            collectingChipSeatsRef.current.some(Boolean);
          const shipDelayMs = betsStillOnFelt ? 700 * getAnimationSpeed() : 0;
          // Pot center in screen px (mirrors the constant 50,45 used by
          // chip-to-pot animations elsewhere).
          // 2026-08-04 FIX: scaler-relative percentages, not viewport. The old
          // window.innerWidth/Height math stranded pot-win chips at the screen
          // edges on desktop (split pots parked one chip on EACH edge).
          const potPos = seatPctToViewportPx(tableScalerRef.current, POT_ANCHOR_PCT);
          // Resolve each winner's seat from the current player list (rotated
          // positions already account for hero-at-bottom view).
          const events: ChipAnimationEvent[] = [];
          const potWinFloatPlans: Array<{
            fromX: number;
            fromY: number;
            toX: number;
            toY: number;
            amount: number;
          }> = [];
          for (const wid of winnerIds) {
            // SeatPlayer.id is the userId — players[] index = seatNumber - 1.
            const seatIdx = tableStateRef.current.players.findIndex((p) => p?.id === wid);
            if (seatIdx < 0) continue;
            // AUDIT FIX 2026-07-19: physical-seat index — no +1 (see above).
            const seatPct = seatPositions[seatIdx] || { x: 50, y: 50 };
            const winnerPos = seatPctToViewportPx(tableScalerRef.current, seatPct);
            // ANIMATION AUDIT 2026-08-19: use the ACCURATE per-winner amount
            // (server winners[] map, mirrored synchronously above) — an even
            // potAmount/n split labelled side-pot chops with wrong numbers.
            const share =
              winnerInfoRef.current?.amounts?.[wid] ?? potAmount / (winnerIds.length || 1);
            // createPotToWinnerEvent already returns a fan of 3-8 chips with
            // bezier arc, staggered 40ms each, 600ms duration — spec match.
            events.push(...createPotToWinnerEvent(potPos, winnerPos, share));
            // Dan 2026-08-21: the floating "+N" rides with this fan and ends
            // above the winner's seat naming the exact share they won —
            // accurate per winner, so chops read right too.
            potWinFloatPlans.push({
              fromX: potPos.x,
              fromY: potPos.y,
              toX: winnerPos.x,
              toY: winnerPos.y,
              amount: share,
            });
          }
          if (events.length > 0) {
            const fireFan = () => {
              setChipAnimations((prev) => [...prev, ...events]);
              // Dan 2026-08-21: launch each winner's floating "+N" in the same
              // frame as their chip fan so the number travels WITH the pot.
              for (const plan of potWinFloatPlans) {
                spawnPotWinFloat(plan.fromX, plan.fromY, plan.toX, plan.toY, plan.amount);
              }
              // Bible V8 §5.3: pot collect sweep sound — synced with chip animation
              // #175 gated for multi-table: only play on the active tab
              if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playPotCollect();
            };
            if (shipDelayMs > 0) {
              if (potShipTimerRef.current) clearTimeout(potShipTimerRef.current);
              potShipTimerRef.current = setTimeout(() => {
                potShipTimerRef.current = null;
                fireFan();
              }, shipDelayMs);
            } else {
              fireFan();
            }
          }

          // Dan 2026-08-19, bug list item 6: push the POT ITSELF to the winner,
          // not just a fan of chips. `.pot-display--collect` and its
          // --collect-dx/--collect-dy properties have been in the stylesheet
          // all along, documented as "set by JS" — nothing ever set them, so
          // the pot simply vanished at the end of every hand.
          //
          // Single winner only: on a chop there is no one seat to push to, and
          // the per-winner chip fan above already tells that story.
          if (winnerIds.length === 1) {
            const soleSeatIdx = tableStateRef.current.players.findIndex(
              (p) => p?.id === winnerIds[0]
            );
            const soleSeatPct = soleSeatIdx >= 0 ? seatPositions[soleSeatIdx] : null;
            if (soleSeatPct) {
              const winnerPx = seatPctToViewportPx(tableScalerRef.current, soleSeatPct);
              const collectTo = {
                dx: Math.round(winnerPx.x - potPos.x),
                dy: Math.round(winnerPx.y - potPos.y),
              };
              // Beat 2 — the pot itself travels, AFTER the sweep has landed.
              const startPush = () => {
                setPotCollectTo(collectTo);
                if (potCollectTimerRef.current) clearTimeout(potCollectTimerRef.current);
                // Slightly longer than --pd-collect-duration (0.5s) so the pot is
                // never yanked back to centre mid-slide.
                potCollectTimerRef.current = setTimeout(() => {
                  potCollectTimerRef.current = null;
                  setPotCollectTo(null);
                }, 700 * getAnimationSpeed());
              };
              if (shipDelayMs > 0) {
                if (potPushDelayTimerRef.current) clearTimeout(potPushDelayTimerRef.current);
                potPushDelayTimerRef.current = setTimeout(() => {
                  potPushDelayTimerRef.current = null;
                  startPush();
                }, shipDelayMs);
              } else {
                startPush();
              }
            }
          }
        }
        break;
      }
      // HAND_COMPLETE case is handled above with chip-collect + reset in
      // one place (Bible V8 §1.16). Duplicate case removed 2026-04-14.

      // ═══════════════════════════════════════════════════════════════════
      // Round 20 — Engine→FE event coverage gap fixes (2026-04-29)
      // ═══════════════════════════════════════════════════════════════════
      // Bible V8 §1.16: discrete events, never inferred from snapshot diffs.
      // Audit found 21 engine-emitted events with no FE handler — UI moments
      // that the engine fired but no animation / modal / haptic ever lit up
      // because nothing was listening. Re-broadcast onto masterBus so existing
      // component-level listeners pick them up; add direct UI side-effects
      // for the highest-impact ones (BBJ celebration + time-bank warning).

      case 'INSURANCE_OFFERS': {
        masterBus.emit('INSURANCE_OFFERED', evt.data as any);
        break;
      }
      case 'RIT_OFFER': {
        masterBus.emit('RIT_OFFERED', evt.data as any);
        break;
      }
      case 'RIT_CHOOSER_DECIDED': {
        masterBus.emit('RIT_CHOOSER_DECIDED', evt.data as any);
        break;
      }
      case 'RIT_RESULT': {
        masterBus.emit('RIT_RESOLVED', evt.data as any);
        break;
      }
      case 'BBJ_HIT': {
        // ANIMATION/SOUND AUDIT 2026-08-19: was playBigWin — the dedicated
        // jackpot fanfare existed and was never wired to the engine event.
        if (soundService.isEnabled()) soundService.playBadBeatJackpot();
        import('../services/HapticService').then(({ haptic }) => haptic.heavy());
        masterBus.emit('BBJ_HIT', evt.data as any);
        break;
      }
      case 'BBJ_PAYOUT_COMPLETE': {
        masterBus.emit('BBJ_PAYOUT_COMPLETE', evt.data as any);
        break;
      }
      case 'POT_DISTRIBUTED': {
        /* Stamp the table on the way out.
           This socket only ever carries THIS table, so the id is known here
           for certain. The engine does put table_id in the payload today, but
           useTableSession now scopes the session's biggest-pot to the table
           that owns it, and an event that arrives without a table is dropped
           rather than misattributed. Deriving the id here instead of trusting
           the payload means a future engine change cannot quietly turn
           "Biggest Pot" back into a zero. */
        masterBus.emit('POT_DISTRIBUTED', {
          ...(evt.data as Record<string, unknown>),
          tableId: tableId || (evt.data as { table_id?: string })?.table_id,
        } as any);
        break;
      }
      case 'SHOWDOWN_CARDS_REVEALED': {
        masterBus.emit('SHOWDOWN_CARDS_REVEALED', evt.data as any);
        break;
      }
      case 'TIME_BANK_ACTIVATED': {
        masterBus.emit('TIME_BANK_ACTIVATED', evt.data as any);
        break;
      }
      case 'TIME_BANK_LOW': {
        import('../services/HapticService').then(({ haptic }) => haptic.light());
        masterBus.emit('TIME_BANK_LOW', evt.data as any);
        break;
      }
      case 'TIME_BANK_TIMEOUT': {
        masterBus.emit('TIME_BANK_TIMEOUT', evt.data as any);
        break;
      }
      case 'LEVEL_UP': {
        masterBus.emit('TOURNAMENT_LEVEL_UP', evt.data as any);
        break;
      }
      case 'SEAT_TAKEN': {
        masterBus.emit('SEAT_TAKEN', evt.data as any);
        break;
      }
      case 'SEAT_LEFT': {
        masterBus.emit('SEAT_LEFT', evt.data as any);
        break;
      }
      case 'TABLE_PAUSED': {
        masterBus.emit('TABLE_PAUSED', evt.data as any);
        break;
      }
      case 'TABLE_RESUMED': {
        masterBus.emit('TABLE_RESUMED', evt.data as any);
        break;
      }
      case 'TABLE_LOCKED': {
        masterBus.emit('TABLE_LOCKED', evt.data as any);
        break;
      }
      case 'TABLE_UNLOCKED': {
        masterBus.emit('TABLE_UNLOCKED', evt.data as any);
        break;
      }
      case 'RABBIT_HUNT_AVAILABLE': {
        masterBus.emit('RABBIT_HUNT_AVAILABLE', evt.data as any);
        break;
      }
      case 'ALL_IN_EQUITY': {
        masterBus.emit('ALL_IN_EQUITY', evt.data as any);
        break;
      }
      case 'ONLINE_COUNT': {
        masterBus.emit('ONLINE_COUNT', evt.data as any);
        break;
      }
    }
  }, [engineLastEvent]);

  // Supabase Realtime fallback: process lastEvent if engine WS is not connected.
  // When engine WS IS connected, it handles all events above; this block is
  // inert. When engine WS is unavailable, this block processes the same event
  // types from Supabase Realtime (legacy path) so animations still work.
  // NOTE: The switch block is NOT duplicated here. Instead, if Supabase Realtime
  // sends an event, we log it; in production the engine WS should be the only path.
  useEffect(() => {
    if (!lastEvent || engineWsStatus === 'connected') return;
    const rawType = (lastEvent as { type?: string }).type || '';
    console.debug('[TablePage] Supabase Realtime event (engine WS not connected):', rawType);
  }, [lastEvent, engineWsStatus]);

  // ═══════════════════════════════════════════════════════════════════════
  // Previous hand tracking — detects hand number change, captures result
  // for the bottom-left PreviousHandCard HUD widget
  // ═══════════════════════════════════════════════════════════════════════
  const prevHandNumberRef = useRef<number>(0);
  const prevHandStackRef = useRef<number>(0);
  const heroFoldedInCurrentHandRef = useRef(false);

  // ═══════════════════════════════════════════════════════════════════════
  // Dan 2026-08-15 — Session Stats lifecycle.
  //
  // startSession()/endSession() used to live inside SessionHUD's mount
  // effect, which meant the "session" began when you OPENED the stats panel
  // and was torn down when you closed it. Opening the panel therefore always
  // showed a freshly zeroed session, and closing it discarded the history.
  // The session belongs to the SEAT, not to a modal, so it is owned here and
  // runs for as long as hero is sitting. SessionHUD is now a pure reader.
  // ═══════════════════════════════════════════════════════════════════════
  const sessionStartedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tableId || !userId || userId === 'guest') return;
    const seated = tableState.heroSeat > 0;
    const key = `${tableId}:${userId}`;

    if (seated && sessionStartedForRef.current !== key) {
      const heroStack = tableState.players[tableState.heroSeat - 1]?.stack || 0;
      // Guard against seeding the session with a 0 stack from a snapshot that
      // has the seat but not yet the chips — buyInTotal would be wrong for the
      // whole session and every P&L reading would be inflated by the buy-in.
      if (heroStack > 0) {
        sessionStatsService.startSession(tableId, userId, heroStack, safeBB(tableState.blinds));
        sessionStartedForRef.current = key;
        prevHandStackRef.current = heroStack;
      }
    } else if (!seated && sessionStartedForRef.current === key) {
      sessionStatsService.endSession(tableId);
      sessionStartedForRef.current = null;
    }
  }, [tableId, userId, tableState.heroSeat, tableState.players, tableState.blinds]);

  // End the session on unmount too (navigating away, or MultiTablePage
  // closing this tab) so the session_history row is written.
  useEffect(() => {
    return () => {
      if (sessionStartedForRef.current && tableId) {
        sessionStatsService.endSession(tableId);
        sessionStartedForRef.current = null;
      }
    };
  }, [tableId]);

  // Track if hero folds during the current hand (status changes mid-hand)
  useEffect(() => {
    const heroPlayer = tableState.players[tableState.heroSeat - 1];
    if (heroPlayer?.status === 'folded') {
      heroFoldedInCurrentHandRef.current = true;
    }
  }, [tableState.players, tableState.heroSeat]);

  // Detect hand number change → capture previous hand result
  useEffect(() => {
    const handNum = tableState.handNumber ?? 0;
    const heroPlayer = tableState.players[tableState.heroSeat - 1];
    const heroStack = heroPlayer?.stack || 0;

    if (handNum > 0 && handNum !== prevHandNumberRef.current) {
      // Hand number changed — the previous hand just completed
      if (prevHandNumberRef.current > 0 && heroPlayer) {
        const stackChange = heroStack - prevHandStackRef.current;
        const heroDidWin = stackChange > 0;
        setPrevHandResult({
          handNumber: prevHandNumberRef.current,
          result: stackChange,
          didWin: heroDidWin,
          didFold: heroFoldedInCurrentHandRef.current,
        });
        // Track hands played + wins for mini stats card
        handsPlayedRef.current++;
        if (heroDidWin) handsWonRef.current++;

        // Dan 2026-08-15 — THE Session Stats fix. SessionStatsService had a
        // complete, correct recordHand() that computed hands, VPIP%, PFR%,
        // P&L, BB/100, hands/hr and the sparkline trajectory — and NOTHING in
        // the entire app ever called it. Every field except the clock sat at
        // its zeroed initial value forever, which is exactly why the panel
        // "only recorded the time". This is that missing call.
        if (tableId) {
          sessionStatsService.recordHand(
            tableId,
            heroStack,
            heroDidWin,
            heroVpipThisHandRef.current,
            heroPfrThisHandRef.current
          );
        }
      }
      // Reset per-hand voluntary-action flags for the hand just starting.
      heroVpipThisHandRef.current = false;
      heroPfrThisHandRef.current = false;
      prevHandNumberRef.current = handNum;
      prevHandStackRef.current = heroStack;
      heroFoldedInCurrentHandRef.current = false; // Reset for new hand
      // Rabbit Hunt: Reset for new hand
      setIsRabbitAvailable(false);
      serverRabbitCardsRef.current = [];
      setCurrentBoard([]);
      // NOTE: the deal animation is triggered by the discrete HAND_STARTED
      // handler (single source). AUDIT FIX 2026-07-19: the redundant bump that
      // used to live here was removed — now that handNumber advances via the
      // snapshot merge, this effect fires per hand too, and a second bump here
      // double-triggered the deal animation.
    }
  }, [tableState.handNumber, tableState.heroSeat, tableState.players]);

  // Update players from presence state
  // 2026-08-22: GHOST-SEAT GUARD. Once the engine snapshot has arrived, the
  // engine is the only authority on who sits where — Supabase presence lags
  // seat changes and lingers after leaves, and this merge used to inject a
  // 0-stack "ghost" player into a seat the engine says is empty (visible
  // flicker, and validateAndExecuteAction reads players[heroSeat-1], so a
  // ghost in the hero seat could block real actions). Presence may seed seats
  // ONLY before the first engine snapshot (bootstrap), and afterwards may
  // only backfill a missing avatar for the SAME player id.
  const engineSnapArrivedRef = useRef(false);
  if (engineSnapshot !== null) engineSnapArrivedRef.current = true;
  useEffect(() => {
    if (!presence) return;

    // Merge presence data with existing players (use callback to avoid stale state)
    setTableState((prev) => {
      const updatedPlayers = [...prev.players];
      let hasChanges = false;
      const engineAuthoritative = engineSnapArrivedRef.current;

      presence.players.forEach((p) => {
        if (p.seatNumber !== undefined) {
          const seatIdx = p.seatNumber - 1;
          if (seatIdx >= 0 && seatIdx < updatedPlayers.length) {
            const existing = updatedPlayers[seatIdx];
            if (engineAuthoritative) {
              if (existing && existing.id === p.userId && !existing.avatar && p.avatar) {
                updatedPlayers[seatIdx] = { ...existing, avatar: p.avatar };
                hasChanges = true;
              }
              return;
            }
            // Only update if actually different to prevent loops
            if (!existing || existing.id !== p.userId) {
              updatedPlayers[seatIdx] = {
                id: p.userId,
                name: p.username,
                // FIX: Preserve existing avatar from DB — don't overwrite with empty presence avatar
                avatar:
                  p.avatar || existing?.avatar || (p.userId === userId ? heroAvatarUrl : '') || '',
                stack: existing?.stack ?? 0,
                status: existing?.status ?? 'active',
                isHero: p.userId === userId,
                showCards: existing?.showCards ?? false,
              };
              hasChanges = true;
            }
          }
        }
      });

      // Only update state if there were actual changes
      return hasChanges ? { ...prev, players: updatedPlayers } : prev;
    });
  }, [presence, userId]);

  // Get seat positions based on table size
  // Dan 2026-08-17: per-size rings — 7-max and 8-max tables (525 live in the
  // fleet) used to fall into the 6-seat ring and seats 7-8 had no position.
  const baseSeatPositions = seatLayoutFor(tableState.maxPlayers);

  // SEAT AUTO-ROTATION — hero always renders at bottom-centre.
  // seatRotationMap[physicalSeatIndex] = { pos, visualIndex }. Already rotated:
  // anything indexing it must NOT rotate again (that bug put the dealer button
  // on the wrong seat). See rotateSeatsForHero.
  const seatRotationMap = useMemo(
    () => rotateSeatsForHero(baseSeatPositions, tableState.heroSeat),
    [baseSeatPositions, tableState.heroSeat]
  );

  // The rake the Game Rules modal falls back to when nothing overrides it.
  // Display only, and it must stay equal to what the server takes — the full
  // story of why lives with resolveDisplayRake in src/lib/rakeOverride.ts.
  const displayRakeConfig = useMemo(
    () => resolveDisplayRake(tableState.blinds, tableState.gameType),
    [tableState.blinds, tableState.gameType]
  );

  const seatPositions = useMemo(() => seatRotationMap.map((s) => s.pos), [seatRotationMap]);

  // Throw targets in scaler pixels, keyed by 1-indexed seat number to match
  // ThrowEvent.fromSeat/toSeat. The animation layer must be mounted INSIDE
  // .table-scaler for these to line up — see seatPixelMap for why.
  const throwSeatPositions = useMemo(
    () => seatPixelMap(seatPositions, scalerSize),
    [seatPositions, scalerSize]
  );

  // ── Dealer Button seat index ──
  // AUDIT FIX 2026-07-19: DealerButton indexes `seatPositions`, which is ALREADY
  // physical-seat-indexed AND already hero-rotated (seatPositions[physIdx] =
  // rotated screen pos for physical seat physIdx). Feeding it a separately
  // hero-rotated visual index applied the rotation TWICE, rendering the button
  // at the wrong seat whenever the hero wasn't physical seat 1. Pass the plain
  // physical index (dealerSeat - 1).
  const dealerVisualIndex = useMemo(() => {
    if (tableState.dealerSeat <= 0) return -1;
    return tableState.dealerSeat - 1;
  }, [tableState.dealerSeat]);

  // Find player at specific seat (1-indexed)
  const getPlayerAtSeat = useCallback(
    (seatNumber: number): SeatPlayer | null => {
      return tableState.players[seatNumber - 1] ?? null;
    },
    [tableState.players]
  );

  /**
   * Dan 2026-08-21 (bug list item 15): "display the current strength of the
   * hero's hand under their box total — preflop, on the flop, on the turn and
   * river. It should change dynamically."
   *
   * `src/utils/handEvaluator.ts` already had everything needed — including the
   * Omaha exactly-two-from-hand rule and the wheel-straight case — and had no
   * caller anywhere in the app. This is that caller.
   *
   * Preflop it returns null (four cards is not a hand), so instead of guessing
   * we say the one true thing about a starting hand: whether it is a pair, and
   * otherwise what the high card is. Once the flop lands the real evaluator
   * takes over and the label updates itself on every street.
   *
   * Memoised on the cards and the variant, so it runs when the board changes
   * rather than on every timer tick.
   */
  const heroHandStrength = useMemo<string | null>(() => {
    const hero = tableState.players[tableState.heroSeat - 1];
    if (!hero || !hero.isHero) return null;
    if (hero.status === 'folded') return null;
    const hole = (hero.holeCards || []).filter((c): c is Card => !!c);
    if (hole.length < 2) return null;
    const board = (tableState.communityCards || []).filter((c): c is Card => !!c);

    if (board.length === 0) {
      const ranks = hole.map((c) => String(c.rank).toUpperCase());
      const counts = new Map<string, number>();
      for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
      let best: { rank: string; n: number } | null = null;
      for (const [rank, n] of counts) {
        if (!best || n > best.n || (n === best.n && RANK_ORDER(rank) > RANK_ORDER(best.rank))) {
          best = { rank, n };
        }
      }
      if (!best) return null;
      if (best.n >= 4) return 'Four of a Kind';
      if (best.n === 3) return 'Three of a Kind';
      if (best.n === 2) return 'Pair';
      const high = ranks.reduce((a, b) => (RANK_ORDER(b) > RANK_ORDER(a) ? b : a));
      return `${RANK_WORD(high)} High`;
    }

    try {
      const best = bestFive(hole, board, tableState.gameType);
      return best?.name ?? null;
    } catch {
      // A malformed card must never take the table down over a label.
      return null;
    }
  }, [tableState.players, tableState.heroSeat, tableState.communityCards, tableState.gameType]);

  // Handle seat click (sit down at empty seat)
  const handleSeatClick = (seatNumber: number) => {
    // Validate seat is empty before showing buy-in modal
    const seatIdx = seatNumber - 1;
    if (seatIdx >= 0 && seatIdx < tableState.players.length && tableState.players[seatIdx]) {
      // Seat is occupied — ignore click
      console.debug('[Seat] Seat', seatNumber, 'is occupied - ignoring click');
      return;
    }
    // FIX 132: Don't allow sitting if already seated at this table
    // Check THREE sources: heroSeatRef (instant), heroSeat (state), and players array scan
    if (heroSeatRef.current > 0) {
      console.debug(
        '[Seat] Hero already seated (ref) at seat',
        heroSeatRef.current,
        '- ignoring click'
      );
      return;
    }
    if (tableState.heroSeat > 0) {
      console.debug('[Seat] Hero already seated at seat', tableState.heroSeat, '- ignoring click');
      return;
    }
    const existingHeroIdx = tableState.players.findIndex((p) => p && p.id === userId);
    if (existingHeroIdx >= 0) {
      console.debug(
        '[Seat] Hero found at seat',
        existingHeroIdx + 1,
        'via player scan - ignoring click'
      );
      return;
    }
    // Block if buy-in is already in progress (race condition guard)
    if (buyInProcessingRef.current) {
      console.debug('[Seat] Buy-in already processing - ignoring click');
      return;
    }
    // Block if buy-in modal already open
    if (showBuyInModal) {
      console.debug('[Seat] Buy-in modal already open - ignoring click');
      return;
    }
    if (pendingSeat !== null) {
      console.debug('[Seat] A seat reservation is already pending - ignoring click');
      return;
    }
    // ── SEAT-FIRST: buy the seat, do not open the cash buy-in range ──
    if (seatFirstBuyIn) {
      if (seatFirstPending) return;
      setSeatFirstPending(true);
      setPendingSeat(seatNumber); // paint it taken this frame
      void (async () => {
        try {
          const { data, error } = await supabase.rpc('fn_take_seat_and_buy_in', {
            p_table_id: tableId,
            p_seat_number: seatNumber,
          });
          const res = (data ?? {}) as {
            ok?: boolean;
            reason?: string;
            seat_number?: number;
            seats_taken?: number;
            seats_needed?: number;
            starts_now?: boolean;
          };
          if (error || !res.ok) {
            setPendingSeat(null);
            const reason = error?.message || res.reason || '';
            const msg = /seat_taken/.test(reason)
              ? 'That Seat Was Just Taken'
              : /insufficient/.test(reason)
                ? 'Not Enough Chips For This Buy In'
                : /already_started/.test(reason)
                  ? 'This Game Has Already Started'
                  : 'Could Not Take That Seat, Please Try Again';
            toast?.error?.(msg);
            return;
          }
          // Seated. The realtime seats subscription paints the seat; the
          // engine starts the game the moment the last seat is sold.
          const mySeat = res.seat_number ?? seatNumber;
          heroSeatRef.current = mySeat;
          setTableState((prev) => ({ ...prev, heroSeat: mySeat }));
          if (res.starts_now) {
            toast?.success?.('Seats Full, Game Starting');
          } else {
            // Dan 2026-08-21: "THEY ARE SIMPLY SECURING A SEAT." Say exactly
            // that — chips arrive when the spin resolves and play begins.
            const left = Math.max(0, (res.seats_needed ?? 0) - (res.seats_taken ?? 0));
            toast?.success?.(
              left === 1
                ? 'Seat Reserved, Waiting For 1 More Player'
                : `Seat Reserved, Waiting For ${left} More Players`
            );
          }
        } catch (err) {
          setPendingSeat(null);
          reportError(err as Error, 'TablePage.seat_first_buy_in');
          toast?.error?.('Could Not Take That Seat, Please Try Again');
        } finally {
          setSeatFirstPending(false);
        }
      })();
      return;
    }

    console.debug('[Seat] Opening buy-in modal for seat', seatNumber);
    // Paint the seat as taken THIS FRAME, before any network work starts.
    setPendingSeat(seatNumber);
    setSelectedSeat(seatNumber);
    setShowBuyInModal(true);
    // Fire-and-forget: update presence (non-blocking — do NOT await)
    updateSeat(seatNumber).catch((e) => console.warn('[Seat] Presence update failed:', e));
  };

  //broadcastLocalHandState removed — server broadcasts state authoritatively

  // Unified Table Timer Logic (Phase M) - Moved out of the way of all earlier references.
  // 2026-04-14 CRITICAL FIX (Dan E2E bug "engine skipped my turn"):
  //   The previous gate was `currentPlayerSeat === heroSeat && isHandInProgress`.
  //   Both fields default to 0 between hands / during snapshot races, so
  //   `0 === 0` returned true for a microsecond on every snapshot churn,
  //   causing ActionPanel to mount/unmount in flicker bursts. Hero saw the
  //   action buttons flash on then off and could not click. Adding the
  //   explicit `> 0` guards eliminates the false-trigger.
  const isHeroTurnContext =
    tableState.heroSeat > 0 &&
    tableState.currentPlayerSeat > 0 &&
    tableState.currentPlayerSeat === tableState.heroSeat &&
    tableState.isHandInProgress;

  /**
   * Phase 1.3 PR-C+D: thin wrapper around submitAction that routes server-side
   * rejections into the ActionErrorToast. submitAction never throws — it always
   * resolves with `{success, error?, code?, hint?}` — so the old
   * `.catch(console.warn)` pattern silently swallowed every rejection. This
   * wrapper inspects the result and, on `success === false`, fills
   * actionErrorData so the toast renders. Network-level throws still hit the
   * fallback catch and surface as a generic 'Server unreachable' toast.
   */
  /**
   * The ONE door to the felt's error toast.
   *
   * Dan 2026-08-21, screenshot: "The Table Is Busy - Please Try Again" sitting
   * over the felt. That message is a 429 that four backoff retries had already
   * exhausted, so by the time a player reads it the client has moved on, and
   * the loop that produced it produces it again on the next action. Same for
   * "Server unreachable", "Table not ready - reconnecting" and the seat
   * resync notice: all of them describe the client repairing itself, none of
   * them asks the player to do anything.
   *
   * A genuine rejection still shows. "Raise is below the minimum" arrives with
   * a hint and an Apply button, and swallowing that would leave a player
   * pressing a button that silently does nothing.
   */
  const showActionError = useCallback((data: ActionErrorData | null) => {
    if (data && !shouldSurfaceError(data.error)) {
      console.warn('[Table] suppressed self-healing action error:', data.error);
      return;
    }
    setActionErrorData(data);
  }, []);

  const submitActionWithToast = useCallback(
    async (
      tid: string,
      uid: string,
      action: string,
      amount?: number,
      callsite?: string
    ): Promise<boolean> => {
      try {
        const res = await submitAction(tid, uid, action, amount);
        if (!res.success) {
          showActionError({
            error: safeErrorMessage(res.error, 'Action rejected'),
            code: res.code,
            hint: res.hint as ActionErrorData['hint'],
          });
          if (callsite) console.warn(`[Table] Server ${action} rejected (${callsite}):`, res);
          return false;
        }
        return true;
      } catch (err) {
        showActionError({ error: 'Server unreachable' });
        if (callsite) console.warn(`[Table] Server ${action} threw (${callsite}):`, err);
        return false;
      }
    },
    []
  );

  /**
   * BUG 026 FIX — restore instant "real-time feel" on action buttons.
   *
   * Rather than wait for the server's WS PLAYER_ACTION broadcast to paint the
   * hero's last-action tag and bet amount (which adds ~150-500ms of perceived
   * lag), we mutate tableState optimistically the moment hero clicks. When
   * the WS echo arrives (same value) it's idempotent — no flicker. If the
   * server rejects, the caller invokes the returned revert() to restore the
   * prior snapshot so the UI doesn't show a phantom fold/call.
   *
   * Returns a revert() thunk. Always safe to call: no-op if seat/index is out
   * of range.
   */
  const applyOptimisticHeroAction = useCallback(
    (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number): (() => void) => {
      const heroSeat = tableState.heroSeat;
      const idx = heroSeat - 1;
      if (idx < 0) return () => {};

      // Map UI action name → server's lastAction enum (what the WS event writes).
      const labelMap: Record<string, string> = {
        fold: 'fold',
        check: 'check',
        call: 'call',
        raise: 'raise',
        allin: 'all_in',
      };
      const label = labelMap[action] || action;

      let prevLastAction: any = null;
      let prevLastBet: number | null = null;
      let prevStatus: any = null;

      setTableState((prev) => {
        const players = [...prev.players];
        const hero = players[idx];
        prevLastAction = prev.lastActions[idx] ?? null;
        prevLastBet = prev.lastBetAmounts[idx] ?? 0;
        prevStatus = hero?.status ?? null;

        const newActions = [...prev.lastActions];
        newActions[idx] = label as any;

        const newBets = [...prev.lastBetAmounts];
        if (action === 'call' || action === 'raise' || action === 'allin') {
          if (typeof amount === 'number' && amount > 0) newBets[idx] = amount;
        }

        if (action === 'fold' && hero) {
          players[idx] = { ...hero, status: 'folded' as any };
        }

        return {
          ...prev,
          lastActions: newActions,
          lastBetAmounts: newBets,
          players,
        };
      });

      return () => {
        setTableState((prev) => {
          const newActions = [...prev.lastActions];
          newActions[idx] = prevLastAction;
          const newBets = [...prev.lastBetAmounts];
          newBets[idx] = prevLastBet ?? 0;
          const players = [...prev.players];
          if (players[idx] && prevStatus != null) {
            players[idx] = { ...players[idx]!, status: prevStatus };
          }
          return {
            ...prev,
            lastActions: newActions,
            lastBetAmounts: newBets,
            players,
          };
        });
      };
    },
    [tableState.heroSeat]
  );

  /**
   * Dan 2026-08-21 (bug list item 2): "time banks are auto enabled but don't
   * grant 20 additional seconds when used."
   *
   * This function was the reason. It is a CLIENT-side fold, fired the instant
   * the local ring hit zero — and the local ring hits zero BEFORE the engine
   * does anything at all:
   *
   *   t = 15.0s  client ring reaches 0 → onTimeout
   *   t = 17.0s  engine's deadline (15s + the §6.1 2s network grace) fires and
   *              auto-activates the 20s time bank
   *
   * So the fold landed two full seconds before the engine ever considered the
   * bank. And on the path where the client DID ask for a bank first, any
   * refusal — including "time bank already activated this turn", which means
   * the engine had just granted one — dropped straight through to this fold.
   * The bank was granted and the hand was thrown away anyway.
   *
   * The engine owns the fold. It force-resolves an expired seat itself
   * (`forceResolveSeat`, check when free / fold when not) and its clock is the
   * only one that can see the bank. So this now refuses to act while the
   * authoritative deadline is still ahead of us, and only fires as a genuine
   * last-resort failsafe: the deadline is well past AND nothing has moved,
   * which means the engine is unreachable rather than merely slower than us.
   */
  const handleTimerAutoFold = useCallback(() => {
    if (actionLockRef.current) return; // Prevent race with manual fold
    const deadline = tableStateRef.current.actionTimerDeadline;
    // §6.1 grace (2s) + a margin for the engine's own resolve round-trip.
    const FAILSAFE_GRACE_MS = 6000;
    if (deadline && serverNow() < deadline + FAILSAFE_GRACE_MS) {
      // The engine still has time on its clock — it may be running a time bank
      // for us right now. Folding here would throw the hand away.
      return;
    }
    // Bible V8 §1.4: Server is authoritative — only send HTTP action, no Realtime broadcast
    try {
      soundService.playFold();
      if (tableId)
        submitActionWithToast(tableId, userId || 'guest', 'fold', undefined, 'auto-fold');
    } catch (err) {
      reportError(err, 'TablePage.Error_during_autofold');
    }
  }, [tableState.heroSeat, tableId, userId]);

  const {
    timeRemaining: actionTimeRemaining,
    timerProgress: actionTimerProgress,
    resetTimer,
    extendTimer,
  } = useTableTimer({
    isActiveTurn: tableState.currentPlayerSeat > 0 && tableState.isHandInProgress,
    isHeroTurn: isHeroTurnContext && !timeBankActive,
    isSoundEnabled,
    // Bible V8 §6.1: deadline-driven, server-authoritative. Reset whenever
    // the active seat changes OR the server pushes a new deadline. Without
    // these props the local countdown ticks to zero on turn #1 and then
    // freezes for the rest of the session (no visible ring on any seat).
    turnDeadlineMs: tableState.actionTimerDeadline,
    activeSeatKey: tableState.currentPlayerSeat,
    onTimeout: () => {
      // Server-authoritative: when client timer expires, try to activate time bank.
      // Bible V8 §11.1 auto_time_bank toggle — when ON, silently activate without
      // popping the modal (treat it as a silent grant). When OFF, the modal still
      // opens so the user can see the countdown tick and decide whether to spend
      // another bank if one expires.
      if (tableId && userId && timeBanksRemaining > 0) {
        setTimeBankActive(true);
        if (!v8Settings.auto_time_bank) {
          setShowTimeBank(true);
        }
        // 2026-08-20: this was `.catch(() => handleTimerAutoFold())`, and the
        // comment on it said "Server rejected — fall back to auto-fold".
        // That fallback could NEVER run. GameServerAPI.activateTimeBank does
        // not throw: every failure — non-OK status, unreachable server, a
        // thrown fetch — is converted into a resolved `{ success: false }`.
        //
        // So on the one path where the player is by definition not watching —
        // their shot clock just expired — a refused time bank left the client
        // showing borrowed time it did not have, and the auto-fold the code
        // intended never happened. Check the result.
        void GameServerAPI.activateTimeBank(tableId, userId).then((result) => {
          if (!result?.success) {
            setTimeBankActive(false);
            setShowTimeBank(false);
            handleTimerAutoFold();
          }
        });
      } else {
        handleTimerAutoFold();
      }
    },
    initialTime: actionTimeSeconds,
  });

  // Handle immediate UI Activation when button is clicked
  /**
   * 2026-08-20: this button could leave the clock LYING to the player.
   *
   * `setTimeBankActive(true)` was applied optimistically and never reverted,
   * and the only failure handling was `.catch(...)` — which can never run.
   * `GameServerAPI.activateTimeBank` does not throw: every failure path (a
   * non-OK status, an unreachable server, a thrown fetch) is converted into a
   * resolved `{ success: false, error }`. So the catch was dead code and the
   * result was discarded.
   *
   * The consequence is not cosmetic. If the server refuses — no uses left, not
   * hero's turn, the table moved on — the UI showed a time bank running while
   * the REAL shot clock kept counting down, and hero sat watching borrowed
   * time that did not exist until they were auto-folded.
   *
   * Await it, revert on refusal, and say why. This is the same
   * optimistic-then-revert shape the fold/check/call handlers in this file
   * already use.
   */
  const handleActivateTimeBank = useCallback(async () => {
    if (!tableId || !userId || timeBanksRemaining <= 0) return;
    setTimeBankActive(true);
    // ANIMATION/SOUND AUDIT 2026-08-19: was playChips (a wager sound) — the
    // dedicated time-bank cue existed and was only wired to the REMOTE event.
    soundService.playTimeBankActivated();
    const result = await GameServerAPI.activateTimeBank(tableId, userId);
    if (!result?.success) {
      setTimeBankActive(false);
      toast?.error?.(result?.error || 'Could not start your time bank');
    }
  }, [tableId, userId, timeBanksRemaining]);

  /**
   * Buy one time-bank extension with diamonds.
   *
   * Dan 2026-08-19, bug list item 9: "'buy more time banks' does nothing when
   * clicked." It did nothing because it never bought anything - it called
   * GameServerAPI.activateTimeBank, the same endpoint as USING a bank. With no
   * banks left (the only state in which the Buy button is shown) the engine
   * refreshed from the DB, found nothing new because no purchase had been
   * made, and returned "No time bank uses remaining". The button round-tripped
   * to the server and changed nothing, every time.
   *
   * Everything needed already existed and was simply never called:
   *   - `fn_purchase_feature` prices server-side from `feature_pricing`
   *     ('time_bank_seconds', 1 diamond, per_use), charges diamonds through
   *     `deduct_diamonds`, and writes the `feature_purchases` row. It is
   *     granted to `authenticated` and refuses to buy for anyone but the
   *     caller, so the client cannot name its own price or its own user.
   *   - `fn_time_bank_allowance` already counts purchased uses at 20s each.
   *   - The engine already calls `refreshTimeBankFromDb` when a player
   *     activates with an empty bank, so a purchase made mid-session is picked
   *     up without re-seating.
   *
   * So this only has to make the purchase and reflect it. The count is bumped
   * optimistically by the one use that was bought, which is what the engine
   * will independently derive from the DB on the next activation.
   */
  useEffect(
    () => () => {
      if (potCollectTimerRef.current) clearTimeout(potCollectTimerRef.current);
    },
    []
  );

  useEffect(() => {
    let alive = true;
    void supabase
      .from('feature_pricing')
      .select('diamond_cost')
      .eq('feature', 'time_bank_seconds')
      .maybeSingle()
      .then(({ data }) => {
        const cost = Number((data as { diamond_cost?: number } | null)?.diamond_cost);
        if (alive && Number.isFinite(cost) && cost >= 0) setTimeBankDiamondCost(cost);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Diamond balance for the buy-more sheet. Display only — the purchase is
  // priced and charged server-side by fn_purchase_time_banks either way; this
  // just lets the sheet say "you need N more" instead of failing at the tap.
  useEffect(() => {
    if (!userId || userId === 'guest' || !showTimeBankStore) return;
    let alive = true;
    void supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        const d = Number((data as { diamonds?: number } | null)?.diamonds);
        if (alive && Number.isFinite(d)) setDiamondBalance(d);
      });
    return () => {
      alive = false;
    };
  }, [userId, showTimeBankStore]);

  /**
   * Dan 2026-08-21, item 3: buy N time banks in ONE charge.
   *
   * The single-unit `fn_purchase_feature` call this replaced could only ever
   * buy one, so the 500 preset would have meant 500 round trips and 500
   * separate diamond deductions — any of which could fail halfway and leave
   * the player part-charged for a pack they did not get. `fn_purchase_time_banks`
   * does the whole quantity in one transaction and prices it server-side from
   * `feature_pricing`, so the client cannot name its own price.
   */
  const handleBuyTimeBanks = useCallback(
    async (quantity: number): Promise<boolean> => {
      if (!userId || userId === 'guest') {
        toast?.error?.('Sign in to buy time banks');
        return false;
      }
      if (buyingTimeBankRef.current) return false; // no double-charge on a double-tap
      buyingTimeBankRef.current = true;
      try {
        const { data, error } = await supabase.rpc('fn_purchase_time_banks', {
          p_quantity: quantity,
        });
        if (error) throw error;
        const result = (data ?? {}) as {
          success?: boolean;
          error?: string;
          total_cost?: number;
          quantity?: number;
          diamonds_remaining?: number | string | null;
        };
        if (!result.success) {
          toast?.error?.(result.error || 'Could not buy time banks');
          return false;
        }
        const bought = result.quantity ?? quantity;
        setTimeBanksRemaining((n) => n + bought);
        const remaining = Number(result.diamonds_remaining);
        if (Number.isFinite(remaining)) setDiamondBalance(remaining);
        const cost = result.total_cost ?? 0;
        toast?.success?.(
          `${bought} Time Bank${bought === 1 ? '' : 's'} Added (${cost.toLocaleString()} Diamonds)`
        );
        return true;
      } catch (err) {
        reportError(err, 'TablePage.buyTimeBanks');
        toast?.error?.('Could not buy time banks');
        return false;
      } finally {
        buyingTimeBankRef.current = false;
      }
    },
    [userId, toast]
  );

  /** Legacy single-bank entry point (TimeBank's "+EXTENSION" button). */
  const handleBuyTimeBank = useCallback(() => {
    setShowTimeBankStore(true);
  }, []);

  //Validation moved to server — client does basic guard only
  const validateAndExecuteAction = (
    action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'bet',
    _amount?: number
  ) => {
    if (!tableId) {
      showActionError({ error: 'Table not ready - reconnecting' });
      return false;
    }
    // Auto-allow fold
    if (action === 'fold') return true;
    // Basic client-side guard — real validation happens on server.
    // 2026-08-15: read tableStateRef, not the captured `tableState`. This is a
    // plain function re-created every render, but it is CALLED from inside
    // useCallback handlers that captured an older render's closure, so it used
    // to validate against a stale snapshot. And it must never return false
    // silently: a dead button with no explanation is indistinguishable from a
    // frozen client, which is exactly how the all-in bug presented.
    const live = tableStateRef.current;
    const heroPlayer = live.players[live.heroSeat - 1];
    if (!heroPlayer || heroPlayer.status === 'folded') {
      console.warn('[Table] client guard blocked action', action, {
        heroSeat: live.heroSeat,
        heroPlayer,
      });
      showActionError({
        error: 'Your seat is out of sync with the table - resyncing',
        code: 'CLIENT_STATE_STALE',
      });
      return false;
    }
    return true;
  };

  /**
   * Phase 2 T2-01 (spec §5.6): "Check or Fold?" protection.
   * Returns true when checking is legal for hero right now. When true and the
   * player taps Fold, we defer and show FoldProtectionDialog instead of
   * executing the fold. The keyboard shortcut ('F') also routes through here.
   */
  const canCheckRightNow = useCallback(() => {
    return (
      (tableState.currentBet || 0) <= (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0)
    );
  }, [tableState.currentBet, tableState.lastBetAmounts, tableState.heroSeat]);

  /** Commit a fold that has already cleared any dialog / confirmation gates. */
  const commitFold = useCallback(async () => {
    if (actionLockRef.current) return;
    if (!validateAndExecuteAction('fold')) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);
    closeRaisePanel();
    soundService.playFold(); // Bible V8 §5.4 — fold = light haptic
    // BUG 026: optimistic update for instant visual feedback
    const revert = applyOptimisticHeroAction('fold');
    if (tableId) {
      const ok = await submitActionWithToast(tableId, userId, 'fold', undefined, 'commitFold');
      if (!ok) revert();
    }
  }, [tableId, userId, submitActionWithToast, applyOptimisticHeroAction]);

  const handleFold = async () => {
    if (actionLockRef.current) return;
    // Spec §5.6: when checking is free, defer the fold behind a confirmation
    // dialog. The dialog lives in JSX below and calls commitFold() on confirm.
    if (canCheckRightNow()) {
      setFoldProtectOpen(true);
      return;
    }
    await commitFold();
  };

  const handleCheck = async () => {
    if (actionLockRef.current) return;
    if (!validateAndExecuteAction('check')) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);
    closeRaisePanel();
    //Local engine call removed — server is authoritative
    soundService.playCheck(); // SoundService handles haptic (light) per Bible V8 §5.4
    // BUG 026: optimistic update for instant visual feedback
    const revert = applyOptimisticHeroAction('check');
    if (tableId) {
      const ok = await submitActionWithToast(tableId, userId, 'check', undefined, 'handleCheck');
      if (!ok) revert();
    }
  };

  const handleCall = async () => {
    if (actionLockRef.current) return;
    if (!validateAndExecuteAction('call')) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);
    closeRaisePanel();
    //Local engine call removed — server is authoritative
    soundService.playChips(); // SoundService handles haptic (light) per Bible V8 §5.4
    // BUG 026: optimistic update for instant visual feedback
    const callAmt = tableState.currentBet || 0;
    const revert = applyOptimisticHeroAction('call', callAmt);
    if (tableId) {
      const ok = await submitActionWithToast(tableId, userId, 'call', undefined, 'handleCall');
      if (!ok) revert();
    }
  };

  const handleRaise = () => {
    openRaisePanel();
  };

  /**
   * The all-in hotkey has to reach `handleActionPanelAction`, which is declared
   * further down this component — naming it in the effect's dep array below
   * would be a temporal-dead-zone error, not merely a lint complaint. A ref
   * kept current by its own effect breaks the ordering cycle without moving
   * either block.
   */
  const allInHotkeyRef = useRef<(() => void) | null>(null);

  // ── Keyboard Shortcuts for Table Actions ──
  // Two key sets coexist (Phase 2 T1-10 / spec §5.5 "MUST IMPROVE"):
  //   F / C / R / A — original mnemonic (Fold / Check-Call / Raise / All-in)
  //   Q / W / E      — PokerBros-style left-hand row (Q=Fold, W=Check-Call, E=Raise)
  // Both reach the same handlers; downstream behavior is identical.
  // Active only when it's hero's turn and the user isn't typing in an input.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!isHeroTurnContext) return;
      if (actionLockRef.current) return;

      const key = e.key.toLowerCase();
      if (key === 'f' || key === 'q') {
        e.preventDefault();
        handleFold();
      } else if (key === 'c' || key === 'w') {
        e.preventDefault();
        // Bible V8 + spec §5.5: Check is legal when currentBet <= hero's current bet.
        const canCheck =
          (tableState.currentBet || 0) <=
          (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0);
        if (canCheck) {
          handleCheck();
        } else {
          handleCall();
        }
      } else if (key === 'r' || key === 'e') {
        e.preventDefault();
        handleRaise();
      } else if (key === 'a') {
        // 2026-08-20: the comment above has advertised "F / C / R / A —
        // (Fold / Check-Call / Raise / All-in)" since this block was written,
        // and A was never implemented. Three of the four documented keys
        // worked; the fourth did nothing. Now it shoves, through the same
        // handler the ALL IN button uses, so there is one code path.
        e.preventDefault();
        allInHotkeyRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isHeroTurnContext, handleFold, handleCheck, handleCall]);

  // Keep the all-in hotkey pointed at the current handler (see allInHotkeyRef).
  useEffect(() => {
    allInHotkeyRef.current = () => {
      void handleActionPanelAction('allin');
    };
    return () => {
      allInHotkeyRef.current = null;
    };
  });

  // Unified action handler for ActionPanel component
  //Server is authoritative — all actions go through submitAction
  const handleActionPanelAction = useCallback(
    async (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number) => {
      if (actionLockRef.current) return; // Debounce guard
      // Set lock immediately to prevent rapid double-taps — matches standalone handler pattern.
      // Even if validate rejects, the 300ms lockout prevents action spam.
      actionLockRef.current = true;
      setTimeout(() => {
        actionLockRef.current = false;
      }, 300);
      // 2026-08-15: every read below comes from tableStateRef, never from the
      // `tableState` this callback closed over. The dep array does not include
      // players/boardStage/currentBet, so the captured snapshot can lag a
      // stack update or a street change — which silently mis-clamped raises to
      // a stale stack and mis-attributed VPIP.
      const live = tableStateRef.current;
      const heroSeat = live.heroSeat;
      const hero = live.players[heroSeat - 1] ?? null;
      const heroStack = hero?.stack || 0;

      // Track VPIP: voluntary preflop action (call/raise/allin, NOT fold/check)
      if (
        live.boardStage === 'preflop' &&
        (action === 'call' || action === 'raise' || action === 'allin')
      ) {
        // Phase 2 audit 2026-08-22: VPIP is a PER-HAND stat. This incremented
        // on every voluntary preflop action, so limp-then-call-a-raise (or
        // call-then-shove) counted one hand twice — vpip/handsPlayed could
        // exceed 100%. The per-hand flag below already exists precisely to
        // answer "did hero VPIP this hand"; use it as the increment guard.
        if (!heroVpipThisHandRef.current) vpipCountRef.current++;
        // Dan 2026-08-15: also flag it for THIS hand so recordHand() can post
        // a real VPIP%. Raise/all-in additionally counts as a preflop raise.
        heroVpipThisHandRef.current = true;
        if (action === 'raise' || action === 'allin') heroPfrThisHandRef.current = true;
      }

      //All local engine calls removed — server is authoritative
      // BUG 026: each branch now applies an optimistic UI update BEFORE awaiting
      // the server round-trip so the action tag / bet amount paint instantly.
      // If the server rejects, revert() restores the prior snapshot.
      switch (action) {
        case 'fold':
          // Spec §5.6: when Check is free, route through the protection dialog
          // instead of folding immediately. commitFold runs validate +
          // submitAction; the dialog calls commitFold on user confirmation.
          if (canCheckRightNow()) {
            setFoldProtectOpen(true);
            break;
          }
          if (!validateAndExecuteAction('fold')) return;
          soundService.playFold(); // SoundService handles haptic per Bible V8 §5.4
          {
            const revert = applyOptimisticHeroAction('fold');
            if (tableId) {
              const ok = await submitActionWithToast(
                tableId,
                userId,
                'fold',
                undefined,
                'panel-fold'
              );
              if (!ok) revert();
            }
          }
          break;
        case 'check':
          if (!validateAndExecuteAction('check')) return;
          soundService.playCheck();
          {
            const revert = applyOptimisticHeroAction('check');
            if (tableId) {
              const ok = await submitActionWithToast(
                tableId,
                userId,
                'check',
                undefined,
                'panel-check'
              );
              if (!ok) revert();
            }
          }
          break;
        case 'call':
          if (!validateAndExecuteAction('call')) return;
          soundService.playChips();
          {
            const callAmt = live.currentBet || 0;
            const revert = applyOptimisticHeroAction('call', callAmt);
            if (tableId) {
              const ok = await submitActionWithToast(
                tableId,
                userId,
                'call',
                undefined,
                'panel-call'
              );
              if (!ok) revert();
            }
          }
          break;
        case 'raise':
          if (amount) {
            const clamped = Math.min(amount, heroStack);
            if (clamped <= 0) return;
            if (!validateAndExecuteAction('raise', clamped)) return;
            // SOUND AUDIT 2026-08-19: pass amount + BB so the Bible V8 §5.3
            // "louder for larger raises" scaling actually engages.
            soundService.playRaise(clamped, safeBB(tableStateRef.current.blinds, 1)); // haptic (medium) per §5.4
            {
              const revert = applyOptimisticHeroAction('raise', clamped);
              if (tableId) {
                const ok = await submitActionWithToast(
                  tableId,
                  userId,
                  'raise',
                  clamped,
                  'panel-raise'
                );
                if (!ok) revert();
              }
            }
          }
          break;
        case 'allin':
          if (heroStack <= 0) return;
          if (!validateAndExecuteAction('allin')) return;
          soundService.playAllIn(); // SoundService handles haptic (strong) per Bible V8 §5.4
          setIsAllInMode(true);
          {
            const revert = applyOptimisticHeroAction('allin', heroStack);
            if (tableId) {
              const ok = await submitActionWithToast(
                tableId,
                userId,
                'allin',
                heroStack,
                'panel-allin'
              );
              if (!ok) revert();
            }
          }
          break;
      }
    },
    [tableState.heroSeat, tableId, userId, submitActionWithToast, canCheckRightNow]
  );

  // handleConfirmRaise was removed on 2026-08-20. It was the confirm handler for
  // the slider that never existed, so nothing could reach it; the live path is
  // ActionPanel's own confirm -> handleActionPanelAction('raise', amount), which
  // does the same clamping and optimistic update. Two copies of a money-moving
  // path, one of them unreachable, is how they drift.
  const handleAllIn = async () => {
    if (actionLockRef.current) return;
    const heroSeat = tableState.heroSeat;
    const hero = getPlayerAtSeat(heroSeat);
    const heroStack = hero?.stack || 0;
    if (heroStack <= 0) return;
    if (!validateAndExecuteAction('allin')) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);
    try {
      //Local engine call removed — server is authoritative
      soundService.playAllIn(); // SoundService handles haptic (strong) per Bible V8 §5.4
      setIsAllInMode(true);
      // BUG 026: optimistic update for instant visual feedback
      const revert = applyOptimisticHeroAction('allin', heroStack);
      if (tableId) {
        const ok = await submitActionWithToast(tableId, userId, 'allin', heroStack, 'handleAllIn');
        if (!ok) revert();
      }
    } catch (err) {
      console.warn('[TablePage] All-in error:', err);
    }

    // Check for all-in scenario triggers (after slight delay to let state update)
    workerTimeout(() => {
      if (!isMounted.current) return;
      // Use tableStateRef.current instead of stale tableState closure
      const currentState = tableStateRef.current;
      const activePlayers = currentState.players.filter(
        (p) => p && p.status === 'active' && p.stack > 0
      );
      const allInPlayers = currentState.players.filter((p) => p && p.status === 'all_in');

      // FIX 89: Insurance offers are now SERVER-AUTHORITATIVE.
      // The server's InsuranceEngine creates offers and broadcasts via Realtime
      // (event type: 'insurance_offers'). The client listens in the subscribeToHandState
      // callback and shows InsuranceModal when the hero receives an offer.
      // No local insurance calculation — server uses MonteCarloEquity with 5000 iterations.
      //
      // RIT prompt: triggered after insurance decision completes (in handleInsuranceDecline)
      if (activePlayers.length === 0 && allInPlayers.length >= 2) {
        const opponent = allInPlayers.find((p) => p?.id !== hero?.id);
        setRitOpponent(opponent?.name || 'Opponent');
        setRitTimer(10);
      }
    }, 500);
  };

  // Keyboard Shortcuts — wired to table actions (Phase 8)
  useTableKeyboard({
    isHeroTurn: tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress,
    isSpectator: !tableState.players.some((p) => p?.isHero),
    isModalOpen:
      showSettings ||
      showInsurance ||
      showRIT ||
      showBuyInModal ||
      showHandHistory ||
      showPlayerNotes ||
      showWaitList ||
      isSideMenuOpen,
    onFold: handleFold,
    onCallCheck: () => {
      // Bible V8: Check is legal when currentBet <= hero's current bet
      const canCheck =
        (tableState.currentBet || 0) <= (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0);
      if (canCheck) {
        handleCheck();
      } else {
        handleCall();
      }
    },
    onRaise: handleRaise,
    onAllIn: handleAllIn,
    onToggleSound: () => setIsSoundEnabled(!isSoundEnabled),
    // FIX 199: onToggleHandStrength REMOVED — not allowed for live online gameplay
    onToggleStats: () => updateSetting('showHUD', !userSettings.showHUD),
    onBetPreset: (preset: number) => {
      // Bet presets: 0=1/3 pot, 1=1/2 pot, 2=3/4 pot, 3=pot
      //Use tableState.pot instead of local engine state
      const pot = tableState.pot || 0;
      const fractions = [1 / 3, 1 / 2, 3 / 4, 1];
      const fraction = fractions[preset] ?? 0.5;
      const betAmount = Math.max(safeBB(tableState.blinds), Math.round(pot * fraction * 100) / 100);
      openRaisePanel(betAmount);
    },
    onClosePanel: () => {
      // Escape key → close ALL open modals/overlays
      setIsChatCollapsed(true);
      setShowSettings(false);
      setIsReactionPickerOpen(false);
      setShowHandHistory(false);
      setShowPlayerNotes(false);
      setShowWaitList(false);
      closeRaisePanel();
      setShowBuyInModal(false);
      setIsSideMenuOpen(false);
    },
  });

  // Side menu toggle — wrapped in startTransition to avoid INP
  const toggleSideMenu = () => {
    startTransition(() => {
      setIsSideMenuOpen(!isSideMenuOpen);
    });
  };

  // IMPROVEMENT PASS 2026-08-19: triggerChipAnimation + its ref were dead —
  // every call site was rewritten to push ChipAnimationEvents inline
  // (2026-04-14/16 fixes), and this leftover still carried the buggy
  // window.innerWidth math and the wrong {50,45} pot target. Removed.

  const handleAnimationComplete = useCallback((id: string) => {
    setChipAnimations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Safety cleanup: remove chip animations older than 5 seconds (e.g. if CSS event missed)
  useEffect(() => {
    const interval = setInterval(() => {
      setChipAnimations((prev) => {
        if (prev.length === 0) return prev;
        const cutoff = Date.now() - 5000;
        const fresh = prev.filter((a) => {
          // ANIMATION AUDIT 2026-08-19: ids come in TWO formats — underscore
          // (pa_<ts>_..., blind_<ts>_...) and hyphen (pot-to-winner-<ts>-<i>,
          // chip-to-pot-<ts>-<i>). The old `split('_')[1]` parsed the hyphen
          // ids to 0, so every pot-ship fan alive at a 5s tick was deleted
          // MID-FLIGHT. Extract the epoch-millis token regardless of format.
          const m = a.id.match(/(\d{13,})/);
          const ts = m ? parseInt(m[1], 10) : 0;
          // Unparseable id → keep (never destroy an animation we can't date).
          return ts === 0 || ts > cutoff;
        });
        return fresh.length === prev.length ? prev : fresh;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load waitlist data.
  //
  // 2026-08-20: every row rendered as "Player 1", "Player 2"... because the name
  // was synthesised from the queue position and the profile join the comment
  // promised was never written. The list was therefore useless for its actual
  // purpose — seeing who is ahead of you — and "(You)" was the only way to pick
  // yourself out. Names now resolve the same way the felt resolves them.
  const loadWaitlist = useCallback(async () => {
    if (!tableId) return;
    try {
      const entries = await waitlistService.getTableWaitlist(tableId);
      if (entries.length === 0) {
        setWaitListPlayers([]);
        return;
      }

      const ids = Array.from(new Set(entries.map((e) => e.userId).filter(Boolean)));
      const profileById = new Map<
        string,
        { username?: string; display_name?: string; avatar_url?: string; is_horse?: boolean }
      >();
      if (ids.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url:arena_avatar_url, is_horse')
          .in('id', ids);
        for (const pr of profiles || []) profileById.set(pr.id, pr);
      }

      setWaitListPlayers(
        entries.map((e) => {
          const pr = profileById.get(e.userId);
          return {
            playerId: e.userId,
            // Horses are identities whose `username` a DB trigger forces to
            // lowercase; display_name holds the properly-cased name. Same rule
            // the seat roster uses. Falls back to the position only when the
            // profile genuinely could not be read.
            playerName: pr?.display_name || pr?.username || `Player ${e.position}`,
            avatar: pr?.avatar_url || undefined,
            position: e.position,
            joinedAt: new Date(e.joinedAt),
          };
        })
      );
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_load_waitlist');
    }
  }, [tableId]);

  // Handle opening waitlist modal and loading data
  const handleOpenWaitlist = useCallback(() => {
    loadWaitlist();
    setShowWaitList(true);
  }, [loadWaitlist]);

  // P2-1 FIX: Pre-action auto-execution is server-owned (Bible V8 §4.15). The
  // client's delayed executor was removed: it ran ~100ms after the turn
  // arrived and re-submitted the same action the server had already
  // auto-executed, producing an out-of-turn submitAction (success:false), a
  // spurious "Action rejected" toast, and an optimistic-revert flicker on
  // every pre-action hand. The server is now the sole executor; the pre-action
  // is still mirrored to the server (effect above) and cleared at hand end
  // (effect below).

  // ANIMATION AUDIT 2026-08-19: the stage-change effect that bumped
  // boardStageKey is gone with the key itself (see the state declaration).
  // CommunityCards owns all per-street animation and sound.

  // Clear pre-action if game state changes significantly (new hand, someone raises after preaction set, etc)
  useEffect(() => {
    // Reset pre-actions when a new hand starts or board changes
    if (!tableState.isHandInProgress) {
      setPreAction(null);
    }
  }, [tableState.boardStage, tableState.isHandInProgress]);

  // Timer warning sound — tick when hero's time is running low.
  //
  // AUDIT-2 FIX 2026-08-20 (machine-gun ticking): this effect depended on
  // `actionTimeRemaining` / `actionTimerProgress`, which the timer hook
  // updates ~30x per second. Every one of those updates re-ran the effect:
  // the cleanup called stopTimerWarning() and the body called
  // startTimerWarning() again — and startTimerWarning plays a tick
  // IMMEDIATELY. So instead of one tick per second the player got a tick
  // roughly every 66ms (only the 50ms priority gate throttled it), each with
  // a haptic. Worse, timer_warning outranks every action sound (rank 80), so
  // acting inside the last 5 seconds frequently produced NO fold/check/call
  // sound at all.
  //
  // Collapsing the trigger to a boolean means the effect runs exactly twice
  // per turn: once when the warning window opens, once when it closes.
  // Dan 2026-08-20: warning window is the FINAL 3 SECONDS (was 5), and it
  // buzzes as well as ticks. The haptic is deliberately NOT gated on the
  // sound switches — a player with sound off still gets the physical warning
  // (HapticService itself honors the user's vibration setting).
  const isTimerWarningWindow =
    tableState.currentPlayerSeat === tableState.heroSeat &&
    tableState.isHandInProgress &&
    actionTimeRemaining <= 3 &&
    actionTimeRemaining > 0;
  const isTimerWarningActive = isTimerWarningWindow && isSoundEnabled && ambientSoundsAllowed;
  useEffect(() => {
    if (isTimerWarningActive) {
      soundService.startTimerWarning();
      return () => soundService.stopTimerWarning();
    }
    soundService.stopTimerWarning();
  }, [isTimerWarningActive]);
  useEffect(() => {
    if (!isTimerWarningWindow) return;
    // Heavy pulse immediately, then once per second while the window is open
    // (mirrors the 1s cadence of soundService.startTimerWarning).
    import('../services/HapticService').then(({ haptic }) => haptic.heavy());
    const buzz = window.setInterval(() => {
      import('../services/HapticService').then(({ haptic }) => haptic.heavy());
    }, 1000);
    return () => clearInterval(buzz);
  }, [isTimerWarningWindow]);

  return (
    <div
      className={`table-page${isAllInMode ? ' table-page--allin-mode' : ''}${tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress ? ' table-page--hero-turn' : ''}${winnerInfo.playerIds.length > 0 ? ' table-page--winner-flash' : ''}`}
      /* Dan 2026-08-18 — the page never shows the skin composite's scene:
         the table is .table-art inside the aspect-locked scaler, and the
         page behind it is a standalone designed background (style below). */
      data-felt-theme={v8Theme.table_id || v8Theme.theme_id || userSettings.theme || 'black'}
      data-background-theme={v8Theme.background_id || 'midnight'}
      data-button-theme={v8Theme.button_id || 'classic-white'}
      data-cards-theme={activeCardBack}
      data-theme-preset={v8Theme.theme_id || 'default-dark'}
      /* Dan 2026-08-18: 2 or 3 when the hand is run multiple times — CSS
         shifts the felt masthead down by one board height per extra run so
         the stacked boards never cover it. */
      data-boards={
        (ritResult?.boards?.length ?? 1) > 1
          ? ritResult!.boards.length
          : // DOUBLE-BOARD BOMB POT 2026-08-20: the live second board shifts
            // the felt masthead exactly like a second RIT run does.
            tableState.communityCards2.length > 0
            ? 2
            : undefined
      }
      style={{
        // Dan 2026-08-18: the blurred-skin backdrop is GONE ("remove the
        // weird images around the table"). The page shows one of the ten
        // designed, interchangeable backgrounds instead.
        //
        // Dan 2026-08-20: "EVERY SINGLE TABLE NEEDS A BACKGROUND... IT SHOULD
        // NEVER BE BLANK." The selected artwork is layered OVER a pure-CSS
        // designed backdrop, so a 404 / decode failure / slow first paint can
        // no longer leave the page empty — see lib/tableTheme.
        backgroundColor: DEFAULT_TABLE_BACKDROP_COLOR,
        backgroundImage: resolveBackgroundLayers(v8Theme.background_id),
        backgroundSize: TABLE_BACKGROUND_SIZE,
        backgroundPosition: TABLE_BACKGROUND_POSITION,
        backgroundRepeat: TABLE_BACKGROUND_REPEAT,
      }}
    >
      <style>{`
                @keyframes boardSlideIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
                @keyframes boardFade { from { opacity: 0.7; } to { opacity: 1; } }
                .community-area { animation: boardFade 0.4s ease-out; }
                .board-transition { animation: boardSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
            `}</style>
      {/* Phase 1.2 PR-F: hero disconnect banner. Only renders when the
          engine FSM reports MISSING or DISCONNECTED for this user. */}
      {/* ── Bounty knockout (2026-08-20) ───────────────────────────────────
          Non-blocking: it sits over the felt while you may still be in a
          hand, so it must never eat a click on the action buttons. */}
      <KnockoutAnimation
        data={knockout}
        queuedBehind={knockoutQueue.pending}
        onDone={knockoutQueue.complete}
        playSounds={ambientSoundsAllowed}
      />

      {/* ── Mystery bounty chest (2026-08-20) ──────────────────────────────
          The opposite case: a takeover, because it is ASKING the winner to
          tap it. Their tap is broadcast so every other seat opens in step. */}
      <MysteryBountyChest
        data={mysteryChest}
        viewerUserId={userId}
        remoteOpened={chestRemoteOpened}
        onBroadcastOpen={broadcastChestOpen}
        queuedBehind={chestQueue.pending}
        onDone={() => {
          chestQueue.complete();
          setChestRemoteOpened(false);
        }}
        playSounds={ambientSoundsAllowed}
      />

      {/* ── Spin multiplier draw (2026-08-20) ───────────────────────────────
          A takeover, like the chest: it happens before the cards and it is the
          reason the player opened a Spin. Server-decided, identical on every
          seat. */}
      <SpinWheel
        data={spinDraw}
        onDone={() => setSpinDraw(null)}
        playSounds={ambientSoundsAllowed}
      />

      <DisconnectToast heroUserId={userId} disconnectStates={disconnectStates} />

      {/* Dan 2026-08-19, bug list item 2: "no winner banner at showdown - just
          ship the pot." The centre banner that used to live here (YOU WIN /
          <Name> wins, hand name, amount, ~2s) is gone. `winnerInfo` is still
          populated - the seat glow, the hand-name float and the pot ship all
          read it - only the banner is removed. Do not reintroduce it. */}
      {/* Phase 2 T2-01 (spec §5.6): Fold Protection Dialog.
          handleFold / panel-fold defer to this when canCheckRightNow() is
          true. onCheck dismisses + executes the free check; onFold dismisses
          + commits the fold the player already intended. */}
      {/* Dan 2026-08-21, item 3: buy more time banks with diamonds. Opens from
          the alarm-clock counter when the player is out, and from the TimeBank
          panel's extension button. */}
      <TimeBankStoreModal
        open={showTimeBankStore}
        onClose={() => setShowTimeBankStore(false)}
        diamondCost={timeBankDiamondCost}
        banksRemaining={timeBanksRemaining}
        diamondBalance={diamondBalance}
        onPurchase={handleBuyTimeBanks}
      />
      <FoldProtectionDialog
        open={foldProtectOpen}
        onDismiss={() => setFoldProtectOpen(false)}
        onCheck={() => {
          setFoldProtectOpen(false);
          handleCheck();
        }}
        onFold={() => {
          setFoldProtectOpen(false);
          void commitFold();
        }}
      />
      {/* Phase 2 T2-02 (spec §5.7): always-visible timebank counter in the
          bottom-left. Only renders during an active hand so it doesn't clutter
          observer/idle views. Tapping it opens the existing TimeBank modal so
          the player can buy more charges. `low` state pulses when <= 1. */}
      {/* Dan 2026-08-15: gate relaxed from `isHandInProgress && heroSeat > 0`
          to seated-only. Hiding it between hands meant the counter blinked out
          every time a hand ended, so a player could never check how many banks
          they had left before the next hand — precisely when you want to know.
          Observers (heroSeat === 0) still see nothing. */}
      {/* Dan 2026-08-21: the counter moved into the TableHUD bottom-left
          stack, directly ABOVE the previous-hand card (see the bottomLeft
          prop below) — it no longer floats at its own fixed offset. */}
      {/*
        Phase 1.3 PR-C+D: server-rejection toast.
        Auto-clears after 4s (component-internal). The Snap-to-hint button
        routes back through the unified action handler so server-suggested
        amounts are clamped/validated client-side just like a manual click.
      */}
      <ActionErrorToast
        errorData={actionErrorData}
        onClear={() => setActionErrorData(null)}
        onApplyHint={(action, amount) => {
          // Map server hint actions to handleActionPanelAction's signature.
          if (action === 'fold' || action === 'check' || action === 'call') {
            handleActionPanelAction(action);
          } else if (action === 'raise' || action === 'bet') {
            handleActionPanelAction('raise', amount);
          } else if (action === 'allin' || action === 'all-in' || action === 'all_in') {
            handleActionPanelAction('allin');
          }
        }}
      />
      {/* ═══════════════════════════════════════════════════════════════════════
          HEADER BAR — Compact premium-style with game info
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="table-header">
        <div className="header-left">
          <button
            className="header-btn back-btn"
            onClick={() => {
              soundService.playButtonClick();
              if (tableState.heroSeat > 0) {
                setShowLeaveConfirm(true);
              } else {
                navigate(-1);
              }
            }}
            title="Back"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M12 4l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="header-btn add-chips-icon"
            onClick={() => {
              soundService.playButtonClick();
              if (tableState.heroSeat > 0) setShowCashier(true);
            }}
            title="Add Chips"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M9 6v6M6 9h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="header-center">
          <div className="header-center__top-row">
            {tableState.tableName && (
              <span className="header-table-name">{tableState.tableName}</span>
            )}
            <span className="header-game-type">
              {tableState.gameType ? getGameVariantLabel(tableState.gameType) : ''}
            </span>
            <span className="header-blinds">{tableState.blinds}</span>
          </div>
          <div className="header-center__bottom-row">
            <span className="header-brand">Smarter.Poker</span>
            {tableState.clubName && <span className="header-club-name">{tableState.clubName}</span>}
            {tableState.handNumber != null && tableState.handNumber > 0 && (
              <span className="header-hand-number">#{tableState.handNumber}</span>
            )}
          </div>
        </div>
        <div className="header-right" />
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          4-CORNER TABLE HUD — Bible V8 §11
          Upper-left: Hamburger menu | Upper-right: Mini stats card
          Bottom-left: Previous hand   | Bottom-right: (Chat via TableChat)
          ═══════════════════════════════════════════════════════════════════════ */}
      <TableHUD
        upperLeft={
          <div className="hud-ul-column">
            <TableMenu
              isOpen={showTableMenu}
              onClose={() => setShowTableMenu(false)}
              onToggle={() => setShowTableMenu((prev) => !prev)}
              position="top-left"
              sections={[
                {
                  title: 'Quick Actions',
                  actions: [
                    {
                      id: 'sitout',
                      label: 'Sit Out',
                      icon: <SitOutIcon />,
                      onClick: () => void handleSitOut(),
                    },
                    ...(tableState.isTournament
                      ? [
                          {
                            id: 'rebuy',
                            label: 'Rebuy',
                            icon: <RebuyIcon />,
                            onClick: handleTournamentRebuy,
                          },
                          {
                            id: 'addon',
                            label: 'Add-On',
                            icon: <AddOnIcon />,
                            onClick: handleTournamentAddOn,
                          },
                        ]
                      : [
                          {
                            id: 'rebuy',
                            label: 'Add Chips',
                            icon: <RebuyIcon />,
                            onClick: () => setShowCashier(true),
                          },
                        ]),
                    // AUTO-REBUY TOGGLE REMOVED 2026-08-20. It set React state and
                    // a localStorage key and nothing else: `isAutoRebuyEnabled`
                    // had no consumers anywhere in the repo, and no server code
                    // reads `table_seats.auto_rebuy` either (see the note in
                    // BuyInModal). The menu displayed a persistent "Auto-Rebuy:
                    // ON" badge that changed nothing about how the table behaved.
                  ],
                },
                {
                  title: 'Table Info',
                  actions: [
                    {
                      id: 'history',
                      label: 'Hand History',
                      icon: <HandHistoryIcon />,
                      onClick: () => setShowHandReplay(true),
                    },
                    {
                      id: 'leaderboard',
                      label: 'Leaderboard',
                      icon: <LeaderboardIcon />,
                      onClick: () => setShowLeaderboard(true),
                    },
                    ...(!tableState.isTournament
                      ? [
                          {
                            id: 'session-stats',
                            label: 'Session Stats',
                            icon: <SessionStatsIcon />,
                            onClick: () => setShowSessionStats(true),
                          },
                        ]
                      : []),
                    // Bible V8 §11.1 — Settings accessible from BOTH table HUD menu AND hamburger menu
                    {
                      id: 'settings',
                      label: 'Table Settings',
                      icon: <HelpIcon />,
                      onClick: () => setShowSettings(true),
                    },
                  ],
                },
                {
                  title: 'Support',
                  actions: [
                    {
                      id: 'help',
                      label: 'Help & Rules',
                      icon: <HelpIcon />,
                      onClick: () => setShowGameRules(true),
                    },
                  ],
                },
                {
                  actions: [
                    {
                      id: 'leave',
                      label: 'Leave Table',
                      icon: <LeaveTableIcon />,
                      onClick: () => setShowLeaveConfirm(true),
                      danger: true,
                    },
                  ],
                },
              ]}
              tableName={tableState.tableName}
              // 2026-08-22: the indicator used to mirror the LEGACY Supabase
              // channel (presence/chat) while the game rides the engine WS —
              // a dead engine socket showed a green dot and a Supabase blip
              // showed red on a healthy game. Report the transport that
              // actually carries the game.
              connectionStatus={
                engineWsStatus === 'connected'
                  ? 'connected'
                  : engineWsStatus === 'connecting' || engineWsStatus === 'reconnecting'
                    ? 'reconnecting'
                    : 'disconnected'
              }
            />
            {/* Dan 2026-08-15 — this "+" is ADD TABLE, not Add Chips.
                It used to open CashierModal, which duplicated the wallet entry
                already on the table menu and left no way to start a second
                game without abandoning the current one.
                It now asks MultiTablePage to open a LOBBY tab beside the
                running table: the current game keeps dealing in its own tab on
                its own live engine socket, and picking a cash game or
                tournament from that lobby converts the lobby tab into the new
                table tab in place. Add Chips lives on in the table menu. */}
            <button
              className="add-chips-icon-btn"
              onClick={() => {
                soundService.playButtonClick();
                masterBus.emit('OPEN_LOBBY_TAB', { requestedBy: userId });
              }}
              title="Open another table"
              aria-label="Open another table"
            >
              <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M9 6v6M6 9h6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        }
        upperRight={
          <MiniStatsCard
            currentStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
            totalBuyIn={totalBuyInRef.current}
            handsPlayed={handsPlayedRef.current}
            vpipCount={vpipCountRef.current}
            handsWon={handsWonRef.current}
            isSeated={tableState.heroSeat > 0}
            onTap={() => setShowSessionStats(true)}
          />
        }
        bottomLeft={
          <div className="hud-ul-column hud-ul-column--stack">
            {/* Dan 2026-08-21: "the previous hand should be in the bottom left
                corner, the time bank icon should be on top of it." Stacked in
                that exact order — alarm clock above, previous-hand card below. */}
            {tableState.heroSeat > 0 && (
              <TimebankCounter
                count={timeBanksRemaining}
                low={timeBanksRemaining <= 1}
                /* Dan 2026-08-21, item 3: out of banks → the buy sheet, not
                   the (empty) time-bank panel. */
                onClick={() =>
                  timeBanksRemaining > 0 ? setShowTimeBank(true) : setShowTimeBankStore(true)
                }
              />
            )}
            <PreviousHandCard
              handNumber={prevHandResult?.handNumber ?? null}
              result={prevHandResult?.result ?? 0}
              didWin={prevHandResult?.didWin ?? false}
              didFold={prevHandResult?.didFold ?? false}
              handDescription={prevHandResult?.handDescription}
              onTap={() => setShowHandDetail(true)}
              onShareHand={() => {
                // The modal renders only when a hand has been captured. Say so
                // instead of no-opping — tapping a menu item and getting
                // nothing at all is how this looked before today.
                if (!sharedHandData) {
                  toast?.info?.('Play a hand to the end, then share it.');
                  return;
                }
                setShowShareHand(true);
              }}
            />
            {/* Visual representation of Needs Post Blind button */}
            <button className="floating-post-blind" style={{ display: 'none' }}>
              Post Blind
            </button>
          </div>
        }
        centerTop={null /* Game info moved to on-felt strip below community cards */}
      />

      {/* ═══════════════════════════════════════════════════════════════════════
          TABLE AREA
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="table-container">
        <div className="table-scaler" ref={tableScalerRef}>
          {/* Table Felt */}
          <div className="table-felt">
            {/* Dan 2026-08-17 — the painted table itself. object-fit: cover
                inside the 605/1000 scaler crops the 896x1200 composite to
                x [9.5%, 90.5%], putting the rail centerline exactly where
                SEAT_POSITIONS_* expect it. This is what guarantees villains
                and + SIT buttons sit ON the rail at every breakpoint. */}
            <img
              className="table-art"
              src={resolveSkin(v8Theme.table_id || v8Theme.theme_id || userSettings.theme || '')}
              alt=""
              draggable={false}
            />
            <div className="table-rail">
              <div className="table-surface">
                {/* Hand Number — Dan 2026-08-15 (second revision): moved OFF
                    the upper-right corner and into the felt masthead as line 2,
                    centred under the date/club/game row. It renders inside
                    .table-brand now; nothing draws it here. */}

                {/* ── TABLE CENTRE BRAND (Dan 2026-08-15) ──────────────────
                    "Use the smarter.poker letter logo in the middle of the
                    table, then under that it should say the date, game,
                    blinds, and what club or union it's in."
                    Sits behind the pot and community cards (z-index 1, the
                    pot area is 2+) and is fully click-through so it can never
                    intercept a seat or action tap. */}
                <div className="table-brand" aria-hidden="true">
                  <img
                    className="table-brand__logo"
                    src={smarterPokerLetterLogo}
                    alt=""
                    draggable={false}
                  />
                  {/* Dan 2026-08-15 \u2014 felt masthead, two centered lines.
                      Was three stacked lines (date / game+blinds / club) plus a
                      separate .table-game-info strip further down that repeated
                      the same stakes twice ("NLH 2.00/5.00" and "2/5 NLH").
                      Now line 1 is date, club and game on one centered row
                      under the wordmark, and line 2 is the hand number, which
                      used to float alone in the top-right corner. */}
                  <div className="table-brand__meta">
                    {(() => {
                      // Shared: the short game label. Dan 2026-08-17 (audit):
                      // raw DB enums like OFC_PINEAPPLE printed verbatim on
                      // the felt -- format enums for display.
                      const gameShort = (
                        tableState.gameType === "No Limit Hold'em"
                          ? 'NLH'
                          : tableState.gameType === 'Pot Limit Omaha'
                            ? 'PLO'
                            : tableState.gameType === "Fixed Limit Hold'em"
                              ? 'FLH'
                              : (tableState.gameType || 'NLH').replace(/_/g, ' ')
                      ).toUpperCase();
                      // Dan 2026-08-18: date pinned to when this table session
                      // started, never `new Date()` per render -- a replay or
                      // screenshot must show the day the hand was played.
                      const dateLabel = tableSessionDate.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      });

                      if (tableState.isTournament) {
                        // Dan 2026-08-20, from a seat at a live Spin: "1st
                        // line Date, (game type) Poker Spins, Club Name,
                        // Union Name. 2nd line Level #, Blinds, and the
                        // clock. 3rd line hand number."
                        const formatWord =
                          tournamentFormat === 'spin'
                            ? 'Poker Spins'
                            : tournamentFormat === 'sng'
                              ? 'Poker Heads Up'
                              : 'Poker Tournament';
                        return (
                          <>
                            <span className="table-brand__line">
                              {dateLabel}
                              {' \u00B7 '}
                              {gameShort} {formatWord}
                              {tableState.clubName && (
                                <span className="table-brand__club">
                                  {' \u00B7 '}
                                  {tableState.clubName}
                                </span>
                              )}
                              {tableState.unionName && (
                                <span className="table-brand__union">
                                  {' \u00B7 '}
                                  {tableState.unionName}
                                </span>
                              )}
                            </span>
                            <span className="table-brand__line table-brand__line--level">
                              Level {tableState.currentLevel || 1}
                              {' \u00B7 '}
                              {tableState.blinds || '10/20'}
                              {levelClock && (
                                <>
                                  {' \u00B7 '}
                                  <MastheadLevelClock
                                    startedAtMs={levelClock.startedAtMs}
                                    durationSec={levelClock.durationSec}
                                  />
                                </>
                              )}
                            </span>
                            {(tableState.handNumber ?? 0) > 0 && (
                              <span className="table-brand__line table-brand__line--hand">
                                Hand #{tableState.handNumber}
                              </span>
                            )}
                          </>
                        );
                      }

                      // Cash tables keep the two-line masthead.
                      return (
                        <>
                          <span className="table-brand__line">
                            {dateLabel}
                            {(tableState.clubName || tableState.unionName) && (
                              <>
                                {' \u00B7 '}
                                <span className="table-brand__club">
                                  {tableState.clubName}
                                  {/* Union beside club (Dan 2026-08-18); club
                                      omitted when it would duplicate the
                                      union (Dan 2026-08-20). */}
                                  {tableState.unionName && (
                                    <span className="table-brand__union">
                                      {tableState.clubName ? ' \u2022 ' : ''}
                                      {tableState.unionName}
                                    </span>
                                  )}
                                </span>
                              </>
                            )}
                            {' \u00B7 '}
                            {gameShort} {tableState.blinds || '1/2'}
                          </span>
                          {(tableState.handNumber ?? 0) > 0 && (
                            <span className="table-brand__line table-brand__line--hand">
                              Hand #{tableState.handNumber}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
                {/* Dan 2026-08-19 item 15: the pot moved OUT of .table-surface.
                    That element sets z-index:1 and so creates a stacking
                    context, which trapped the pot below the chip-flight layer
                    no matter what z-index it was given - every chip flying to
                    the pot landed on top of the total. It is now a sibling of
                    the chip layer (see .pot-area in TablePage.css, whose
                    percentages are converted so it does not move a pixel). */}

                {/* Community Cards.
                    Dan 2026-08-18: when the hand is run twice or three times,
                    the extra boards render HERE, stacked directly under the
                    first one, instead of only inside the RIT modal. The
                    felt masthead shifts down via data-boards (see
                    .table-page[data-boards] in TablePage.css) so the cards
                    can never cover the date / club / game / hand line. */}
                <div className="community-area">
                  <CommunityCards
                    cards={tableState.communityCards}
                    stage={
                      // Bomb pot: keep the board visually preflop until the
                      // explosion finishes (see bombPotHoldFlop). Only the
                      // flop is ever held — if the stage has already moved
                      // past flop (instant all-in runout) show it.
                      bombPotHoldFlop && tableState.boardStage === 'flop'
                        ? 'preflop'
                        : tableState.boardStage
                    }
                    highlightedIndices={winnerInfo.cardIndices}
                    winningHandName={
                      // Round 2 (double board): label board 1 with ITS winning
                      // hand; the merged single name stays for single-board.
                      winnerInfo.boardHandNames?.[0] || winnerInfo.handName
                    }
                    deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                    cardBack={activeCardBack}
                    playSounds={ambientSoundsAllowed}
                  />
                  {/* DOUBLE-BOARD BOMB POT 2026-08-20: board 2, stacked
                      directly under board 1 like the reference — no label,
                      same stage (both boards deal in lockstep), silent so
                      each street sounds once. */}
                  {tableState.communityCards2.length > 0 && (
                    <div className="community-area__board2">
                      <CommunityCards
                        cards={tableState.communityCards2}
                        stage={
                          bombPotHoldFlop && tableState.boardStage === 'flop'
                            ? 'preflop'
                            : tableState.boardStage
                        }
                        winningHandName={winnerInfo.boardHandNames?.[1] || undefined}
                        deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                        cardBack={activeCardBack}
                        playSounds={false}
                      />
                    </div>
                  )}
                  {(ritResult?.boards?.length ?? 0) >= 2 &&
                    ritResult!.boards.slice(1).map((board, bi) => (
                      <div className="community-area__run" key={`run-${bi + 2}`}>
                        <span className="community-area__run-label">Run {bi + 2}</span>
                        <CommunityCards
                          cards={normalizeCards(board) as Card[]}
                          stage="river"
                          deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                          cardBack={activeCardBack}
                        />
                      </div>
                    ))}
                </div>

                {/* ROUND 3 (2026-08-20): bomb pot countdown — players see the
                    forced ante coming instead of being ambushed by it. Server
                    truth (tableState.bombPotIn from the snapshot), hidden
                    while the bomb sequence itself is playing. */}
                {/* Gate on the SNAPSHOT value only — it is server truth and
                    goes non-null the moment an owner enables bomb pots, while
                    bombPotRules is a one-shot fetch that would hold the pill
                    hostage until a page reload. */}
                {tableState.bombPotIn != null && !bombPotActive && (
                  <div
                    className={`bomb-pot-eta ${tableState.bombPotIn === 1 ? 'bomb-pot-eta--next' : ''}`}
                  >
                    <span className="bomb-pot-eta__dot" />
                    {tableState.bombPotIn === 1
                      ? `${bombPotRules?.doubleBoard ? 'DOUBLE BOARD ' : ''}BOMB POT NEXT HAND`
                      : `BOMB POT IN ${tableState.bombPotIn}`}
                  </div>
                )}

                {/* Dan 2026-08-15: the "Game Info Strip" that lived here is
                    gone. It printed the stakes a second and third time
                    ("NLH 2.00/5.00", then "2/5 NLH" in yellow) right under the
                    masthead that already states them. Date, club and game now
                    appear once, on one centered line in .table-brand. */}

                {/* Spectator Badge + Overlay REMOVED from table surface.
                    Observer count belongs inside the chat panel, not on the felt.
                    SpectatorBadge and SpectatorOverlay components still exist for
                    future integration into the chat panel. */}

                {/* Spin Multiplier Badge.
                    HELD BACK WHILE THE WHEEL IS UP (2026-08-20). This badge
                    and the SpinWheel render in the same view, so the badge was
                    sitting on the felt printing "4x" for the entire time the
                    wheel was dramatically deciding whether the answer was 4x.
                    `spinDraw` is non-null exactly while the wheel is on screen
                    and is cleared by its onDone, so the wheel's landing IS the
                    reveal and this becomes the persistent reminder afterwards.
                    On a rejoin the wheel does not replay, spinDraw is already
                    null, and the badge shows immediately — which is right. */}
                {tableState.isTournament &&
                  !spinDraw &&
                  tableState.spinMultiplier &&
                  tableState.spinMultiplier > 1 && (
                    <div
                      className={`spinMultiplierBadge ${tableState.spinMultiplier >= 100 ? 'premium' : ''}`}
                    >
                      <span className="spinMultiplierIcon">X</span>
                      <span className="spinMultiplierValue">{tableState.spinMultiplier}x</span>
                    </div>
                  )}

                {/* FIX 194: HandStrengthIndicator REMOVED — not allowed for live online gameplay */}

                {/* Connection Quality HUD */}
                {tableId && userId !== 'guest' && (
                  <TableErrorBoundary componentName="ConnectionHUD">
                    <ConnectionHUD tableId={tableId} userId={userId} />
                  </TableErrorBoundary>
                )}
              </div>
            </div>
          </div>

          {/* Dealer Button — Animated "D" chip */}
          <DealerButton
            dealerVisualIndex={dealerVisualIndex}
            seatPositions={seatPositions}
            isVisible={tableState.isHandInProgress && dealerVisualIndex >= 0}
            playSounds={ambientSoundsAllowed}
          />

          {/* Dan 2026-08-15 (item 4) — throwables land ON the villain.
              This used to render from TableModalsLayer, a SIBLING of
              .table-scaler, so its `position:absolute; inset:0` resolved
              against the wrong ancestor and the coordinates meant nothing.
              Mounted here it shares the seats' own coordinate space. */}
          <ThrowAnimationContainer
            events={activeThrows}
            seatPositions={throwSeatPositions}
            onEventComplete={handleThrowComplete}
          />

          {/* Deal Animation — card backs flying from dealer to players on new hand */}
          {/* Bible V8 §11.1: card_slide toggle gates the deal animation */}
          {dealAnimationKey > 0 && v8Settings.card_slide && (
            <DealAnimation
              key={dealAnimationKey}
              active={true}
              /* Dan 2026-08-21 (item 14): "cards actually dealt to ALL the
                 players to start a new hand." The `status !== 'folded'` test
                 was wrong at this exact moment: HAND_STARTED often lands before
                 the fresh roster does, so the seats still carry LAST hand's
                 folded flags and everyone who folded the previous hand was
                 skipped by the deal. Nobody has folded a hand that has not been
                 dealt yet — the only players who genuinely get no cards are
                 those sitting out or away. */
              activeSeats={tableState.players
                .map((p, i) => (p && p.status !== 'sitting_out' && p.status !== 'away' ? i : -1))
                .filter((i) => i >= 0)}
              dealerSeatIndex={Math.max(0, tableState.dealerSeat - 1)}
              seatPositions={seatPositions}
              onComplete={() => setDealAnimationKey(0)}
              playSounds={ambientSoundsAllowed}
            />
          )}

          {/* AUDIT FIX 2026-07-19: mount the chip-flight layer. Every wager
              (bet/raise/call/all-in) + blinds + pot-to-winner already pushes
              events into `chipAnimations`, but the ChipAnimationManager was
              never rendered anywhere, so no chips ever flew to the pot or to
              winners (and the array leaked, never draining). Render it here as
              a full-felt overlay. */}
          <ChipAnimationManager
            animations={chipAnimations}
            onAnimationComplete={handleAnimationComplete}
          />

          {/* Dan 2026-08-21: floating pot-win amount — "+N" rides the pushed
              pot to the winner, then rises and fades above their avatar
              (PokerBros reference). Pure CSS animation, self-cleaning. */}
          {potWinFloats.map((f) => (
            <div
              key={f.id}
              className="pot-win-float"
              style={
                {
                  '--pwf-from-x': `${f.fromX}px`,
                  '--pwf-from-y': `${f.fromY}px`,
                  '--pwf-to-x': `${f.toX}px`,
                  '--pwf-to-y': `${f.toY}px`,
                } as React.CSSProperties
              }
              aria-hidden="true"
            >
              {f.label}
            </div>
          ))}

          {/* COMPETITOR-PARITY 2026-08-19: table-level ALL IN banner — fires
              once when the runout locks in (first equity broadcast). */}
          {showAllInBanner && (
            <div className="allin-banner" role="status" aria-label="All in">
              <span className="allin-banner__text">ALL IN</span>
            </div>
          )}

          {/* Pot Display — click to toggle chips/BB */}
          <div className="pot-area">
            <PotDisplay
              mainPot={tableState.pot}
              sidePots={tableState.sidePots}
              bigBlind={safeBB(tableState.blinds, 0)}
              displayMode={v8Settings.show_stack_in_bb ? 'bb' : 'chips'}
              onToggleDisplayMode={() => toggleV8Setting('show_stack_in_bb')}
              collectTo={potCollectTo}
              /* Dan 2026-08-20: live bets still in front of players — shown as
                 a second thin pill under the POT pill; they merge into the pot
                 total when the street's chips sweep to the middle. */
              streetBets={(tableState.lastBetAmounts || []).reduce((s, a) => s + (a || 0), 0)}
            />
            {/* AUDIT FIX 2026-07-19: removed the duplicate PremiumPot —
                it rendered the SAME pot total in the same .pot-area as
                PotDisplay, drawing the number twice (stacked). PotDisplay
                already shows the amount + a chip stack next to it + side
                pots, which is the single authoritative pot display. */}
            {/* Phase 2 T1-04 — PokerBros signature: hand strength label
             *  floats at pot center for ~1s on ANY win (showdown or not).
             *  2026-04-16 fix: removed boardStage === 'showdown' gate —
             *  PokerBros shows winning hand name on ALL wins, including
             *  when everyone folds. Keyed on hand number + hand name so
             *  every new hand re-triggers the animation. */}
            {winnerInfo.handName && (
              <div
                className="pot-hand-strength"
                key={`hand-${tableState.handNumber ?? 0}-${winnerInfo.handName}`}
                role="status"
              >
                {winnerInfo.handName}
              </div>
            )}
          </div>

          {/* AUDIT FIX 2026-07-19: the TimeBank "engaging" panel (extra-time
              countdown + activate/buy) was imported but never mounted, so when
              the primary timer expired the time bank had no distinct visual and
              its seconds-remaining were invisible. Render it as a fixed overlay
              above the action area while active/engaging. The banks-remaining
              counter (TimebankCounter) is separate and already shows. */}
          {timeBankActive && (
            <div
              style={{
                /* Dan 2026-08-18 (screenshot review): bottom 22% landed the
                   countdown panel squarely ON the hero's avatar and hole
                   cards. Anchored just above the action bar instead, where
                   nothing else lives. */
                position: 'fixed',
                bottom: 'calc(150px + env(safe-area-inset-bottom, 0px))',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 60,
                pointerEvents: 'none',
              }}
            >
              <TimeBank
                isVisible={true}
                isActive={timeBankActive}
                banksRemaining={timeBanksRemaining}
                totalTime={timeBankGrantedSeconds}
                timeRemaining={timeBankTimeRemaining}
                onActivate={handleActivateTimeBank}
                onBuyMore={handleBuyTimeBank}
                diamondCost={timeBankDiamondCost}
              />
            </div>
          )}

          {/* Player Seats */}
          {seatPositions.map((pos, idx) => {
            const seatNumber = idx + 1;
            const player = getPlayerAtSeat(seatNumber);

            // SPOTLIGHT (Dan 2026-08-15, verbatim: "spotlight on the player's
            // turn isn't working, even if hero folds — that functionality must
            // always be ON AT ALL TIMES").
            //
            // Two gates were suppressing it. `v8Settings.highlight_active_players`
            // let a stale/absent user setting switch the whole effect off, and
            // `isHandInProgress` is false during the snapshot races between
            // streets — so the spotlight dropped out exactly when the action
            // was moving, which is when it matters. currentPlayerSeat > 0 is
            // the authoritative "someone is on the clock" signal and is the
            // only condition kept. The effect now runs whether or not hero is
            // still in the hand.
            const someoneActing = tableState.currentPlayerSeat > 0;
            const isActingSeat = someoneActing && seatNumber === tableState.currentPlayerSeat;
            // Dan: hero is NEVER faded while holding a live hand, even when the
            // action is elsewhere. A folded hero dims like anyone else.
            const heroHasLiveHand =
              !!player?.isHero && player.status !== 'folded' && player.status !== 'sitting_out';
            const seatDimmed = someoneActing && !isActingSeat && !heroHasLiveHand;

            // FIX: Apply use_alias and table_alias from settings directly to the hero's rendered name
            let derivedHeroName = player?.name;
            if (player?.isHero) {
              if (v8Settings.use_alias && v8Settings.table_alias) {
                // User explicitly set an alias — always use it
                derivedHeroName = v8Settings.table_alias;
              } else if (useRealName && heroProfile?.display_name) {
                derivedHeroName = heroProfile.display_name;
              } else if (heroProfile?.username) {
                derivedHeroName = heroProfile.username;
              } else if (heroProfile?.display_name) {
                // Fallback: use display_name even if useRealName is off
                derivedHeroName = heroProfile.display_name;
              }
              // If still "Player X" pattern and we have ANY profile info, use it
              if (derivedHeroName?.startsWith('Player ') && heroProfile) {
                derivedHeroName =
                  heroProfile.display_name || heroProfile.username || derivedHeroName;
              }
            }
            let displayPlayer = player
              ? {
                  ...player,
                  name: derivedHeroName!,
                }
              : null;
            // The seat hero just tapped: show them SITTING immediately, with a
            // pending stack, while the buy-in modal is still open. Replaced by
            // real server data the moment the buy-in lands.
            // Dan 2026-08-18: the hero occupies their chair from the moment
            // they tap "+" and STAYS there through buy-in and through the
            // wait-to-be-dealt-in window. Previously the placeholder covered
            // only the modal, so the avatar vanished the instant chips were
            // confirmed and the seat read EMPTY until the next hand.
            if (
              !displayPlayer &&
              (pendingSeat === seatNumber || tableState.heroSeat === seatNumber)
            ) {
              displayPlayer = {
                id: userId,
                name: username || 'You',
                avatar: heroAvatarUrl || '',
                stack: pendingSeatStackRef.current || 0,
                status: 'sitting_out',
                isHero: true,
                showCards: false,
              } as any;
            }

            // THE CHIP RAIL. Dan 2026-08-21: every player's chips sit the
            // same distance from them, whatever seat they are in.
            //
            // This used to scale each axis independently by how far the seat
            // was from centre ON THAT AXIS, so a top-centre seat's chips
            // dropped straight down a long way, a side seat's slid inward a
            // long way, and a corner seat's did a bit of both - three
            // different distances. betChipOffsetPx() steps a fixed number of
            // pixels along the line to the middle instead, which puts every
            // seat's chips on one rail running parallel to the seats.
            //
            // The dealer's seat still steps out further so the order from the
            // player remains: player, button, chips.
            const isDealerSeat = idx === dealerVisualIndex;
            // Still needed by the deal/muck keyframes below, which fly cards
            // from and toward the centre and want the full run, not the rail.
            const dx = 50 - pos.x;
            const dy = 50 - pos.y;
            const betOffset = betChipOffsetPx(pos, scalerSize, isDealerSeat);
            const betOffsetX = betOffset.x;
            const betOffsetY = betOffset.y;
            // Bible V8 §1.16 — on collect, bet chips fly from their resting
            // spot the rest of the way toward the pot. Expressed as the
            // remainder to a common endpoint, so chips from every seat
            // converge on the same place however far out they started.
            const collectOffset = chipCollectOffsetPx(pos, scalerSize, isDealerSeat);
            const collectDx = collectOffset.x;
            const collectDy = collectOffset.y;

            return (
              <div
                key={seatNumber}
                /* Dan 2026-08-19, bug list item 10: the TOP-CENTRE seat is the
                   one with nothing above it but the BBJ banner, so it gets the
                   compact treatment (smaller avatar + capped bust art) that
                   lets its box rest ON the rail. See .seat-wrapper--top in
                   SeatSlot.css for the measurements behind it. Top DIAGONAL
                   seats sit lower on the cap curve and already clear the
                   banner at full size, so they are deliberately excluded - and
                   no layout has both, so nothing looks mismatched. */
                className={`seat-wrapper${seatDimmed ? ' seat-wrapper--dim' : ''}${
                  isActingSeat ? ' seat-wrapper--spot' : ''
                }${pos.y < 20 && pos.x === 50 ? ' seat-wrapper--top' : ''}`}
                style={
                  {
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                    '--bet-offset-x': `${betOffsetX}px`,
                    '--bet-offset-y': `${betOffsetY}px`,
                    '--collect-dx': `${collectDx}px`,
                    '--collect-dy': `${collectDy}px`,
                    /* ANIMATION AUDIT 2026-08-19: cardDealIn and cardFoldOut
                       have always taken direction from --deal-from-x/y and
                       --fold-to-x/y, and NOTHING ever set them — every seat's
                       cards dropped straight down on the deal and floated
                       straight up on the fold. Deal FROM the table centre
                       (the dealer), muck TOWARD it. */
                    '--deal-from-x': `${Math.round((dx * scalerSize.w) / 100)}px`,
                    '--deal-from-y': `${Math.round((dy * scalerSize.h) / 100)}px`,
                    '--fold-to-x': `${Math.round((dx * scalerSize.w * 0.55) / 100)}px`,
                    '--fold-to-y': `${Math.round((dy * scalerSize.h * 0.55) / 100)}px`,
                  } as React.CSSProperties
                }
              >
                <SeatSlot
                  seatNumber={seatNumber}
                  player={displayPlayer}
                  /* Dan 2026-08-18: only the hero can mark their own cards. */
                  showPickedCardIndexes={displayPlayer?.isHero ? shownCardIndexes : undefined}
                  onToggleShowCard={displayPlayer?.isHero ? handleToggleShowCard : undefined}
                  position={tableState.positions[idx] || null}
                  /* Always on: the acting seat is always marked active. The
                     v8Settings.highlight_active_players gate is gone — see the
                     spotlight note above. */
                  isActive={seatNumber === tableState.currentPlayerSeat}
                  lastAction={tableState.lastActions[idx] || null}
                  lastBetAmount={tableState.lastBetAmounts[idx] || 0}
                  isCollectingChips={collectingChipSeats[idx] || false}
                  turnDeadlineMs={
                    seatNumber === tableState.currentPlayerSeat
                      ? tableState.actionTimerDeadline
                      : undefined
                  }
                  turnStartTimeMs={
                    seatNumber === tableState.currentPlayerSeat
                      ? tableState.actionTimerStartTime
                      : undefined
                  }
                  timerProgress={
                    seatNumber === tableState.currentPlayerSeat ? actionTimerProgress : undefined
                  }
                  secondsLeft={
                    seatNumber === tableState.currentPlayerSeat ? actionTimeRemaining : undefined
                  }
                  bigBlind={safeBB(tableState.blinds)}
                  /* Dan 2026-08-21, item 15: hero's live made hand. */
                  handStrength={displayPlayer?.isHero ? heroHandStrength : null}
                  isTournament={tableState.isTournament}
                  bountyValue={
                    tableState.isBountyTournament && player
                      ? tableState.bountyMap[player.id]
                      : undefined
                  }
                  bombPotAnte={bombPotActive}
                  isWinner={player ? winnerInfo.playerIds.includes(player.id) : false}
                  winningHandName={
                    player && winnerInfo.playerIds.includes(player.id)
                      ? winnerInfo.handName
                      : undefined
                  }
                  // Phase 2 T1-01: net-profit +N floating text. Look up this
                  // seat's winner record (if any) from the engine snapshot.
                  netWinAmount={
                    player
                      ? tableState.engineWinners?.find((w) => w.userId === player.id)?.netAmount
                      : undefined
                  }
                  bbjCreditAmount={player ? bbjSeatCredits[player.id] : undefined}
                  hudStats={player && !player.isHero ? getPlayerHUDStats(player.id) : null}
                  showHUD={userSettings.showHUD && !!player && !player.isHero}
                  deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                  cardBack={activeCardBack}
                  showStackInBB={v8Settings.show_stack_in_bb}
                  showAvatar={v8Settings.show_avatars}
                  showBadges={v8Settings.show_badges}
                  gesturesEnabled={v8Settings.gestures_enabled}
                  playerStyle={
                    userSettings.showHUD && player && !player.isHero
                      ? (() => {
                          const stats = getPlayerHUDStats(player.id);
                          if (!stats) return null;
                          return playerStyleClassifier.classify({
                            handsPlayed: stats.handsPlayed,
                            vpipCount: stats.vpipCount,
                            pfrCount: stats.pfrCount,
                          });
                        })()
                      : null
                  }
                  onSit={() => handleSeatClick(seatNumber)}
                  /* Dan 2026-08-15: "when a player is seated at the table, the
                     open seats that were a + should now say EMPTY. A user
                     should never be able to sit at multiple seats." Three
                     independent signals, because each lands at a different
                     moment: heroSeat (snapshot), a scan of the players array
                     (realtime INSERT), and pendingSeat (this frame, before any
                     network call). Any one of them means "already seated". */
                  canSit={
                    tableState.heroSeat <= 0 &&
                    pendingSeat === null &&
                    !tableState.players.some((pl) => pl && pl.id === userId) &&
                    /* A tournament seat is not for sale - EXCEPT in the
                       seat-first formats, where buying the seat IS how you
                       enter. handleSeatClick already has the branch; without
                       this the seat renders as a passive EMPTY marker and the
                       footer's "Tap An Open Seat To Join" is a dead letter. */
                    (!tableState.isTournament || !!seatFirstBuyIn)
                  }
                  /* Dan 2026-08-18: the hero's own reserved seat reads
                     "YOUR SEAT" instead of the generic EMPTY. */
                  isHeroReservedSeat={
                    tableState.heroSeat === seatNumber || pendingSeat === seatNumber
                  }
                  onAvatarClick={() => {
                    // Open throwable selector targeting this seat
                    setThrowTargetSeat(seatNumber);
                    setShowThrowableSelector(true);
                    // Also record clicked player for Player Notes targeting
                    if (player && !player.isHero) {
                      setSelectedPlayerForNotes({ id: player.id, name: player.name });
                    }
                  }}
                  isDealing={isSeatDealing}
                  isMucking={muckingSeats[idx] || false}
                  /* COMPETITOR-PARITY 2026-08-19: Card Squeeze — hero only.
                     Force-reveal conditions (showdown stage) are folded in
                     here; SeatSlot adds the per-seat ones (all-in, winner). */
                  cardSqueezeActive={
                    !!displayPlayer?.isHero &&
                    v8Settings.card_squeeze &&
                    tableState.boardStage !== 'showdown'
                  }
                  handNumber={tableState.handNumber ?? 0}
                  playSounds={ambientSoundsAllowed}
                />

                {/* FIX 89: All-In Equity Overlay — shown per seat during all-in */}
                {allInEquities.length > 0 &&
                  player &&
                  (() => {
                    // AUDIT-2 FIX 2026-08-20: this was `seat === seatNumber ||
                    // userId === player.id` — an OR across two identity keys
                    // returns the FIRST entry matching EITHER, so any seat-
                    // numbering disagreement silently showed another player's
                    // equity on this seat. userId is authoritative; seat is
                    // only a fallback for entries with no userId.
                    const eq =
                      allInEquities.find((e) => e.userId === player.id) ??
                      allInEquities.find((e) => !e.userId && e.seat === seatNumber);
                    if (!eq) return null;
                    const isAhead = eq.equity >= 50;
                    /* ANIMATION AUDIT 2026-08-19: styling moved to
                       TablePage.css (.equity-overlay) — the inline block had
                       no transition, so 72.4% snapped to 13.1% with zero
                       emphasis. The value is keyed so each street's new
                       percentage replays the pop, and ahead/behind colors
                       cross-fade via CSS. */
                    return (
                      <div
                        key={`eq-${eq.equity}`}
                        className={`equity-overlay ${isAhead ? 'equity-overlay--ahead' : 'equity-overlay--behind'}`}
                      >
                        {eq.equity}%
                        {/* Mini equity bar under the number.
                            AUDIT-2 FIX 2026-08-20: the bar used to size itself
                            against the BADGE, whose width follows its text —
                            so "9%" and "100%" rendered nearly identical bars
                            and the graphic encoded nothing. It now fills a
                            fixed-width track, so bar lengths are directly
                            comparable across seats. */}
                        <span className="equity-overlay__track">
                          <span
                            className="equity-overlay__bar"
                            style={{ width: `${Math.max(2, Math.min(100, eq.equity))}%` }}
                          />
                        </span>
                      </div>
                    );
                  })()}
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          BOTTOM CONTROLS + ACTION PANEL
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="action-panel-wrapper">
        {/* POKERBROS-spec: persistent footer bar — NEVER empty. Dan rule
            2026-04-17: action bar fixed to footer at all times, every state. */}
        {!tableState.players.some((p) => p?.isHero) && tableState.heroSeat <= 0 ? (
          <div className="spectator-footer-bar">
            <span className="spectator-footer-bar__label">
              Spectating, Tap An Open Seat To Join
            </span>
          </div>
        ) : !tableState.players.some((p) => p?.isHero) ? (
          /* Dan 2026-08-17 (audit): heroSeat is reserved but the server hasn't
             dealt the hero in yet (waiting on next hand / BB post). The old
             branch fell through to "Spectating - tap an open seat" which
             contradicted the reserved seat + "Post BB to Enter" CTA on felt. */
          <div className="spectator-footer-bar" data-state="reserved">
            <span className="spectator-footer-bar__label">
              Seat Reserved, You'll Be Dealt In Next Hand
            </span>
          </div>
        ) : seatFirstBuyIn && tableState.heroSeat > 0 ? (
          /* SEAT RESERVED (Dan 2026-08-21). The buy-in secured a seat; no
             chips exist yet and no hand is running. Say so, and offer the way
             out — "IF THEY LEAVE THE SEAT THEY ARE FULLY REFUNDED." */
          <div className="spectator-footer-bar" data-state="reserved">
            <span className="spectator-footer-bar__label">Seat Reserved, Waiting For Players</span>
            <button
              type="button"
              className="spectator-footer-bar__cta spectator-footer-bar__cta--leave"
              disabled={seatFirstPending}
              onClick={() => {
                if (!tableId || seatFirstPending) return;
                setSeatFirstPending(true);
                void (async () => {
                  try {
                    const { data, error } = await supabase.rpc('fn_leave_seat_and_refund', {
                      p_table_id: tableId,
                    });
                    const res = (data ?? {}) as {
                      ok?: boolean;
                      reason?: string;
                      refunded?: number;
                    };
                    if (error || !res.ok) {
                      const reason = error?.message || res.reason || '';
                      toast?.error?.(
                        /already_started/.test(reason)
                          ? 'The Game Has Started, Your Seat Is In Play'
                          : 'Could Not Release That Seat, Please Try Again'
                      );
                      return;
                    }
                    heroSeatRef.current = 0;
                    setTableState((prev) => ({ ...prev, heroSeat: 0 }));
                    toast?.success?.(
                      `Seat Released, ${Number(res.refunded ?? 0).toLocaleString()} Chips Refunded`
                    );
                    const backTo = actualClubIdRef.current;
                    if (backTo) navigate(`/clubs/${backTo}`);
                  } catch (err) {
                    reportError(err as Error, 'TablePage.leave_seat_refund');
                    toast?.error?.('Could Not Release That Seat, Please Try Again');
                  } finally {
                    setSeatFirstPending(false);
                  }
                })();
              }}
            >
              Leave Seat
            </button>
          </div>
        ) : getPlayerAtSeat(tableState.heroSeat)?.status === 'sitting_out' ||
          sittingOutIdsRef.current.has(userId || '') ? (
          /* SIT-OUT VISIBILITY 2026-08-21: whether the hero sat out from the
             settings panel or was force-sat-out after 3 straight timeouts,
             the footer says so plainly and offers the way back. In
             tournaments the seat keeps posting blinds while sat out (Dan:
             "they just get blinded out") — all the more reason the CTA must
             be impossible to miss. */
          <div className="spectator-footer-bar" data-state="sitting-out">
            <span className="spectator-footer-bar__label">You Are Sitting Out</span>
            <button
              type="button"
              className="spectator-footer-bar__cta"
              onClick={() => {
                if (!tableId) return;
                void setSitOut(tableId, false).then((res) => {
                  if (res?.success) {
                    if (userId) sittingOutIdsRef.current.delete(userId);
                    setSitOutNextHand(false);
                    setTableState((prev) => {
                      const seatIdx = prev.heroSeat - 1;
                      const players = [...prev.players];
                      const hero = players[seatIdx];
                      if (hero && (hero as any).status === 'sitting_out') {
                        players[seatIdx] = { ...hero, status: 'active' } as any;
                      }
                      return { ...prev, players };
                    });
                    toast?.success?.("Welcome Back, You'll Be Dealt Into The Next Hand");
                  } else {
                    toast?.error?.(res?.error || 'Could not sit you back in');
                  }
                });
              }}
            >
              I'm Back
            </button>
          </div>
        ) : !tableState.isHandInProgress &&
          !isRabbitAvailable ? null : tableState.isHandInProgress &&
          (getPlayerAtSeat(tableState.heroSeat)?.status === 'folded' ||
            getPlayerAtSeat(tableState.heroSeat)?.status ===
              'away') /* Dan: "YOU DO NOT NEED TO HAVE THIS DISPLAY ON THE BOTTOM... ITS
             POINTLESS. REMOVE THIS." Both bars said only that nothing was
             happening, which the table already shows: your cards are gone and
             no action buttons are up. They cost a permanent strip of screen on
             a phone to repeat it. */ ? null : (
          <>
            {/* ─── CONTROL STRIP — Minimal: Time Bank + Timer during hand, Rabbit Hunt after hand ─── */}
            {tableState.isHandInProgress &&
              tableState.currentPlayerSeat === tableState.heroSeat && (
                <div className="control-strip control-strip--transparent">
                  {/* Time Bank */}
                  <button
                    className="control-strip__btn"
                    title="Time Bank"
                    onClick={handleActivateTimeBank}
                    disabled={timeBanksRemaining <= 0 || timeBankActive}
                  >
                    <span className="control-strip__icon">◷</span>
                    <span className="control-strip__count">{timeBanksRemaining}</span>
                  </button>

                  {/* Timer Display */}
                  <div className="control-strip__timer">
                    <span className="control-strip__timer-val">
                      {Math.ceil(actionTimeRemaining) || 0}s
                    </span>
                  </div>
                </div>
              )}

            {/* Rabbit Hunt — shows AFTER hand completes, not during */}
            {!tableState.isHandInProgress && isRabbitAvailable && (
              <div className="control-strip control-strip--transparent">
                <button
                  className="control-strip__btn"
                  title="Rabbit Hunt - reveal remaining cards"
                  onClick={handleRabbitReveal}
                >
                  <span className="control-strip__icon">R</span>
                  <span className="control-strip__label">Rabbit Hunt</span>
                </button>
              </div>
            )}

            {/* ─── ACTION PANEL — Premium 3-button layout ─── */}
            {/* QuickActionsBar REMOVED — Auto-Rebuy is a hamburger menu setting,
                Chat and Stats have their own dedicated locations */}

            {/* 2026-04-14 CRITICAL FIX: require both seats > 0 so the
                 between-hands 0===0 case doesn't briefly mount ActionPanel. */}
            {tableState.heroSeat > 0 &&
            tableState.currentPlayerSeat > 0 &&
            tableState.currentPlayerSeat === tableState.heroSeat &&
            tableState.isHandInProgress
              ? (() => {
                  // Bible V8 §1.4: Use SERVER-AUTHORITATIVE values, not local calculations
                  const heroPlayer = getPlayerAtSeat(tableState.heroSeat);
                  const heroStack = heroPlayer?.stack || 0;
                  const heroBet = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
                  const bb = safeBB(tableState.blinds);

                  // Derive callAmount from server's currentBet minus hero's current bet
                  const serverCurrentBet = tableState.currentBet || 0;
                  const callAmount = Math.min(Math.max(0, serverCurrentBet - heroBet), heroStack);

                  // AUDIT FIX 2026-07-19 (client-2): the server's `min_raise` is
                  // the raise *increment* (max(BB, lastRaise)), but ActionPanel
                  // treats its `minRaise`/`maxRaise` props as raise-TO absolute
                  // amounts (matching the engine, which reads `raise` amounts as
                  // raise-TO with floor currentBet + min_raise). Passing the bare
                  // increment made the slider bottom out BELOW the current bet, so
                  // confirming committed far more than the button showed. Convert
                  // to raise-TO here.
                  const raiseIncrement =
                    tableState.minRaise && tableState.minRaise > 0 ? tableState.minRaise : bb;
                  // Raise-TO floor. When currentBet===0 (first bet of a street)
                  // this is the min bet (= one increment = BB).
                  const minRaise = serverCurrentBet + raiseIncrement;

                  // Bible V8 §4.14: raise-TO ceiling. All-in-to = stack + own
                  // current bet (engine: maxRaiseTo = player.stack + player.bet).
                  const allInTo = heroStack + heroBet;
                  const gameVariant = tableState.gameType?.toLowerCase() || '';
                  const isPotLimit = gameVariant.startsWith('plo'); // FIX 116: 'flo' dead variant removed
                  // Pot-limit raise-TO cap = currentBet + (pot + toCall). Matches
                  // engine FIX 142 (never over-offer past the server's clamp).
                  const potLimitRaiseTo = potSizedRaiseTo(
                    serverCurrentBet,
                    tableState.pot,
                    callAmount
                  );
                  const maxRaise = isPotLimit ? Math.min(allInTo, potLimitRaiseTo) : allInTo;

                  return (
                    <>
                      {/* VISIBLE FIX 2026-08-15: a second Rabbit Hunt button
                          used to live here, calling handleRabbitReveal directly
                          and DISCARDING the returned cards. It consumed
                          serverRabbitCardsRef for free and showed nothing — and
                          the real paid RabbitHunt panel then charged 5 diamonds
                          and revealed an empty board. The RabbitHunt component
                          in TableModalsLayer is the single entry point. */}
                      <ActionPanel
                        canFold={true}
                        canCheck={callAmount === 0}
                        canCall={callAmount > 0}
                        canRaise={heroStack > callAmount && allInTo >= minRaise}
                        /* Dan 2026-08-21, BINDING: "IN PLO YOU CAN NEVER GO
                           ALL IN IF THE POT IS LESS THAN THE CHIPS YOU HAVE."
                           The engine refuses it; the button must not offer it. */
                        canAllIn={heroStack > 0 && (!isPotLimit || allInTo <= maxRaise + 0.005)}
                        callAmount={callAmount}
                        minRaise={minRaise}
                        maxRaise={maxRaise}
                        /* Dan 2026-08-18: in PLO maxRaise is the POT CAP, so
                           the panel needs the real all-in threshold separately
                           or a pot-sized bet reads as a shove. */
                        allInTo={allInTo}
                        pot={tableState.pot}
                        bigBlind={bb}
                        /* Multiplier presets are multiples of the bet being
                           faced, not of the blind — without this they all
                           clamped to minRaise and 2X/3X/4X/5X produced the
                           same number. See ActionPanel presets. */
                        currentBet={serverCurrentBet}
                        onAction={handleActionPanelAction}
                        /* The documented R / E hotkey and the 1/2/3/4 pot-fraction
                           keys arrive here. Before 2026-08-20 they set a
                           `showRaiseSlider` flag that nothing rendered. */
                        raiseIntent={raiseIntent}
                        isMyTurn={true}
                        isPreflop={tableState.boardStage === 'preflop'}
                        /* Dan 2026-08-19 item 4b: PLO must always offer
                           RAISE POT - preflop had no POT button at all. */
                        isPotLimit={isPotLimit}
                        showPotOdds={userSettings.showPotOdds}
                        confirmAllIn={userSettings.confirmAllIn}
                      />
                    </>
                  );
                })()
              : null}

            {/* ─── SHOW HAND BUTTON — Bible V8 §4.21: Voluntary show at showdown.
                 Dan rule 2026-04-17: ALL action buttons live in the footer, never
                 floating above it. Rendered as a footer bar, flow positioned. */}
            {tableState.boardStage === 'showdown' &&
              tableState.heroSeat > 0 &&
              tableId &&
              getPlayerAtSeat(tableState.heroSeat)?.status !== 'folded' && (
                <div className="footer-action-bar">
                  <button
                    className="footer-action-bar__btn"
                    onClick={async () => {
                      const result = await serverShowHand(tableId);
                      if (!result.success) {
                        reportError(result.error, 'TablePage.Failed');
                      }
                    }}
                  >
                    Show Hand
                  </button>
                </div>
              )}

            {/* ─── PRE-ACTION BAR — Show when hero is seated AND not their turn.
                 2026-04-14 fix: also require heroSeat > 0 so observers (heroSeat=0)
                 don't see the pre-action bar; and require currentPlayerSeat to be
                 a real player — if 0 (transient between hands), hide the bar so
                 it doesn't flicker against the ActionPanel during the same window. */}
            {tableState.isHandInProgress &&
              tableState.heroSeat > 0 &&
              tableState.currentPlayerSeat > 0 &&
              tableState.currentPlayerSeat !== tableState.heroSeat &&
              /* Dan 2026-04-17: after hero folds, hide PreActionBar — the
                 "weird lingering bar" bug. Folded hero has no pre-turn action. */
              getPlayerAtSeat(tableState.heroSeat)?.status !== 'folded' &&
              getPlayerAtSeat(tableState.heroSeat)?.status !== 'away' && (
                <PreActionBar
                  canCheck={
                    // Bible V8: Check is available when there's no outstanding bet to call
                    // Compare server's currentBet to hero's current bet
                    (tableState.currentBet || 0) <=
                    (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0)
                  }
                  isMyTurn={false}
                  preAction={preAction}
                  onPreActionChange={(next) => {
                    // Snapshot whether checking was free at arm time so the
                    // effect above can send auto_check_fold vs auto_fold.
                    preActionCanCheckRef.current =
                      (tableStateRef.current.currentBet || 0) <=
                      (tableStateRef.current.lastBetAmounts?.[tableStateRef.current.heroSeat - 1] ||
                        0);
                    setPreAction(next);
                  }}
                  currentBet={Math.max(
                    0,
                    (tableState.currentBet || 0) -
                      (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0)
                  )}
                />
              )}
          </>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          POST-BB-TO-ENTER OVERLAY (Bible V8 §4.2)
          Walkthrough Step 4 fix 2026-04-29 — engine has tracked waiting-for-BB
          state for a long time but had no client UI control. This overlay
          renders a small button when the hero is in waitingForBBUserIds, so
          they can pay the BB to enter the next hand instead of waiting for
          the BB to rotate to their seat naturally.
          ═══════════════════════════════════════════════════════════════════════ */}
      {userId &&
        tableId &&
        Array.isArray(tableState.waitingForBBUserIds) &&
        tableState.waitingForBBUserIds.includes(userId) && (
          <button
            type="button"
            className="post-bb-overlay-button"
            onClick={async () => {
              const result = await serverPostBBToEnter(tableId);
              if (!result.success) {
                toast?.error(result.error || 'Could not post BB');
              } else {
                toast?.success('Will be dealt in next hand');
              }
            }}
            aria-label="Post the big blind to enter the next hand"
          >
            <span className="post-bb-overlay-button__title">Post BB To Enter</span>
            <span className="post-bb-overlay-button__sub">Skip The Wait, Pay The BB Now</span>
          </button>
        )}

      {/* ═══════════════════════════════════════════════════════════════════════
          SIDE MENU (Slide-in)
          ═══════════════════════════════════════════════════════════════════════ */}
      {isSideMenuOpen && (
        <>
          <div className="menu-overlay" onClick={toggleSideMenu} />
          <nav className="side-menu">
            <button className="menu-item" onClick={() => navigate('/cashier')}>
              <span className="menu-item-icon">◉</span>
              <span className="menu-item-label">Cashier</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                if (tableState.heroSeat > 0) setShowCashier(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">+</span>
              <span className="menu-item-label">Top Up</span>
              <span className="menu-item-arrow">›</span>
            </button>
            {/* 2026-08-20: DiamondWalletModal was mounted in TableModalsLayer and
                `setShowDiamondWallet(true)` was never called anywhere, so the
                wallet was unreachable from the table — while diamonds are spent
                AT the table for throwables, emoji and rabbit hunts, each of which
                can fail with "Insufficient diamonds". Players could spend the
                currency but not check or top up the balance. */}
            <button
              className="menu-item"
              onClick={() => {
                setShowDiamondWallet(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">◆</span>
              <span className="menu-item-label">Diamonds</span>
              <span className="menu-item-arrow">›</span>
            </button>
            {/* 2026-08-20: TableReactions was mounted and gated on
                v8Settings.emoji_enabled, but setIsReactionPickerOpen(true) was
                never called anywhere — the picker itself is `{isOpen && ...}`.
                So a club owner could switch reactions ON in table settings and
                players still had no way to send one, while INCOMING reactions
                kept animating: it looked like everyone else had a button you
                did not. */}
            {v8Settings.emoji_enabled && (
              <button
                className="menu-item"
                disabled={tableState.heroSeat <= 0}
                onClick={() => {
                  if (tableState.heroSeat <= 0) return;
                  setIsReactionPickerOpen(true);
                  setIsSideMenuOpen(false);
                }}
              >
                <span className="menu-item-icon">☺</span>
                <span className="menu-item-label">Reactions</span>
                <span className="menu-item-arrow">›</span>
              </button>
            )}
            <button
              className="menu-item"
              onClick={() => {
                setShowGameRules(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">☰</span>
              <span className="menu-item-label">Table Rules</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                const next = !isSoundEnabled;
                setIsSoundEnabled(next);
                try {
                  localStorage.setItem('ca_sound_enabled', String(next));
                } catch {
                  /* localStorage unavailable */
                }
              }}
            >
              <span className="menu-item-icon">♪</span>
              <span className="menu-item-label">Sounds</span>
              <span className={`menu-item-toggle ${isSoundEnabled ? 'on' : ''}`}>
                {isSoundEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                const next = !isVibrationEnabled;
                setIsVibrationEnabled(next);
                try {
                  localStorage.setItem('ca_vibration_enabled', String(next));
                } catch {
                  /* localStorage unavailable */
                }
              }}
            >
              <span className="menu-item-icon">⋆</span>
              <span className="menu-item-label">Vibrations</span>
              <span className={`menu-item-toggle ${isVibrationEnabled ? 'on' : ''}`}>
                {isVibrationEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
            <button className="menu-item" onClick={() => setIsChatMuted(!isChatMuted)}>
              <span className="menu-item-icon">C</span>
              <span className="menu-item-label">Chat</span>
              <span className={`menu-item-toggle ${isChatMuted ? '' : 'on'}`}>
                {isChatMuted ? 'MUTED' : 'ON'}
              </span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                const shareUrl = `${window.location.origin}/hub/club-arena/table/${tableId}`;
                navigator.clipboard
                  ?.writeText(shareUrl)
                  .then(() => {
                    toast.success('Table link copied to clipboard!');
                  })
                  .catch((e) => {
                    console.warn('[TablePage] Failed to copy share URL to clipboard:', e);
                    toast.info('Share: ' + shareUrl);
                  });
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">↗</span>
              <span className="menu-item-label">Share</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setIsSideMenuOpen(false);
                navigate('/vip');
              }}
            >
              <span className="menu-item-icon">★</span>
              <span className="menu-item-label">VIP</span>
              <span className="menu-item-arrow">›</span>
            </button>
            {/* StraddleToggle was imported by this file and never rendered, so
                `setIsStraddleEnabled` had exactly one caller — the STRADDLE_TOGGLED
                bus echo — and a player had no way to switch straddling on. Only
                shown when the host enabled straddles for this table; the engine
                rejects the toggle outright otherwise. */}
            {isStraddleAvailable && (
              <div className="menu-item menu-item--embed">
                <StraddleToggle
                  tableId={tableId || ''}
                  playerId={userId}
                  isEnabled={isStraddleEnabled}
                  onToggle={(enabled) => void handleToggleStraddle(enabled)}
                  amount={straddleAmount}
                  isAvailable
                />
              </div>
            )}
            <button
              className="menu-item"
              onClick={() => {
                setShowPlayerNotes(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">✎</span>
              <span className="menu-item-label">Player Notes</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setShowHandReplay(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">♠</span>
              <span className="menu-item-label">Hand History</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setShowSessionHUD(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">--</span>
              <span className="menu-item-label">Live Stats</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleSitOut();
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">▮</span>
              <span className="menu-item-label">Sit Out</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                handleOpenWaitlist();
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">⌂</span>
              <span className="menu-item-label">Wait List</span>
              <span className="menu-item-arrow">›</span>
            </button>
            {/* Bible V8 §11.1 — Table Settings accessible from hamburger menu */}
            <button
              className="menu-item"
              onClick={() => {
                setShowSettings(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">⚙</span>
              <span className="menu-item-label">Table Settings</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <button
              className="menu-item exit"
              onClick={() => {
                setIsSideMenuOpen(false);
                setShowLeaveConfirm(true);
              }}
            >
              <span className="menu-item-icon">←</span>
              <span className="menu-item-label">Leave Table</span>
              <span className="menu-item-arrow">›</span>
            </button>
            <div className="menu-footer">Version: 1.0.0 (Club Arena)</div>
          </nav>
        </>
      )}

      {/* Observing / Join indicators REMOVED — empty seats already show "+ SIT" */}

      {/* Floating Chat/Mail Toggle Button (Bottom-Right) & I'm Back */}
      <div
        className="floating-action-br"
        style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}
      >
        {tableState.players[tableState.heroSeat - 1]?.status === 'sitting_out' && (
          <button
            className="floating-im-back"
            onClick={() => {
              soundService.playButtonClick();
              if (!tableId) return;
              // `.catch` was dead code — setSitOut resolves { success: false }
              // rather than throwing, so a refused sit-in was silent and the
              // player thought they were back in the game.
              void setSitOut(tableId, false).then((res) => {
                if (!res?.success) {
                  toast?.error?.(res?.error || 'Could not sit back in - try again');
                }
              });
            }}
          >
            I'm Back
          </button>
        )}
        {/* Duplicate chat toggle REMOVED — TableChat renders its own collapsed icon */}
      </div>

      {/*
        Bible V8 §11.1: text_message toggle — hide chat entirely when off.
        The underlying messages keep streaming into chatMessages so when the
        user re-enables, their history isn't lost.

        voice_message used to be OR'd into isMuted below. There is no voice
        chat at the table, so all that switch did was silently mute TEXT chat
        under a label that said "voice" — text_message already owns that, and
        owning it twice meant a player could turn text chat on and still not
        have it. The toggle is gone from TABLE_SETTINGS_META; when voice chat
        actually ships it gets its own gate here.
      */}
      {v8Settings.text_message && (
        <TableChat
          messages={chatMessages}
          onSendMessage={handleSendChatMessage}
          myPlayerId={userId}
          tableId={tableId}
          isCollapsed={isChatCollapsed}
          onToggleCollapse={() => setIsChatCollapsed(!isChatCollapsed)}
          placeholder={canChatAsObserver ? 'Say something...' : 'Observers cannot chat'}
          isMuted={isChatMuted}
          isDisabled={!canChatAsObserver}
          unreadCount={unreadCount}
        />
      )}

      {/* Bible V8 §11.1: emoji_enabled gate — skips reactions overlay entirely. */}
      {v8Settings.emoji_enabled && (
        <TableReactions
          tableId={tableId}
          userId={userId}
          heroSeat={tableState.heroSeat}
          isOpen={isReactionPickerOpen}
          onClose={() => setIsReactionPickerOpen(false)}
          activeReactions={activeReactions}
        />
      )}

      {/* Performance Monitor — dev-only */}
      <TablePerfMonitor />

      {/* Player Notes, Hand Replay, Settings, Insurance, RIT, BBJ, Throwables,
          Confetti, Leave Notice, Cashier, Buy-In, Rabbit Hunt,
          Leaderboard, Session Summary, Tournament Screens — all modals/overlays.
          Extracted to TableModalsLayer to keep TablePage under control. */}
      <PineappleDiscard
        isOpen={!!heroPineappleCards}
        cards={heroPineappleCards ?? []}
        onDiscard={handlePineappleDiscard}
        deadline={pineappleDeadline}
        deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
      />

      {/* Dan 2026-08-21: PokerBros-style hand breakdown. Replay + Share are
          buttons in its header, driving the existing HandReplayPlayer and
          ShareHand modals. */}
      <HandDetailModal
        isOpen={showHandDetail}
        onClose={() => setShowHandDetail(false)}
        hands={handHistory}
        heroId={userId || ''}
        onReplay={() => {
          setShowHandDetail(false);
          setShowHandReplay(true);
        }}
        onShare={() => {
          if (!sharedHandData) {
            toast?.info?.('Play a hand to the end, then share it.');
            return;
          }
          setShowHandDetail(false);
          setShowShareHand(true);
        }}
      />
      <TableModalsLayer
        tableId={tableId}
        userId={userId}
        username={username}
        ambientSoundsAllowed={ambientSoundsAllowed}
        tableName={tableState.tableName}
        blinds={tableState.blinds}
        gameType={tableState.gameType}
        isTournament={tableState.isTournament}
        tournamentId={tableState.tournamentId}
        maxPlayers={tableState.maxPlayers}
        players={tableState.players}
        heroStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
        rakePercent={displayRakeConfig.rakePercent}
        rakeCap={displayRakeConfig.rakeCap}
        runItTwice={tableState.runItTwice}
        isHandInProgress={tableState.isHandInProgress}
        boardStage={tableState.boardStage}
        handNumber={tableState.handNumber}
        v8Settings={v8Settings}
        userSettings={userSettings}
        isSoundEnabled={isSoundEnabled}
        sitOutNextHand={sitOutNextHand}
        // Player Notes
        showPlayerNotes={showPlayerNotes}
        selectedPlayerForNotes={selectedPlayerForNotes}
        onClosePlayerNotes={() => setShowPlayerNotes(false)}
        // Hand Replay
        showHandReplay={showHandReplay}
        lastHandId={lastHandId}
        onCloseHandReplay={() => setShowHandReplay(false)}
        // Game Rules
        showGameRules={showGameRules}
        isStraddleEnabled={isStraddleEnabled}
        bombPotRules={bombPotRules}
        onCloseGameRules={() => setShowGameRules(false)}
        // Chips
        chipAnimations={chipAnimations}
        onAnimationComplete={handleAnimationComplete}
        // Sit Out
        showSitOut={showSitOut}
        sitOutSince={sitOutSince}
        onCloseSitOut={() => setShowSitOut(false)}
        onReturnFromSitOut={() => {
          setShowSitOut(false);
          setSitOutNextHand(false);
        }}
        // Wait List
        showWaitList={showWaitList}
        waitListPlayers={waitListPlayers}
        onCloseWaitList={() => setShowWaitList(false)}
        onWaitListError={(m) => toast?.error?.(m)}
        onTopUpAccount={() => navigate('/cashier')}
        // Insurance
        showInsurance={showInsurance}
        insuranceOffer={insuranceOffer}
        onInsuranceAccept={handleInsuranceAccept}
        onInsuranceDecline={handleInsuranceDecline}
        onInsuranceDeclineForHand={handleInsuranceDeclineForHand}
        // Hand Reveal
        showHandRevealModal={showHandRevealModal}
        handRevealWinnerId={handRevealWinnerId}
        handRevealWinnerName={handRevealWinnerName}
        handRevealCards={handRevealCards}
        handRevealHandId={handRevealHandId}
        onHandRevealShow={() => setShowHandRevealModal(false)}
        onHandRevealMuck={() => setShowHandRevealModal(false)}
        onHandRevealClose={() => setShowHandRevealModal(false)}
        // RIT
        showRIT={showRIT}
        ritIsChooser={ritIsChooser}
        ritOpponent={ritOpponent}
        ritTimer={ritTimer}
        ritChosenRuns={ritChosenRuns}
        ritMaxRuns={ritMaxRuns}
        ritPlayerCount={ritPlayerCount}
        onRITChooserDecide={handleRITChooserDecide}
        onRITAccept={handleRITAccept}
        onRITDecline={handleRITDecline}
        ritResult={ritResult}
        onRitResultClose={() => {
          if (ritResultTimerRef.current) clearTimeout(ritResultTimerRef.current);
          setRitResult(null);
        }}
        ritResolveName={(uid) => tableState.players.find((p) => p?.id === uid)?.name || 'Player'}
        // BBJ
        showBBJ={showBBJ}
        bbjAmount={bbjAmount}
        bbjPoolId={bbjPoolId}
        bbjHeroName={tableState.players.find((p) => p && p.id === userId)?.name || null}
        showBBJCelebration={showBBJCelebration}
        bbjCelebrationData={bbjCelebrationData}
        onBBJCelebrationComplete={() => {
          setShowBBJCelebration(false);
          setBbjCelebrationData(null);
          setShowBBJ(false);
        }}
        // Throwables
        showThrowableSelector={showThrowableSelector}
        activeThrows={activeThrows}
        onThrowableSelect={handleThrowableSelect}
        onThrowableClose={() => setShowThrowableSelector(false)}
        onThrowComplete={handleThrowComplete}
        // Confetti
        showConfetti={showConfetti}
        winnerParticle={winnerParticle}
        onConfettiComplete={() => setShowConfetti(false)}
        onParticleComplete={() => setWinnerParticle((prev) => ({ ...prev, active: false }))}
        // Tip
        // Leave Notice
        leaveNotice={leaveNotice}
        onDismissLeaveNotice={() => setLeaveNotice(null)}
        // Diamond Wallet
        showDiamondWallet={showDiamondWallet}
        onCloseDiamondWallet={() => setShowDiamondWallet(false)}
        // Cashier
        showCashier={showCashier}
        accountBalance={accountBalance}
        cashoutMinBuyIn={cashoutMinBuyIn}
        buyInProcessingRef={buyInProcessingRef}
        onCloseCashier={() => setShowCashier(false)}
        onAddChips={handleAddChips}
        onWithdrawChips={handleWithdrawChips}
        // Bust Rebuy
        bustRebuyOpen={bustRebuyOpen}
        bustWalletBalance={bustWalletBalance}
        bustRebuyProcessing={bustRebuyProcessing}
        onCancelBustRebuy={cancelBustRebuy}
        onConfirmBustRebuy={confirmBustRebuy}
        // Buy-In
        showBuyInModal={showBuyInModal}
        selectedSeat={selectedSeat}
        heroAvatarUrl={heroAvatarUrl}
        onCloseBuyInModal={() => {
          // Releasing the modal must release the optimistic seat too, or the
          // player is locked out of every seat at the table by their own
          // abandoned reservation.
          setShowBuyInModal(false);
          setPendingSeat(null);
          setSelectedSeat(null);
        }}
        onConfirmBuyIn={async (amount, autoRebuy) => {
          if (buyInProcessingRef.current) return;
          buyInProcessingRef.current = true;
          pendingSeatStackRef.current = amount;
          // Dan 2026-08-15: chips land in the seat on CONFIRM, not on RPC
          // completion. Close the modal and paint the stack in this frame; the
          // duplicate-seat check and atomic_table_buyin RPC run behind it and
          // roll the seat back if either rejects. `seatedOptimistically` gates
          // that rollback so we never tear down a seat we never painted.
          const optimisticSeat = selectedSeat;
          let seatedOptimistically = false;
          if (userId && userId !== 'guest' && tableId && optimisticSeat) {
            setShowBuyInModal(false);
            setTableState((prev) => {
              const updatedPlayers = [...prev.players];
              for (let j = 0; j < updatedPlayers.length; j++) {
                if (updatedPlayers[j]?.id === userId && j !== optimisticSeat - 1) {
                  updatedPlayers[j] = null as any;
                }
              }
              updatedPlayers[optimisticSeat - 1] = {
                id: userId,
                name: username || 'Player',
                avatar: heroAvatarUrl || '',
                stack: amount,
                status: 'active',
                isHero: true,
                showCards: false,
              };
              return { ...prev, players: updatedPlayers, heroSeat: optimisticSeat };
            });
            heroSeatRef.current = optimisticSeat;
            setPendingSeat(null);
            seatedOptimistically = true;
          }
          /** Undo the optimistic seat when the server refuses the buy-in. */
          const revertSeat = () => {
            if (!seatedOptimistically || !optimisticSeat) return;
            setTableState((prev) => {
              const players = [...prev.players];
              if (players[optimisticSeat - 1]?.id === userId) {
                players[optimisticSeat - 1] = null as any;
              }
              return { ...prev, players, heroSeat: 0 };
            });
            heroSeatRef.current = 0;
            setPendingSeat(null);
          };
          try {
            if (userId && userId !== 'guest' && tableId && selectedSeat) {
              try {
                const { data: existingSeat } = await supabase
                  .from('table_seats')
                  .select('seat_number')
                  .eq('table_id', tableId)
                  .eq('user_id', userId)
                  .is('left_at', null)
                  .maybeSingle();
                if (existingSeat) {
                  toast.error(`You're already seated at seat ${existingSeat.seat_number}.`);
                  revertSeat();
                  setShowBuyInModal(false);
                  return;
                }
                const { data: rpcData, error: rpcErr } = await supabase.rpc('atomic_table_buyin', {
                  p_user_id: userId,
                  p_table_id: tableId,
                  p_seat_number: selectedSeat,
                  p_amount: amount,
                  p_auto_rebuy: autoRebuy || false,
                  // UNION LAW (Dan 2026-08-20): the club the player entered
                  // through. Chips come out of THAT club's wallet and the rake
                  // is earned for that club only — club wallets are never
                  // commingled. Ignored while union.club_scoped_chips is off.
                  p_club_id: useUserStore.getState().currentClubId ?? null,
                });
                if (rpcErr) {
                  reportError(rpcErr, 'TablePage.atomic_table_buyin_FAILED');
                  throw new Error('Failed to buy-in: ' + rpcErr.message);
                }
                const rpcResult = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData;
                if (rpcResult && rpcResult.success === false) {
                  reportError(rpcResult, 'TablePage.atomic_table_buyin_returned_failure');
                  throw new Error(
                    'Buy-in rejected: ' + (rpcResult.error || 'Unknown server error')
                  );
                }
                setAccountBalance((prev) => Math.max(0, prev - amount));
                totalBuyInRef.current += amount;
                if (amount > peakStackRef.current) peakStackRef.current = amount;
                // The seat + stack were already painted above, before this RPC
                // was even sent. Nothing to do here but confirm the ref.
                heroSeatRef.current = selectedSeat;
                HydraService.onRealPlayerJoined(tableId, userId);
                await sendAction('player_seated', {
                  seat: selectedSeat,
                  userId,
                  stack: amount,
                  autoRebuy,
                });
                // The game engine's 'player_seated' event will update table state globally.
                // RoomService presence is no longer needed since TableWebSocket handles connection.
                masterBus.emit('TABLE_SEATED', {
                  tableId,
                  seat: selectedSeat,
                  tableName: tableState.tableName,
                  userId,
                });
              } catch (error) {
                reportError(error, 'TablePage.Buyin_FAILED');
                revertSeat();
                toast.error('Buy-in failed. Please try again or check your balance.');
              }
            } else {
              reportError(
                { userId, tableId, selectedSeat },
                'TablePage.FELL_THROUGH__no_branch_matched'
              );
              toast.error('Unable to complete buy-in. Please try again.');
            }
            setShowBuyInModal(false);
          } catch (outerErr) {
            reportError(outerErr, 'TablePage.UNHANDLED_error_in_onConfirm');
            revertSeat();
            toast.error('An unexpected error occurred. Please try again.');
            setShowBuyInModal(false);
          } finally {
            buyInProcessingRef.current = false;
            setSelectedSeat(null);
          }
        }}
        // Rabbit Hunt
        isRabbitAvailable={isRabbitAvailable}
        currentBoard={currentBoard}
        onRabbitReveal={handleRabbitReveal}
        // Leaderboard
        showLeaderboard={showLeaderboard}
        leaderboardPlayers={leaderboardPlayers}
        leaderboardPeriod={leaderboardPeriod}
        onCloseLeaderboard={() => setShowLeaderboard(false)}
        onLeaderboardPeriodChange={setLeaderboardPeriod}
        // Leave Confirm
        showLeaveConfirm={showLeaveConfirm}
        onCloseLeaveConfirm={() => setShowLeaveConfirm(false)}
        onConfirmLeaveTable={handleLeaveTable}
        // Session Stats
        showSessionStats={showSessionStats}
        onCloseSessionStats={() => setShowSessionStats(false)}
        // Settings
        showSettings={showSettings}
        onCloseSettings={() => setShowSettings(false)}
        onSettingsChange={(settingsUpdate) => {
          if (settingsUpdate.soundEnabled !== undefined) {
            // setIsSoundEnabled() already calls soundService.setEnabled() internally.
            setIsSoundEnabled(settingsUpdate.soundEnabled);
            updateSetting('isSoundEnabled', settingsUpdate.soundEnabled);
          }

          if (settingsUpdate.autoMuckLosers !== undefined)
            updateSetting('autoMuck', settingsUpdate.autoMuckLosers);
          if (settingsUpdate.showPotOdds !== undefined)
            updateSetting('showPotOdds', settingsUpdate.showPotOdds);
          if (settingsUpdate.fourColorDeck !== undefined)
            updateSetting('fourColorDeck', settingsUpdate.fourColorDeck);
          if (settingsUpdate.confirmAllIn !== undefined)
            updateSetting('confirmAllIn', settingsUpdate.confirmAllIn);
          if (settingsUpdate.animationSpeed !== undefined) {
            updateSetting(
              'animationSpeed',
              settingsUpdate.animationSpeed === 'slow'
                ? 0.5
                : settingsUpdate.animationSpeed === 'fast'
                  ? 1.5
                  : 1
            );
          }
          if (settingsUpdate.showStackInBB !== undefined) toggleV8Setting('show_stack_in_bb');
          if (settingsUpdate.sitOutNextHand !== undefined) {
            const wanted = settingsUpdate.sitOutNextHand;
            setSitOutNextHand(wanted);
            if (tableId) {
              // Same dead-.catch problem as the other three sit-out entry
              // points: revert the switch when the server refuses so it never
              // shows a state the server does not hold.
              void setSitOut(tableId, wanted).then((res) => {
                if (!res?.success) {
                  setSitOutNextHand(!wanted);
                  reportError(
                    new Error(res?.error || 'setSitOut rejected by engine'),
                    'TablePage.Failed'
                  );
                  toast?.error?.(res?.error || 'Could not change your sit-out setting');
                }
              });
            }
          }
          if (settingsUpdate.autoMuckWinners !== undefined)
            updateSetting('autoMuckWinners', settingsUpdate.autoMuckWinners);
          if (settingsUpdate.autoPostBlinds !== undefined)
            updateSetting('autoPostBlinds', settingsUpdate.autoPostBlinds);
          if (settingsUpdate.hapticEnabled !== undefined)
            updateSetting('isHapticEnabled', settingsUpdate.hapticEnabled);
          if (settingsUpdate.tableTheme !== undefined)
            updateSetting('theme', settingsUpdate.tableTheme);
          if (settingsUpdate.soundVolume !== undefined) {
            updateSetting('soundVolume', settingsUpdate.soundVolume);
            soundService.setMasterVolume(settingsUpdate.soundVolume / 100);
          }
        }}
        // Share Hand
        showShareHand={showShareHand}
        sharedHandData={sharedHandData}
        onCloseShareHand={() => setShowShareHand(false)}
        // Add-On
        addOnPeriod={addOnPeriod}
        rebuyProcessing={rebuyProcessing}
        // Returns the outcome. This used to swallow the error and resolve void,
        // so AddOnModal printed "Add-On Accepted -- +N chips added" over a
        // purchase the server had just refused.
        onAddOnAccept={async () => {
          if (!tableState.tournamentId || !userId || rebuyProcessing) return false;
          setRebuyProcessing(true);
          try {
            await tournamentService.processAddOn(tableState.tournamentId, userId);
            toast?.success('Add-on accepted - chips added to your stack');
            setAddOnPeriod((prev) => ({ ...prev, active: false }));
            return true;
          } catch (err: any) {
            toast?.error(err.message || 'Add-on failed');
            return false;
          } finally {
            setRebuyProcessing(false);
          }
        }}
        onAddOnDecline={() => setAddOnPeriod((prev) => ({ ...prev, active: false }))}
        // Rebuy
        showRebuyModal={showRebuyModal}
        rebuyData={rebuyData}
        onConfirmRebuy={async () => {
          if (!tableState.tournamentId || !userId) return;
          setRebuyProcessing(true);
          try {
            await tournamentService.processRebuy(tableState.tournamentId, userId);
            toast?.success('Rebuy successful - chips added to your stack');
            setShowRebuyModal(false);
          } catch (err: any) {
            toast?.error(err.message || 'Rebuy failed');
          } finally {
            setRebuyProcessing(false);
          }
        }}
        onCloseRebuyModal={() => setShowRebuyModal(false)}
        // Tournament Break
        tournamentBreak={tournamentBreak}
        // Announcement
        announcement={announcement}
        onDismissAnnouncement={() => setAnnouncement(null)}
        // Tournament Winner
        tournamentWinner={tournamentWinner}
        onDismissTournamentWinner={() => setTournamentWinner(null)}
        // Hand History
        showHandHistory={showHandHistory}
        handHistory={handHistory}
        onCloseHandHistory={() => setShowHandHistory(false)}
        // Session Summary props removed (Phase 2 2026-08-22): the in-table
        // modal was dead — SessionSummaryHost at the app root owns the card.
        // Session HUD
        showSessionHUD={showSessionHUD}
        onCloseSessionHUD={() => setShowSessionHUD(false)}
        // Helpers
        safeBB={safeBB}
        getPlayerHUDStats={getPlayerHUDStats}
      />
    </div>
  );
}
