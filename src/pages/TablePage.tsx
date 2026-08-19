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
import { TABLE_SKINS, TABLE_BACKGROUNDS } from '../assets/tableAssets';
import { publishSessionSummary } from '../services/pendingSessionSummary';
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

/** Resolve a stored table/theme id to a skin asset; default stays green. */
function resolveSkin(tid: string): string {
  return TABLE_SKINS[tid] || TABLE_SKINS.classic_green;
}

// Dan 2026-08-18 — INTERCHANGEABLE DESIGNED BACKGROUNDS.
// The blurred-skin backdrop is gone ("remove the weird images around the
// table"). The page behind the table is now one of ten standalone designed
// backgrounds, selected on the Theme modal's Background tab and stored in
// user_theme_settings.background_id. Legacy ids alias to the closest design.

function resolveBackground(bid: string): string {
  return TABLE_BACKGROUNDS[bid] || TABLE_BACKGROUNDS.midnight;
}
import smarterPokerLetterLogo from '../assets/smarter-poker-letter-logo.png';
import { useTableWebSocket } from '../services/TableWebSocket';
import { supabase, getAuthUser } from '../lib/supabase';
// Phase 1.1 PR-3: authoritative engine WS state. Mounted always; becomes the
// source of truth for game-state fields when VITE_USE_ENGINE_WS=1. The old
// Supabase Realtime game-state path stays wired in parallel until PR-5 deletes
// it, so flipping the flag is a pure rollout switch.
import { useEngineTableState } from '../hooks/useEngineTableState';
import { mapEngineSnapshot } from '../utils/mapEngineSnapshot';
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
import TipDealer from '../components/table/TipDealer';
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
import { betChipFactor, chipCollectFactor } from '../components/table/tableGeometry';
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
import RebuyModal from '../components/table/RebuyModal';
import TournamentWinnerOverlay from '../components/table/TournamentWinnerOverlay';
// RealtimeChannelService imported if needed for future use
import ChipStack from '../components/table/ChipStack';
import { tournamentService } from '../services/TournamentService';
import TimerBar from '../components/table/TimerBar';
import PremiumCard from '../components/table/PremiumCard';
import RealTimeResults from '../components/table/RealTimeResults';
import PlayerCard from '../components/table/PlayerCard';
// [MIGRATION] All engine imports removed — server-authoritative (Steps 1-7 complete)
import { handPersistenceService } from '../services/HandPersistenceService';
import { handHistoryService } from '../services/HandHistoryService';
// Dan 2026-08-15: the real rake schedule (byte-identical mirror of the
// server's), used so the Game Rules modal states the rake actually taken.
import { getRakeConfig } from '../config/RakeConfig';
// Dan 2026-08-15: two distinct HandRecord shapes exist — the snake_case
// Supabase row from the service, and the camelCase view-model the panel
// renders. Alias both so adaptServiceHandToPanel below reads unambiguously.
import type { HandRecord as ServiceHandRecord } from '../services/HandHistoryService';
import type { HandRecord as PanelHandRecord } from '../components/table/HandHistoryPanel';
import { LeaderboardService } from '../services/LeaderboardService';
import { achievementTriggerService } from '../services/AchievementTriggerService';
import { notificationService } from '../services/NotificationService';
import SpectatorBadge from '../components/table/SpectatorBadge';
// FIX 194: HandStrengthIndicator REMOVED — not allowed for live online gameplay
// import HandStrengthIndicator from '../components/table/HandStrengthIndicator';
import SessionTimer from '../components/table/SessionTimer';
import { horseBugReporter } from '../services/HorseBugReporter';
import { useUserTableSettings } from '../hooks/useUserTableSettings';
import { useUserThemeSettings } from '../hooks/useUserThemeSettings';
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
import SessionSummary from '../components/table/SessionSummary';
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
import { HoleCardReveal } from '../components/tournament/HoleCardReveal';
import { playerStyleClassifier } from '../services/PlayerStyleClassifier';
// Phase 9: Previously unwired table components
import { StreamerMode } from '../components/table/StreamerMode';
import { SitOutToggle } from '../components/table/SitOutToggle';
import { BankrollWidget } from '../components/table/BankrollWidget';
import { HandReveal } from '../components/table/HandReveal';
import PositionStatsPopup from '../components/table/PositionStatsPopup';
import { SessionAnalytics } from '../components/table/SessionAnalytics';
import { SessionTrajectoryMini } from '../components/table/SessionTrajectoryMini';
import { StreakBadge } from '../components/table/StreakBadge';
import { SpinItWheel } from '../components/table/SpinItWheel';

import { useIsMounted } from '../hooks/useIsMounted';
import { useFrameBudgetMonitor } from '../hooks/useFrameBudgetMonitor';
// Bible V8 §11: 4-Corner Table HUD Components
import { TableHUD } from '../components/table/TableHUD';
import { MiniStatsCard } from '../components/table/MiniStatsCard';
import { PreviousHandCard } from '../components/table/PreviousHandCard';
import { reportError } from '../utils/errorReporter';
import { normalizeCards, seatPctToViewportPx } from '../utils/tableGeometry';
import { ActionErrorToast, ActionErrorData } from '../components/table/ActionErrorToast';
import { TableModalsLayer } from '../components/table/TableModalsLayer';

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CONFIG HELPER — Derives rake config from official chart
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE SUIT MAP — Shared constant eliminates 7 duplicate inline declarations
// ═══════════════════════════════════════════════════════════════════════════════
const ENGINE_SUIT_MAP: Record<string, 'h' | 'd' | 'c' | 's'> = {
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
};

// Bible V8 §11.1: cards_pre_sort — sort hole cards by rank (high → low)
const RANK_ORDER: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};
function sortCardsByRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => (RANK_ORDER[b.rank] ?? 0) - (RANK_ORDER[a.rank] ?? 0));
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME VARIANT LABEL HELPER
// ═══════════════════════════════════════════════════════════════════════════════

const GAME_VARIANT_LABELS: Record<string, string> = {
  NLH: "NO LIMIT HOLD'EM",
  nlh: "NO LIMIT HOLD'EM",
  PLO4: 'POT LIMIT OMAHA (4)',
  plo4: 'POT LIMIT OMAHA (4)',
  PLO5: 'POT LIMIT OMAHA (5)',
  plo5: 'POT LIMIT OMAHA (5)',
  PLO6: 'POT LIMIT OMAHA (6)',
  plo6: 'POT LIMIT OMAHA (6)',
  PLO8: 'PLO HI-LO (8+)',
  plo8: 'PLO HI-LO (8+)',
  SHORT_DECK: 'SHORT DECK 6+',
  short_deck: 'SHORT DECK 6+',
  FLH: "FIXED LIMIT HOLD'EM",
  flh: "FIXED LIMIT HOLD'EM",
  FLO: 'FIXED LIMIT OMAHA',
  flo: 'FIXED LIMIT OMAHA',
  MIXED: 'MIXED GAME',
  mixed: 'MIXED GAME',
};

function getGameVariantLabel(gameType: string): string {
  return GAME_VARIANT_LABELS[gameType] || gameType.toUpperCase().replace(/_/g, ' ');
}

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
  boardStage: BoardStage;
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
/**
 * Dan 2026-08-15 — HandRecord adapter (build fix).
 *
 * There are two unrelated `HandRecord` types: the snake_case row shape
 * returned by HandHistoryService (the Supabase `hand_history` projection) and
 * the camelCase view-model HandHistoryPanel renders. Commit ee1a310f5 wired
 * the panel to the service and passed one straight into the other, which does
 * not typecheck — main was red. This maps between them explicitly.
 *
 * Two fields genuinely have no source in the row and are marked rather than
 * faked: per-street pot totals (only the final pot is stored) and per-player
 * stack at time of hand. Everything the panel actually displays — players,
 * positions, hole cards, actions by street, winners, hero result — is real.
 */
function adaptServiceHandToPanel(h: ServiceHandRecord, heroId: string): PanelHandRecord {
  const cardStr = (c: { rank: string; suit: string }) =>
    `${c.rank}${(c.suit || '').charAt(0).toLowerCase()}`;

  const board = (h.community_cards || []).map(cardStr);
  // Board is dealt 3/1/1; slice it back into the streets that revealed it.
  const streetCards: Record<string, string[] | undefined> = {
    preflop: undefined,
    flop: board.slice(0, 3),
    turn: board.slice(3, 4),
    river: board.slice(4, 5),
  };

  const nameFor = (uid: string) =>
    (h.players || []).find((p) => p.user_id === uid)?.username || 'Player';

  const streets = (['preflop', 'flop', 'turn', 'river'] as const)
    .map((name) => ({
      name,
      cards: streetCards[name]?.length ? streetCards[name] : undefined,
      actions: (h.actions || [])
        .filter((a) => a.street === name)
        .map((a) => ({
          playerId: a.player_id,
          playerName: nameFor(a.player_id),
          // Service says 'all-in'; the panel's union says 'allin'.
          action: (a.action === 'all-in' ? 'allin' : a.action) as
            | 'fold'
            | 'check'
            | 'call'
            | 'bet'
            | 'raise'
            | 'allin',
          amount: a.amount,
        })),
      pot: 0, // not stored per street — only the final pot is persisted
    }))
    .filter((s) => s.actions.length > 0 || s.cards);

  const potTotal = (h.main_pot || 0) + (h.side_pots || []).reduce((a, b) => a + (b || 0), 0);

  return {
    id: h.id,
    handNumber: h.hand_number,
    timestamp: Date.parse(h.played_at) || Date.now(),
    gameType: h.game_type,
    blinds: h.stakes,
    players: (h.players || []).map((p) => ({
      id: p.user_id,
      name: p.username,
      seat: p.seat,
      stack: 0, // not stored per hand in hand_history
      position: p.position,
      holeCards: p.hole_cards?.length ? p.hole_cards.map(cardStr) : undefined,
    })),
    streets,
    winners: (h.players || [])
      .filter((p) => p.is_winner)
      .map((p) => ({
        playerId: p.user_id,
        playerName: p.username,
        amount: p.result,
        hand: p.final_hand,
      })),
    heroId,
    heroResult: (h.players || []).find((p) => p.user_id === heroId)?.result ?? 0,
    potTotal,
  };
}

/* Dan 2026-08-17 — RAIL-LOCKED SEAT RING.
   The skin composites share one canonical geometry (896x1200 frame, felt
   window x 20.3-79.6% / y 8.9-89.2%, rail ~7% of width thick). The scaler is
   aspect-locked to 605/1000 and shows the skin with object-fit:cover, which
   crops the frame to x [9.5%, 90.5%] — so in SCALER coordinates the rail
   band runs x ~10.5 / ~89.5 at the sides and y ~8.5 at the top cap (verified
   by overlaying this ring on the neon_city, mahogany_red and ice_cavern
   composites). Every seat below sits ON that band — villains and the + SIT
   buttons ride the rail, never the felt.
   Hero (slot 0) is the ONLY exception: bottom-center, nudged below the rail
   (Dan 2026-08-15: hero avatar is 1.33x and needs the vertical room). */
const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 93.5 }, // Seat 1 (Hero, bottom-center, hangs below the rail)
  { x: 10.5, y: 66 }, // Seat 2 (lower-left, on rail side)
  { x: 10.5, y: 33 }, // Seat 3 (upper-left, on rail side)
  { x: 50, y: 6 }, // Seat 4 (top-center; box rests ON the rail band - compact seat)
  { x: 89.5, y: 33 }, // Seat 5 (upper-right, on rail side)
  { x: 89.5, y: 66 }, // Seat 6 (lower-right, on rail side)
];

const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 93.5 }, // Seat 1 (Hero, bottom-center, hangs below the rail)
  { x: 19, y: 82.5 }, // Seat 2 (lower-left, bottom cap)
  { x: 10.5, y: 58 }, // Seat 3 (left-low, on rail side)
  { x: 10.5, y: 36 }, // Seat 4 (left-high, on rail side)
  { x: 27, y: 13 }, // Seat 5 (top-left, top cap)
  { x: 73, y: 13 }, // Seat 6 (top-right, top cap)
  { x: 89.5, y: 36 }, // Seat 7 (right-high, on rail side)
  { x: 89.5, y: 58 }, // Seat 8 (right-low, on rail side)
  { x: 81, y: 82.5 }, // Seat 9 (lower-right, bottom cap)
];

/* Dan 2026-08-17 — PER-SIZE SEAT RINGS.
   Production runs 2..9-max tables (audit: 53 seven-max plo6 + 472 eight-max
   tables live in the fleet), but the client only had 6MAX/9MAX rings picked
   by `maxPlayers === 9`. An 8-max table therefore indexed seats 7-8 past the
   end of the 6-seat array — no position at all. Every count now has its own
   ring on the SAME measured rail band (sides x 10.5/89.5, top cap y 8.5,
   top diagonals on the cap circle, bottom caps (19/81, 82.5)); hero is
   always slot 0, bottom-center. */
const SEAT_LAYOUTS: Record<number, Array<{ x: number; y: number }>> = {
  2: [
    { x: 50, y: 93.5 }, // Hero
    { x: 50, y: 6 }, // Villain, top-center (heads-up), box on the rail
  ],
  3: [
    { x: 50, y: 93.5 }, // Hero
    { x: 20.5, y: 14 }, // upper-left diagonal, on rail cap circle
    { x: 79.5, y: 14 }, // upper-right diagonal
  ],
  4: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 45 }, // left-middle
    { x: 50, y: 6 }, // top-center, box on the rail
    { x: 89.5, y: 45 }, // right-middle
  ],
  5: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 55 }, // left-low
    { x: 20.5, y: 14 }, // upper-left diagonal
    { x: 79.5, y: 14 }, // upper-right diagonal
    { x: 89.5, y: 55 }, // right-low
  ],
  6: SEAT_POSITIONS_6MAX,
  7: [
    { x: 50, y: 93.5 }, // Hero
    { x: 10.5, y: 62 }, // left-low
    { x: 10.5, y: 33 }, // left-high
    { x: 27, y: 13 }, // top-left diagonal
    { x: 73, y: 13 }, // top-right diagonal
    { x: 89.5, y: 33 }, // right-high
    { x: 89.5, y: 62 }, // right-low
  ],
  8: [
    { x: 50, y: 93.5 }, // Hero
    { x: 19, y: 82.5 }, // lower-left bottom cap
    { x: 10.5, y: 52 }, // left-low
    { x: 10.5, y: 28 }, // left-high
    { x: 50, y: 6 }, // top-center, box on the rail
    { x: 89.5, y: 28 }, // right-high
    { x: 89.5, y: 52 }, // right-low
    { x: 81, y: 82.5 }, // lower-right bottom cap
  ],
  9: SEAT_POSITIONS_9MAX,
};

/** Ring for a table size; clamps to [2, 9] so unknown sizes never crash. */
function seatLayoutFor(maxPlayers: number): Array<{ x: number; y: number }> {
  return SEAT_LAYOUTS[Math.min(9, Math.max(2, maxPlayers || 9))];
}

// HORSE AVATARS — Use deterministic SVG generator (no external DiceBear dependency)
// Each horse gets a unique colorful avatar derived from their name
import { generateAvatarSvg } from '../utils/avatarGenerator';

// Create empty player slots for a table
const createEmptySeats = (count: 6 | 9): (SeatPlayer | null)[] => {
  return Array(count).fill(null);
};

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW-LEVEL LOCKS — TRUE singletons that survive module reloads, lazy-load
// chunk duplication, and React component remounts. Using window.* guarantees
// only ONE game loop exists regardless of how many module instances load.
// ═══════════════════════════════════════════════════════════════════════════════
const _horsesLoadedForTable: Record<string, boolean> = {};
const _win = window as any;
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
    pot?: number;
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
}

export default function TablePage({
  embeddedTableId,
  onTableInfoUpdate,
  isMultiTable = false,
  isActive = true,
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
  const ambientSoundsAllowed = !isMultiTable || isActive;

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
  const [username, setUsername] = useState<string>('Player');
  const [heroAvatarUrl, setHeroAvatarUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [boardStageKey, setBoardStageKey] = useState(0); // Trigger board transitions

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
          .select('display_name, username, avatar_url')
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
    boardStage: 'preflop',
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
      return {
        ...prev,
        pot: mapped.pot,
        communityCards: mapped.communityCards as Card[],
        boardStage: mapped.boardStage as BoardStage,
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
        lastBetAmounts: mapped.lastBetAmounts,
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

  const [raiseAmount, setRaiseAmount] = useState(20);
  const [showRaiseSlider, setShowRaiseSlider] = useState(false);
  const [actionError, setActionError] = useState<ActionErrorData | null>(null);
  /** FIX 185: Bible V8 §4.15 — Added 'call' (auto_call) distinct from 'callAny' (auto_call_any) */
  const [preAction, setPreAction] = useState<'fold' | 'check' | 'call' | 'callAny' | null>(null);
  // P2-1 FIX: only send a server 'clear' if a pre-action was actually armed
  // before — prevents a junk serverSetPreAction(clear) firing on every mount
  // (preAction starts null).
  const hadPreActionRef = useRef(false);

  // Deal Animation State — triggers card dealing visual at start of new hand
  const [dealAnimationKey, setDealAnimationKey] = useState(0);
  const prevHandNumberForDealRef = useRef(0);
  // Per-seat deal animation — true for ~600ms after HAND_STARTED so SeatSlot
  // applies seat__cards--dealing class (card slide-in at each seat)
  const [isSeatDealing, setIsSeatDealing] = useState(false);

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
  const potCollectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards the diamond charge in handleBuyTimeBank against a double-tap. */
  const buyingTimeBankRef = useRef(false);
  /**
   * Real diamond price of one time-bank extension, read from `feature_pricing`
   * (the same row `fn_purchase_feature` prices from, so the button cannot
   * advertise a number the server will not charge). The TimeBank component
   * used to hard-code 5; the actual price is 1.
   */
  const [timeBankDiamondCost, setTimeBankDiamondCost] = useState(1);
  const [timeBankTimeRemaining, setTimeBankTimeRemaining] = useState(15);

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
            ? 'auto_fold'
            : preAction === 'check'
              ? 'auto_check'
              : preAction === 'call'
                ? 'auto_call' // FIX 185: Bible V8 §4.15 — auto_call (current bet only)
                : 'auto_call_any';
        // Tell server about pre-action so it can auto-execute on player's turn
        hadPreActionRef.current = true;
        serverSetPreAction(tableId, serverAction).catch((e) =>
          reportError(e, 'TablePage.Failed_to_set')
        );
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
        serverSetPreAction(tableId, 'clear').catch((e) =>
          reportError(e, 'TablePage.Failed_to_clear')
        );
      }
    }
  }, [preAction, tableId, userId]);

  // Bible V8 §6.3: Heartbeat every 5 seconds while at the table
  // Server uses this to detect disconnected players and trigger auto-fold/sit-out
  useEffect(() => {
    if (!tableId || !userId) return;
    // Send initial heartbeat immediately
    sendHeartbeat(tableId).catch(() => {});
    const heartbeatInterval = setInterval(() => {
      sendHeartbeat(tableId).catch((e) => reportError(e, 'TablePage.Failed'));
    }, 5000);
    return () => clearInterval(heartbeatInterval);
  }, [tableId, userId]);

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

  // Session tracking for end-of-session summary
  const [showSessionSummary, setShowSessionSummary] = useState(false);
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
  } = useTableSession();
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
  const vpipCountRef = useRef(0);
  // Dan 2026-08-15 (Session Stats fix): per-HAND voluntary-action flags.
  // vpipCountRef above is cumulative and cannot answer "did hero VPIP THIS
  // hand", which is what sessionStatsService.recordHand() needs. Set on the
  // hero's own preflop action, cleared when the hand number advances.
  const heroVpipThisHandRef = useRef(false);
  const heroPfrThisHandRef = useRef(false);
  const triggerChipAnimationRef = useRef<
    ((fromSeat: number, toPot: boolean, amount: number) => void) | null
  >(null);
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

  // ─── Table Menu Actions ────────────────────────────────────────────────
  useMasterBusSubscription('TABLE_MENU_ACTION', (event) => {
    if (event.tableId !== tableId) return;

    switch (event.action) {
      case 'SIT_OUT':
        setShowSitOut(true);
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
          if (['owner', 'admin', 'super_agent'].includes(role)) {
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
          if (unionRow?.owner_id === userId || ['owner', 'admin'].includes(unionRole)) {
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
  const [showInsurance, setShowInsurance] = useState(false);
  const [insuranceOffer, setInsuranceOffer] = useState<InsuranceOffer | null>(null);

  // Run It Twice state — FIX 96: 2-phase flow with chooser model
  const [showRIT, setShowRIT] = useState(false);
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
  }>({
    playerIds: [],
    handName: '',
    cardIndices: [],
    amounts: {},
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
      pot: tableState.pot,
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
    onTableInfoUpdate,
  ]);

  // Bad Beat Jackpot state
  const [showBBJ, setShowBBJ] = useState(false);
  const [bbjAmount, setBbjAmount] = useState(0);
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

  // Tip Dealer state
  const [showTipDealer, setShowTipDealer] = useState(false);

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
    };
  }, []);

  // Straddle state
  const [isStraddleEnabled, setIsStraddleEnabled] = useState(false);
  const [straddleAmount] = useState(4); // 2x big blind
  const [isStraddleAvailable] = useState(true); // Set based on position
  // Track whether straddle change originated from server (MasterBus) to avoid echo
  const straddleFromServerRef = useRef(false);

  // Bible V8 §4.4: Sync straddle toggle to server
  useEffect(() => {
    if (straddleFromServerRef.current) {
      straddleFromServerRef.current = false;
      return;
    }
    if (tableId) {
      serverToggleStraddle(tableId, isStraddleEnabled).catch((e) =>
        reportError(e, 'TablePage.Toggle_failed')
      );
    }
  }, [isStraddleEnabled, tableId]);

  // Handle dealer tip
  const handleTipDealer = async (amount: number) => {
    if (userId && tableId) {
      try {
        await WalletService.processDealerTip(userId, tableId, amount);
      } catch (error) {
        reportError(error, 'TablePage.Tip_processing_failed');
      }
    }
    setShowTipDealer(false);
  };

  // Cashier state
  const [showCashier, setShowCashier] = useState(false);
  const [showDiamondWallet, setShowDiamondWallet] = useState(false);
  const [accountBalance, setAccountBalance] = useState(0); // Player Wallet balance from wallets table
  // FIX 136: 2-hour re-entry restriction — minimum buy-in from recent cashout
  const [cashoutMinBuyIn, setCashoutMinBuyIn] = useState(0);

  // Handle cashier add chips (deducts from wallet, adds to table stack)
  const handleAddChips = async (amount: number) => {
    if (!userId || userId === 'guest' || !tableId) {
      reportError(
        new Error('Cannot add chips: not authenticated'),
        'TablePage.Cannot_add_chips_not_authenticated'
      );
      return;
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
        return;
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
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_add_chips');
      // Surface error to user — alert as fallback since toast not always available
      const msg = error instanceof Error ? error.message : 'Failed to add chips';
      if (typeof window !== 'undefined') toast.error(msg);
    }
  };

  // Handle cashier withdraw
  const handleWithdrawChips = async (amount: number) => {
    if (!userId || userId === 'guest' || !tableId) {
      reportError(
        new Error('Cannot withdraw: not authenticated'),
        'TablePage.Cannot_withdraw_not_authenticated'
      );
      return;
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
        return;
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
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_withdraw_chips');
      const msg = error instanceof Error ? error.message : 'Failed to withdraw chips';
      if (typeof window !== 'undefined') toast.error(msg);
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
    toast.error('Rabbit Hunt unavailable — no card data from server.');
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
    isAutoRebuyEnabled,
    setIsAutoRebuyEnabled,
    playTurnAlert,
  } = useTableSound();

  // All-in dramatic mode
  const [isAllInMode, setIsAllInMode] = useState(false);

  // FIX 89: All-in equity display — shows equity percentages for all all-in players
  // Populated by server's 'all_in_equity' Realtime event, visible to all players/observers
  const [allInEquities, setAllInEquities] = useState<
    Array<{ userId: string; username: string; equity: number; seat: number }>
  >([]);

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
    undefined // tournamentType resolved internally from gameType
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
  useEffect(() => {
    if (!showHandHistory || !userId || userId === 'guest') return;
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
  }, [showHandHistory, userId]);

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
      // Get tournament info to get rebuy cost and chips
      const tournament = await tournamentService.getTournament(tableState.tournamentId);
      if (tournament) {
        const rebuyChips = tournament.rebuy_chips || tournament.starting_chips;
        const rebuyCost = tournament.rebuy_cost || tournament.buy_in_amount;
        setRebuyData({ cost: rebuyCost, chips: rebuyChips });
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
      toast?.success('Add-on successful — chips added');
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
        console.debug(`[Leave] Success — ${result.chipsReturned} chips returned to wallet`);

        // Notify system (TABLE_LEFT is deliberately delayed until Session Summary closes)
        masterBus.emit('SESSION_ENDED', { tableId, userId });

        // Q3: Clear "Playing At" status when leaving table
        playerStatusService.clearPlayingAt(userId);

        // P/L = chips returned to wallet minus total chips invested at table
        sessionPLRef.current = (result.chipsReturned || 0) - totalBuyInRef.current;

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
        publishSessionSummary({
          duration: Math.floor((Date.now() - sessionStartRef.current) / 1000),
          handsPlayed: handsPlayedRef.current,
          handsWon: handsWonRef.current,
          totalRebuys: totalRebuysRef.current,
          profitLoss: sessionPLRef.current,
          biggestPot: biggestPotRef.current,
          peakStack: peakStackRef.current,
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
        navigate('/');

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
        console.warn('[Leave] leaveTable returned false — no active seat found for user', {
          tableId,
          userId,
          heroSeat: tableState.heroSeat,
        });
        setLeaveNotice("You're no longer seated at this table — nothing to leave.");
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
      if (showSessionSummary) {
        // Player already explicitly left and is viewing summary; just close the tab.
        masterBus.emit('TABLE_LEFT', { tableId, seat: tableState.heroSeat });
        return;
      }
      // Force cashout instantly without triggering the UI summary
      await tableService.leaveTable(tableId, tableState.heroSeat, userId);
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
    // Initial fetch + retry at 2s, then poll every 5s
    fetchExistingHand();
    retryTimer = setTimeout(fetchExistingHand, 2000);
    pollTimer = setInterval(fetchExistingHand, 5000);
    // Expose so HAND_STARTED can re-arm the fetch for the new hand.
    heroCardFetchRef.current = () => {
      if (!cancelled) {
        // New hand: re-arm recovery so the poll runs again for the new cards.
        heroCardsRecoveredRef.current = false;
        fetchExistingHand();
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
                title: '🃏 Bad Beat Jackpot Hit!',
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
          'id, name, game_variant, game_type, tournament_id, stakes, small_blind, big_blind, max_players, club_id, action_time_seconds'
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
            .then(({ data: clubData }) => {
              if (!clubData?.name) return;
              const rawUnion = (clubData as { unions?: { name?: string } | { name?: string }[] })
                .unions;
              const unionName = Array.isArray(rawUnion) ? rawUnion[0]?.name : rawUnion?.name;
              setTableState((prev) => ({
                ...prev,
                clubName: clubData.name,
                unionName: unionName || undefined,
              }));
            });
        }

        // ─── Load bounty data for KO/PKO tournaments ───
        if (table.tournament_id) {
          const { data: tournData } = await supabase
            .from('tournaments')
            .select(
              'is_bounty, is_pko, is_mystery_bounty, bounty_amount, spin_multiplier, blind_structure, current_level'
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
            }> | null;
            const currentLevel = (tournData.current_level as number) ?? 1;
            if (blindStructure && blindStructure.length > 0) {
              // Find the matching level (1-indexed) or fall back to first entry
              const levelEntry =
                blindStructure.find((bl) => bl.level === currentLevel) ||
                blindStructure[Math.min(currentLevel - 1, blindStructure.length - 1)];
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
        }

        // Subscribe to tournament break + add-on events via Realtime
        if (table.tournament_id) {
          const breakChanKey = `t-break-${table.tournament_id}`;

          if (!isMounted) return;
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
                      walBal = await WalletService.getPlayerBalance(userId);
                    }
                    setAddOnPeriod({
                      active: true,
                      addOnCost: addonData.addOnCost || 0,
                      addOnChips: addonData.addOnChips || 0,
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
                  toast?.info?.('Hand-for-hand play activated — bubble approaching');
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
                toast?.success?.('Bubble burst — you are in the money!');
              } else if (data?.type === 'player_eliminated') {
                // A player was eliminated from the tournament
                const elimData = data.payload || {};
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
                  if (elimData.position === 1) {
                    // Current user won the tournament
                    // BUG-G FIX: Use tableStateRef for fresh name (closure has 'Loading...')
                    const tournamentName = tableStateRef.current.tableName || 'Tournament';
                    setTournamentWinner({
                      prize: elimData.prize || 0,
                      name: tournamentName,
                    });
                  } else {
                    // Current user was eliminated (not winner)
                    const pos = elimData.position || '?';
                    const prize = elimData.prize || 0;
                    if (prize > 0) {
                      toast?.success?.(
                        `You finished ${pos}${pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'} and won ${prize}!`
                      );
                    } else {
                      toast?.info?.(
                        `You finished ${pos}${pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'}. Better luck next time!`
                      );
                    }
                    // Auto-redirect to results after 5 seconds
                    setTimeout(() => {
                      // BUG-G FIX: Use table.tournament_id (local var) — not stale closure
                      const tournId = table.tournament_id;
                      if (tournId) {
                        navigate(`/tournament-results?id=${tournId}`);
                      }
                    }, 5000);
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
                setAnnouncement({ type: data.type, data: b });
                try {
                  if (data.type === 'mystery_bounty_revealed') {
                    soundService.playMysteryBountyReveal();
                  } else {
                    soundService.playBountyCollected();
                  }
                } catch {
                  /* audio is best-effort */
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
                setTableState((prev) => ({
                  ...prev,
                  currentLevel: levelData.level,
                  blinds: levelData.blinds,
                }));
                setAnnouncement({ type: 'level_up', data: levelData });
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
          const balance = await WalletService.getPlayerBalance(userId);
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
            .select('id, username, display_name, avatar_url, is_horse, horse_profile')
            .in('id', userIds);

          const profileMap = new Map((profiles || []).map((p) => [p.id, p]));

          // BUG-09 FIX: Merged heroSeat update into same setTableState callback
          // (was previously calling setTableState inside setTableState which causes React warnings)
          // CRITICAL: Detect and clean up duplicate seats for the same user
          const heroSeats = existingSeats.filter((s) => s.user_id === userId);
          if (heroSeats.length > 1) {
            reportError('— cleaning up extras', 'TablePage.DUPLICATE_SEATS_DETECTED_for_user');
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
                    'has stack=0 — bust-rebuy flow will prompt rebuy or clean up on decline'
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
                  '— not in DB:',
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
          // Handle player joining
          break;
        case 'PLAYER_LEFT':
          // Handle player leaving
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
        WalletService.getPlayerBalance(userId)
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
      setActionErrorData({
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

    const seconds =
      payload.secondsGranted ?? payload.additionalSeconds ?? payload.secondsAdded ?? 15;

    // FIX 172: Play time bank activation sound (Bible V8 §5.3)
    // #175 gated for multi-table: only play on the active tab
    if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playTimeBankActivated();

    // For OPPONENTS: extend the visual timer from the WebSocket broadcast
    // For HERO: the local TimeBankEngine.activate() already extended the timer,
    // so only extend from server echoes (payload._fromServer) to avoid double-counting.
    // The local TimeBankEngine emit does NOT set _fromServer.
    if (payload.playerId !== userId) {
      // Opponent activated their time bank — extend our visual timer for their seat
      extendTimer(seconds);
    }

    // Update the Hero's specific localized UI if they are the one activating it
    if (payload.playerId === userId) {
      setTimeBankActive(true);
      setTimeBankTimeRemaining(seconds);
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
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    // Skip initial mount (isConnected starts false before first connect)
    if (prevConnectedRef.current === null) {
      prevConnectedRef.current = isConnected;
      return;
    }
    if (!isConnected && prevConnectedRef.current) {
      toast?.warning?.('Connection lost — reconnecting…');
      if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playDisconnect();
    } else if (isConnected && !prevConnectedRef.current) {
      toast?.success?.('Reconnected');
      if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playReconnect();
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected]);

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
            .select('id, username, display_name, avatar_url, is_horse, horse_profile')
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
                updatedPlayers[seatIdx] = {
                  ...existing,
                  stack: updated.stack,
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
                status: sp.is_folded
                  ? 'folded'
                  : sp.is_all_in
                    ? 'all_in'
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
        if (soundService.isEnabled() && ambientSoundsAllowed) {
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
        if (
          (action === 'bet' ||
            action === 'raise' ||
            action === 'call' ||
            action === 'all_in' ||
            action === 'allin') &&
          actionSeat > 0 &&
          actionAmount > 0
        ) {
          // Translate seat percentage → screen px using the rotated layout.
          // 2026-08-04 FIX: percentages are relative to the TABLE SCALER, not
          // the viewport — mapping them through window.innerWidth/Height threw
          // chips off the felt on desktop. Use the measured scaler rect.
          const seatPct = seatPositions[seatIdx] || { x: 50, y: 90 };
          const fromPos = seatPctToViewportPx(tableScalerRef.current, seatPct);
          const potPos = seatPctToViewportPx(tableScalerRef.current, { x: 50, y: 45 });
          const id = `pa_${Date.now()}_${seatIdx}_${Math.random().toString(36).slice(2, 6)}`;
          setChipAnimations((prev) => [
            ...prev,
            {
              id,
              from: fromPos,
              to: potPos,
              amount: actionAmount,
            },
          ]);
        }
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
          const players = prev.players.map((p) =>
            p && p.id === userId ? { ...p, holeCards: [], showCards: false } : p
          );
          return {
            ...prev,
            players,
            lastActions: prev.lastActions.map(() => null),
            lastBetAmounts: prev.lastBetAmounts.map(() => 0),
            communityCards: [],
            boardStage: 'preflop',
          };
        });
        // Re-fetch the hero's cards for the new hand (recovers a dropped insert).
        heroCardFetchRef.current?.();
        setTimeout(() => heroCardFetchRef.current?.(), 1500);
        // BUG 030 fix: clear prior hand's winner state IMMEDIATELY so the
        // "Three of a Kind" hand-strength label and winner banner cannot
        // bleed into the new hand if the table cycles faster than the 3s
        // HAND_COMPLETE cleanup timeout.
        setWinnerInfo({ playerIds: [], handName: '', cardIndices: [], amounts: {} });
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
        seatDealTimerRef.current = setTimeout(() => {
          seatDealTimerRef.current = null;
          setIsSeatDealing(false);
        }, 700);
        // Bible V8 §5.3: new hand indicator + card dealing sound
        // #175 gated for multi-table: only play on the active tab
        if (soundService.isEnabled() && ambientSoundsAllowed) {
          soundService.playNewHand();
          // Stagger the deal sound slightly after the new-hand chime
          setTimeout(() => soundService.playDeal(), 120);
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
          try {
            masterBus.emit('BOMB_POT_TRIGGERED', {
              tableId: tableId || '',
              anteAmount: Number(d?.ante_amount) || 0,
              // The engine has no double-board concept in its bomb-pot path;
              // report it honestly rather than implying a second board.
              doubleBoard: false,
              bbMultiplier: Number(d?.bb_multiplier) || 0,
            });
          } catch {
            /* bus publish is best-effort */
          }
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
        // 2026-08-04 FIX: scaler-relative percentages, not viewport (see PLAYER_ACTION)
        const potPos = seatPctToViewportPx(tableScalerRef.current, { x: 50, y: 45 });
        for (const p of postings) {
          if (p.seat > 0 && p.amount > 0) {
            const seatIdx = p.seat - 1;
            const seatPct = seatPositions[seatIdx] || { x: 50, y: 90 };
            const fromPos = seatPctToViewportPx(tableScalerRef.current, seatPct);
            const id = `blind_${Date.now()}_${seatIdx}_${Math.random().toString(36).slice(2, 6)}`;
            setChipAnimations((prev) => [
              ...prev,
              { id, from: fromPos, to: potPos, amount: p.amount },
            ]);
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
            // Bible V8 §5.3: turn alert sound for hero
            if (soundService.isEnabled()) soundService.playTurnAlert();
          }
        }
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
        const stage = ((evt.data as any).stage as string) || 'preflop';

        // Bible V8 §1.16 — chip-to-pot collection animation. Before updating
        // the board, sweep every non-zero bet off the felt into the pot with
        // the cpCollect keyframe (~450ms). After the animation, clear the
        // per-seat bet amounts so the next street starts with empty felt.
        const currentBets = tableStateRef.current.lastBetAmounts || [];
        const collectMask = currentBets.map((amt) => (amt || 0) > 0);
        const anyToCollect = collectMask.some(Boolean);

        if (anyToCollect) {
          setCollectingChipSeats(collectMask);
          if (collectSeatsTimerRef.current) {
            window.clearTimeout(collectSeatsTimerRef.current);
          }
          collectSeatsTimerRef.current = window.setTimeout(() => {
            setCollectingChipSeats(Array(collectMask.length).fill(false));
            setTableState((prev) => ({
              ...prev,
              lastBetAmounts: prev.lastBetAmounts.map(() => 0),
            }));
          }, 450);
        }

        setTableState((prev) => ({
          ...prev,
          communityCards: board,
          boardStage: stage as BoardStage,
        }));
        // Audio cue — Bible V8 §5.3: community card reveal sound (distinct from deal)
        // #175 gated for multi-table: only play on the active tab
        if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playCommunityCard();
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
              masterBus.emit('HAND_COMPLETED', {
                handId: String(tableStateRef.current.handNumber ?? hn),
                tableId: tableId || '',
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
        const finalBets = tableStateRef.current.lastBetAmounts || [];
        const finalMask = finalBets.map((amt) => (amt || 0) > 0);
        if (finalMask.some(Boolean)) {
          setCollectingChipSeats(finalMask);
          if (collectSeatsTimerRef.current) {
            window.clearTimeout(collectSeatsTimerRef.current);
          }
          collectSeatsTimerRef.current = window.setTimeout(() => {
            setCollectingChipSeats(Array(finalMask.length).fill(false));
            setTableState((prev) => ({
              ...prev,
              lastBetAmounts: prev.lastBetAmounts.map(() => 0),
            }));
          }, 450);
        }
        // Bible V8 §5.1 — winner display persists 2.5–3s before the table
        // resets to idle. Clear community board, pot, side pots and the
        // winner highlight after that delay so the next hand starts crisp.
        // CA-22: track so unmount can cancel — prevents setTableState on dead page
        if (handCompleteTimerRef.current) clearTimeout(handCompleteTimerRef.current);
        handCompleteTimerRef.current = window.setTimeout(() => {
          handCompleteTimerRef.current = null;
          setTableState((prev) => ({
            ...prev,
            communityCards: [],
            boardStage: 'preflop',
            pot: 0,
            sidePots: [],
          }));
          setIsAllInMode(false);
          setAllInEquities([]);
          setWinnerInfo({ playerIds: [], handName: '', cardIndices: [], amounts: {} });
          setWinnerParticle((prev) => ({ ...prev, active: false }));
        }, 3000);
        break;
      }

      case 'SHOWDOWN': {
        // This hand reached showdown → feeds the 'showdowns' daily challenge.
        heroHandOutcomeRef.current.showdown = true;
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
              // #175 gated for multi-table: only play on the active tab
              if (ambientSoundsAllowed) soundService.playBigWin();
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
          // Pot center in screen px (mirrors the constant 50,45 used by
          // chip-to-pot animations elsewhere).
          // 2026-08-04 FIX: scaler-relative percentages, not viewport. The old
          // window.innerWidth/Height math stranded pot-win chips at the screen
          // edges on desktop (split pots parked one chip on EACH edge).
          const potPos = seatPctToViewportPx(tableScalerRef.current, { x: 50, y: 45 });
          // Resolve each winner's seat from the current player list (rotated
          // positions already account for hero-at-bottom view).
          const sharePerWinner = potAmount / winnerIds.length;
          const events: ChipAnimationEvent[] = [];
          for (const wid of winnerIds) {
            // SeatPlayer.id is the userId — players[] index = seatNumber - 1.
            const seatIdx = tableStateRef.current.players.findIndex((p) => p?.id === wid);
            if (seatIdx < 0) continue;
            // AUDIT FIX 2026-07-19: physical-seat index — no +1 (see above).
            const seatPct = seatPositions[seatIdx] || { x: 50, y: 50 };
            const winnerPos = seatPctToViewportPx(tableScalerRef.current, seatPct);
            // createPotToWinnerEvent already returns a fan of 3-8 chips with
            // bezier arc, staggered 40ms each, 600ms duration — spec match.
            events.push(...createPotToWinnerEvent(potPos, winnerPos, sharePerWinner));
          }
          if (events.length > 0) {
            setChipAnimations((prev) => [...prev, ...events]);
            // Bible V8 §5.3: pot collect sweep sound — synced with chip animation
            // #175 gated for multi-table: only play on the active tab
            if (soundService.isEnabled() && ambientSoundsAllowed) soundService.playPotCollect();
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
              setPotCollectTo({
                dx: Math.round(winnerPx.x - potPos.x),
                dy: Math.round(winnerPx.y - potPos.y),
              });
              if (potCollectTimerRef.current) clearTimeout(potCollectTimerRef.current);
              // Slightly longer than --pd-collect-duration (0.5s) so the pot is
              // never yanked back to centre mid-slide.
              potCollectTimerRef.current = setTimeout(() => {
                potCollectTimerRef.current = null;
                setPotCollectTo(null);
              }, 700);
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
        if (soundService.isEnabled()) soundService.playBigWin();
        import('../services/HapticService').then(({ haptic }) => haptic.heavy());
        masterBus.emit('BBJ_HIT', evt.data as any);
        break;
      }
      case 'BBJ_PAYOUT_COMPLETE': {
        masterBus.emit('BBJ_PAYOUT_COMPLETE', evt.data as any);
        break;
      }
      case 'POT_DISTRIBUTED': {
        masterBus.emit('POT_DISTRIBUTED', evt.data as any);
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
  useEffect(() => {
    if (!presence) return;

    // Merge presence data with existing players (use callback to avoid stale state)
    setTableState((prev) => {
      const updatedPlayers = [...prev.players];
      let hasChanges = false;

      presence.players.forEach((p) => {
        if (p.seatNumber !== undefined) {
          const seatIdx = p.seatNumber - 1;
          if (seatIdx >= 0 && seatIdx < updatedPlayers.length) {
            const existing = updatedPlayers[seatIdx];
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // SEAT AUTO-ROTATION — Hero always appears at bottom-center (position 0)
  // ═══════════════════════════════════════════════════════════════════════════════
  // Maps physical seat numbers (1-indexed) to visual screen positions.
  // When the hero sits at seat N, all visual positions rotate so seat N
  // renders at the bottom-center slot. Other players shift accordingly,
  // preserving their relative seating order around the table.
  //
  // seatRotationMap[physicalSeatIndex] = { pos, visualIndex }
  // where pos is the screen {x,y} and visualIndex is the rotated slot.
  const seatRotationMap = useMemo(() => {
    const maxP = baseSeatPositions.length;
    const heroIdx = tableState.heroSeat > 0 ? tableState.heroSeat - 1 : 0; // 0-indexed
    return baseSeatPositions.map((_, physIdx) => {
      // Visual slot: rotate so hero's physical index maps to slot 0 (bottom-center)
      const visualIdx = (physIdx - heroIdx + maxP) % maxP;
      return { pos: baseSeatPositions[visualIdx], visualIndex: visualIdx };
    });
  }, [baseSeatPositions, tableState.heroSeat]);

  // Expose the flat positions array for legacy references (same length, rotated)
  // ═══════════════════════════════════════════════════════════════════════
  // Dan 2026-08-15 — THE GAME RULES MODAL WAS MISSTATING THE RAKE.
  //
  // TableModalsLayer renders `rakePercentage={rakePercent ?? 5}` and
  // `rakeCap={rakeCap ?? 3}`. Those props were fed from
  // `tableState.rakePercent` / `tableState.rakeCap` — fields that are DECLARED
  // on the state interface and passed through, but never assigned anywhere.
  // The engine snapshot carries no rake data at all (mapEngineSnapshot has
  // zero rake references), so both were permanently undefined and the modal
  // always fell through to its placeholders.
  //
  // Net effect: every player, at every stake, was told "Rake 5% (Cap $3)".
  // The server actually takes 10% with tier caps from $3 up to $15
  // (server/src/config/RakeConfig.ts RAKE_SCHEDULE). At 10/25 we displayed a
  // $3 cap against a real $15 one — a five-fold understatement of the rake.
  //
  // src/config/RakeConfig.ts already holds a byte-identical copy of the
  // server's RAKE_SCHEDULE and exports getRakeConfig(). Use it, so the number
  // shown to players is the number actually taken. A CI guard keeps the two
  // schedules from drifting (scripts/ci/check-rake-schedule-parity.mjs).
  //
  // Display only — all money movement remains server-authoritative.
  // ═══════════════════════════════════════════════════════════════════════
  const displayRakeConfig = useMemo(() => {
    const parts = (tableState.blinds || '').split('/');
    const sb = parseFloat(parts[0]);
    const bb = parseFloat(parts[1]);
    if (!Number.isFinite(bb) || bb <= 0) {
      // Blinds not loaded yet — send undefined rather than a wrong number, so
      // the modal shows its placeholder instead of asserting a false rake.
      return { rakePercent: undefined, rakeCap: undefined };
    }
    const cfg = getRakeConfig(bb, tableState.gameType || 'nlh', Number.isFinite(sb) ? sb : null);
    return { rakePercent: cfg.rakePercent, rakeCap: cfg.rakeCap };
  }, [tableState.blinds, tableState.gameType]);

  const seatPositions = useMemo(() => seatRotationMap.map((s) => s.pos), [seatRotationMap]);

  // ═══════════════════════════════════════════════════════════════════════
  // Dan 2026-08-15 — THROWABLE GEOMETRY (item 4).
  //
  // Throws used to be positioned by useTableAnimations.getSeatPositions(),
  // which invented a hardcoded 800x500 ellipse (centre 400,250 / radii
  // 300,150) that corresponds to nothing on screen. The real table is a
  // 341:609 PORTRAIT box, so the projectile launched and landed at arbitrary
  // points — never on the villain's avatar. Every other animation on this
  // table (dealer button, deal, chip flights) drives off `seatPositions`,
  // the hero-rotated percentage map that the seats themselves render from.
  //
  // Convert those same percentages into pixels RELATIVE TO .table-scaler and
  // mount the animation layer inside it. Scaler-relative rather than viewport
  // pixels on purpose: MultiTablePage puts a `transform` on its container, so
  // a position:fixed overlay would re-anchor to that transformed strip and
  // land the throw in the wrong tab. .table-scaler is position:relative, so an
  // absolutely-positioned child inside it shares exactly the seats' geometry
  // and follows the table through any resize or rescale.
  //
  // Keyed by 1-indexed seat number to match ThrowEvent.fromSeat/toSeat.
  // ═══════════════════════════════════════════════════════════════════════
  const throwSeatPositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    seatPositions.forEach((pct, physIdx) => {
      if (!pct) return;
      map.set(physIdx + 1, {
        x: (pct.x / 100) * scalerSize.w,
        y: (pct.y / 100) * scalerSize.h,
      });
    });
    return map;
  }, [seatPositions, scalerSize]);

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

  // Handle seat click (sit down at empty seat)
  const handleSeatClick = (seatNumber: number) => {
    // Validate seat is empty before showing buy-in modal
    const seatIdx = seatNumber - 1;
    if (seatIdx >= 0 && seatIdx < tableState.players.length && tableState.players[seatIdx]) {
      // Seat is occupied — ignore click
      console.debug('[Seat] Seat', seatNumber, 'is occupied — ignoring click');
      return;
    }
    // FIX 132: Don't allow sitting if already seated at this table
    // Check THREE sources: heroSeatRef (instant), heroSeat (state), and players array scan
    if (heroSeatRef.current > 0) {
      console.debug(
        '[Seat] Hero already seated (ref) at seat',
        heroSeatRef.current,
        '— ignoring click'
      );
      return;
    }
    if (tableState.heroSeat > 0) {
      console.debug('[Seat] Hero already seated at seat', tableState.heroSeat, '— ignoring click');
      return;
    }
    const existingHeroIdx = tableState.players.findIndex((p) => p && p.id === userId);
    if (existingHeroIdx >= 0) {
      console.debug(
        '[Seat] Hero found at seat',
        existingHeroIdx + 1,
        'via player scan — ignoring click'
      );
      return;
    }
    // Block if buy-in is already in progress (race condition guard)
    if (buyInProcessingRef.current) {
      console.debug('[Seat] Buy-in already processing — ignoring click');
      return;
    }
    // Block if buy-in modal already open
    if (showBuyInModal) {
      console.debug('[Seat] Buy-in modal already open — ignoring click');
      return;
    }
    if (pendingSeat !== null) {
      console.debug('[Seat] A seat reservation is already pending — ignoring click');
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
          setActionErrorData({
            error: res.error || 'Action rejected',
            code: res.code,
            hint: res.hint as ActionErrorData['hint'],
          });
          if (callsite) console.warn(`[Table] Server ${action} rejected (${callsite}):`, res);
          return false;
        }
        return true;
      } catch (err) {
        setActionErrorData({ error: 'Server unreachable' });
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

  const handleTimerAutoFold = useCallback(() => {
    if (actionLockRef.current) return; // Prevent race with manual fold
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
        GameServerAPI.activateTimeBank(tableId, userId).catch(() => {
          // Server rejected — fall back to auto-fold
          handleTimerAutoFold();
        });
      } else {
        handleTimerAutoFold();
      }
    },
    initialTime: actionTimeSeconds,
  });

  // Handle immediate UI Activation when button is clicked
  const handleActivateTimeBank = useCallback(() => {
    if (!tableId || !userId || timeBanksRemaining <= 0) return;
    // Server-authoritative: just send the request; server manages countdown
    setTimeBankActive(true);
    soundService.playChips();
    GameServerAPI.activateTimeBank(tableId, userId).catch((e) =>
      reportError(e, 'TablePage.activateTimeBank')
    );
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

  const handleBuyTimeBank = useCallback(async () => {
    if (!tableId || !userId || userId === 'guest') return;
    if (buyingTimeBankRef.current) return; // no double-charge on a double-tap
    buyingTimeBankRef.current = true;
    try {
      const { data, error } = await supabase.rpc('fn_purchase_feature', {
        p_user_id: userId,
        p_feature: 'time_bank_seconds',
      });
      if (error) throw error;
      const result = (data ?? {}) as { success?: boolean; error?: string; cost?: number };
      if (!result.success) {
        toast?.error?.(result.error || 'Could not buy a time bank');
        return;
      }
      setTimeBanksRemaining((n) => n + 1);
      const cost = result.cost ?? 0;
      toast?.success?.(
        cost > 0 ? `Time bank added (${cost} diamond${cost === 1 ? '' : 's'})` : 'Time bank added'
      );
    } catch (err) {
      reportError(err, 'TablePage.buyTimeBank');
      toast?.error?.('Could not buy a time bank');
    } finally {
      buyingTimeBankRef.current = false;
    }
  }, [tableId, userId]);

  //Validation moved to server — client does basic guard only
  const validateAndExecuteAction = (
    action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'bet',
    _amount?: number
  ) => {
    if (!tableId) {
      setActionErrorData({ error: 'Table not ready — reconnecting' });
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
      setActionErrorData({
        error: 'Your seat is out of sync with the table — resyncing',
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
    setShowRaiseSlider(false);
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
    const heroSeat = tableState.heroSeat;
    setShowRaiseSlider(false);
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
    const heroSeat = tableState.heroSeat;
    setShowRaiseSlider(false);
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

  const handleBet = () => {
    setShowRaiseSlider(true);
  };

  const handleRaise = () => {
    setShowRaiseSlider(true);
  };

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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isHeroTurnContext, handleFold, handleCheck, handleCall]);

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
        vpipCountRef.current++;
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
            soundService.playRaise(); // SoundService handles haptic (medium) per Bible V8 §5.4
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

  const handleConfirmRaise = async () => {
    const heroSeat = tableState.heroSeat;
    const hero = getPlayerAtSeat(heroSeat);
    const heroStack = hero?.stack || 0;

    // Clamp raise to hero's stack (can't bet more than you have)
    const clampedRaise = Math.min(raiseAmount, heroStack);
    if (clampedRaise <= 0) return;

    // Validate before executing
    if (actionLockRef.current) return;
    if (!validateAndExecuteAction('raise', clampedRaise)) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);

    // Close slider immediately
    setShowRaiseSlider(false);
    try {
      //Local engine call removed — server is authoritative
      soundService.playRaise(); // SoundService handles haptic (medium) per Bible V8 §5.4
      // BUG 026: optimistic update for instant visual feedback
      const revert = applyOptimisticHeroAction('raise', clampedRaise);
      if (tableId) {
        const ok = await submitActionWithToast(
          tableId,
          userId,
          'raise',
          clampedRaise,
          'confirmRaise'
        );
        if (!ok) revert();
      }
    } catch (err) {
      console.warn('[TablePage] Raise error:', err);
    }
  };

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
      showSessionSummary ||
      showHandHistory ||
      showPlayerNotes ||
      showWaitList ||
      showRaiseSlider ||
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
      setRaiseAmount(betAmount);
      setShowRaiseSlider(true);
    },
    onClosePanel: () => {
      // Escape key → close ALL open modals/overlays
      setIsChatCollapsed(true);
      setShowSettings(false);
      setIsReactionPickerOpen(false);
      setShowHandHistory(false);
      setShowPlayerNotes(false);
      setShowWaitList(false);
      setShowRaiseSlider(false);
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

  // Chip animation helpers
  const triggerChipAnimation = useCallback(
    (
      fromSeat: number,
      toPot: boolean,
      amount: number,
      chipColor: 'red' | 'green' | 'blue' | 'black' | 'gold' = 'gold'
    ) => {
      // Use rotated seat positions so chip animations align with visual seat layout
      const rotatedPositions = seatPositions; // Already rotated via seatRotationMap
      const fromPos = rotatedPositions[fromSeat] || { x: 50, y: 50 };
      const toPos = toPot ? { x: 50, y: 45 } : fromPos; // Pot is center of table

      const animId = `chip_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      setChipAnimations((prev) => [
        ...prev,
        {
          id: animId,
          from: {
            x: (fromPos.x / 100) * window.innerWidth,
            y: (fromPos.y / 100) * window.innerHeight,
          },
          to: { x: (toPos.x / 100) * window.innerWidth, y: (toPos.y / 100) * window.innerHeight },
          amount,
          chipColor,
        },
      ]);
    },
    [seatPositions]
  );

  // Keep ref in sync for use in closures that can't capture the callback directly
  triggerChipAnimationRef.current = triggerChipAnimation;

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
          const ts = parseInt(a.id.split('_')[1] || '0', 10);
          return ts > cutoff;
        });
        return fresh.length === prev.length ? prev : fresh;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load waitlist data
  const loadWaitlist = useCallback(async () => {
    if (!tableId) return;
    try {
      const entries = await waitlistService.getTableWaitlist(tableId);
      setWaitListPlayers(
        entries.map((e) => ({
          playerId: e.userId,
          playerName: `Player ${e.position}`, // Would come from profile join
          position: e.position,
          joinedAt: new Date(e.joinedAt),
        }))
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

  // Trigger board animation + sounds on stage transition
  const prevBoardStageRef = useRef<string>('preflop');
  useEffect(() => {
    setBoardStageKey((prev) => prev + 1);

    const prevStage = prevBoardStageRef.current;
    const newStage = tableState.boardStage;
    prevBoardStageRef.current = newStage;

    // Community card and showdown sounds are now triggered by discrete engine
    // events (COMMUNITY_CARDS_DEALT, SHOWDOWN) in the main event handler above.
    // No fallback sound here — avoids double-playing on transitions.
  }, [tableState.boardStage]);

  // Clear pre-action if game state changes significantly (new hand, someone raises after preaction set, etc)
  useEffect(() => {
    // Reset pre-actions when a new hand starts or board changes
    if (!tableState.isHandInProgress) {
      setPreAction(null);
    }
  }, [tableState.boardStage, tableState.isHandInProgress]);

  // Timer warning sound — tick when hero's time is running low
  useEffect(() => {
    const isHeroTurn =
      tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;
    if (isHeroTurn && actionTimeRemaining <= 5 && actionTimeRemaining > 0 && isSoundEnabled) {
      soundService.startTimerWarning();
    } else {
      soundService.stopTimerWarning();
    }
    return () => soundService.stopTimerWarning();
  }, [
    actionTimeRemaining,
    actionTimerProgress,
    tableState.currentPlayerSeat,
    tableState.heroSeat,
    tableState.isHandInProgress,
    isSoundEnabled,
  ]);

  return (
    <div
      className={`table-page${isAllInMode ? ' table-page--allin-mode' : ''}${tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress ? ' table-page--hero-turn' : ''}${winnerInfo.playerIds.length > 0 ? ' table-page--winner-flash' : ''}`}
      /* Dan 2026-08-18 — the page never shows the skin composite's scene:
         the table is .table-art inside the aspect-locked scaler, and the
         page behind it is a standalone designed background (style below). */
      data-felt-theme={v8Theme.table_id || v8Theme.theme_id || userSettings.theme || 'black'}
      data-background-theme={v8Theme.background_id || 'midnight'}
      data-button-theme={v8Theme.button_id || 'classic-white'}
      data-cards-theme={v8Theme.cards_id || 'standard-red'}
      data-theme-preset={v8Theme.theme_id || 'default-dark'}
      /* Dan 2026-08-18: 2 or 3 when the hand is run multiple times — CSS
         shifts the felt masthead down by one board height per extra run so
         the stacked boards never cover it. */
      data-boards={(ritResult?.boards?.length ?? 1) > 1 ? ritResult!.boards.length : undefined}
      style={{
        // Dan 2026-08-18: the blurred-skin backdrop is GONE ("remove the
        // weird images around the table"). The page shows one of the ten
        // designed, interchangeable backgrounds instead.
        backgroundImage: `url(${resolveBackground(v8Theme.background_id || 'midnight')})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
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
      {tableState.heroSeat > 0 && (
        <TimebankCounter
          count={timeBanksRemaining}
          low={timeBanksRemaining <= 1}
          onClick={() => setShowTimeBank(true)}
        />
      )}
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
            <span className="header-brand">smarter.poker</span>
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
                      onClick: () => setShowSitOut(true),
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
                    // Auto-Rebuy toggle (moved from QuickActionsBar to hamburger menu)
                    ...(!tableState.isTournament
                      ? [
                          {
                            id: 'auto-rebuy',
                            label: isAutoRebuyEnabled ? 'Auto-Rebuy: ON' : 'Auto-Rebuy: OFF',
                            icon: <RebuyIcon />,
                            onClick: () => {
                              const next = !isAutoRebuyEnabled;
                              setIsAutoRebuyEnabled(next);
                              try {
                                localStorage.setItem('ca_auto_rebuy', String(next));
                              } catch {
                                /* */
                              }
                            },
                          },
                        ]
                      : []),
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
              connectionStatus={isConnected ? 'connected' : 'disconnected'}
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
            <PreviousHandCard
              handNumber={prevHandResult?.handNumber ?? null}
              result={prevHandResult?.result ?? 0}
              didWin={prevHandResult?.didWin ?? false}
              didFold={prevHandResult?.didFold ?? false}
              handDescription={prevHandResult?.handDescription}
              onTap={() => setShowHandReplay(true)}
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
                    <span className="table-brand__line">
                      {/* Dan 2026-08-18: this was `new Date()` evaluated on every
                          render, so the felt always showed TODAY rather than the
                          day the hand was played — wrong on any replay or
                          screenshot, which is exactly where this masthead is
                          read. Now pinned to when this table session started. */}
                      {tableSessionDate.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                      {tableState.clubName && (
                        <>
                          {' \u00B7 '}
                          <span className="table-brand__club">
                            {tableState.clubName}
                            {/* Union name sits beside the club when the club is
                                attached to one (Dan 2026-08-18). */}
                            {tableState.unionName && (
                              <span className="table-brand__union">
                                {' \u2022 '}
                                {tableState.unionName}
                              </span>
                            )}
                          </span>
                        </>
                      )}
                      {' \u00B7 '}
                      {(tableState.gameType === "No Limit Hold'em"
                        ? 'NLH'
                        : tableState.gameType === 'Pot Limit Omaha'
                          ? 'PLO'
                          : tableState.gameType === "Fixed Limit Hold'em"
                            ? 'FLH'
                            : // Dan 2026-08-17 (audit): raw DB enums like
                              // OFC_PINEAPPLE printed verbatim on the felt.
                              // Known bug pattern 9: format enums for display.
                              (tableState.gameType || 'NLH').replace(/_/g, ' ')
                      ).toUpperCase()}{' '}
                      {tableState.blinds || '1/2'}
                    </span>
                    {(tableState.handNumber ?? 0) > 0 && (
                      <span className="table-brand__line table-brand__line--hand">
                        Hand #{tableState.handNumber}
                      </span>
                    )}
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
                <div className="community-area" key={`board-${boardStageKey}`}>
                  <CommunityCards
                    cards={tableState.communityCards}
                    stage={tableState.boardStage}
                    highlightedIndices={winnerInfo.cardIndices}
                    winningHandName={winnerInfo.handName}
                    deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                    cardBack={userSettings.cardBack}
                  />
                  {(ritResult?.boards?.length ?? 0) >= 2 &&
                    ritResult!.boards.slice(1).map((board, bi) => (
                      <div className="community-area__run" key={`run-${bi + 2}`}>
                        <span className="community-area__run-label">Run {bi + 2}</span>
                        <CommunityCards
                          cards={normalizeCards(board) as Card[]}
                          stage="river"
                          deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                          cardBack={userSettings.cardBack}
                        />
                      </div>
                    ))}
                </div>

                {/* Dan 2026-08-15: the "Game Info Strip" that lived here is
                    gone. It printed the stakes a second and third time
                    ("NLH 2.00/5.00", then "2/5 NLH" in yellow) right under the
                    masthead that already states them. Date, club and game now
                    appear once, on one centered line in .table-brand. */}

                {/* Spectator Badge + Overlay REMOVED from table surface.
                    Observer count belongs inside the chat panel, not on the felt.
                    SpectatorBadge and SpectatorOverlay components still exist for
                    future integration into the chat panel. */}

                {/* Spin Multiplier Badge */}
                {tableState.isTournament &&
                  tableState.spinMultiplier &&
                  tableState.spinMultiplier > 1 && (
                    <div
                      className={`spinMultiplierBadge ${tableState.spinMultiplier >= 100 ? 'premium' : ''}`}
                    >
                      <span className="spinMultiplierIcon">x</span>
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
              activeSeats={tableState.players
                .map((p, i) => (p && p.status !== 'folded' && p.status !== 'sitting_out' ? i : -1))
                .filter((i) => i >= 0)}
              dealerSeatIndex={Math.max(0, tableState.dealerSeat - 1)}
              seatPositions={seatPositions}
              onComplete={() => setDealAnimationKey(0)}
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

          {/* Pot Display — click to toggle chips/BB */}
          <div className="pot-area">
            <PotDisplay
              mainPot={tableState.pot}
              sidePots={tableState.sidePots}
              bigBlind={safeBB(tableState.blinds, 0)}
              displayMode={v8Settings.show_stack_in_bb ? 'bb' : 'chips'}
              onToggleDisplayMode={() => toggleV8Setting('show_stack_in_bb')}
              collectTo={potCollectTo}
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
                totalTime={actionTimeSeconds}
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

            // Compute bet-chip offset toward table center (50%, 50%).
            // Mockup v3 spec: bet/call/raise chip rests ~22% of the way from the
            // seat toward center — CLOSE to the player, not near the middle.
            // Convert the percent delta into scaler-space px (scaler ~300x462).
            //
            // Dan 2026-08-19, bug list item 8: "chips must always be in front of
            // the user (in front of the button if they're the button)." The
            // dealer button travels 0.28 of the way toward centre horizontally
            // while the chips travelled a flat 0.22, so on the side seats the
            // BUTTON stood further out on the felt than the chips it was
            // supposed to stand behind. The seat holding the button now steps
            // its chips PAST it — see betChipFactor() in tableGeometry.
            const dx = 50 - pos.x;
            const dy = 50 - pos.y;
            // pos.x/pos.y are percentages of the scaler, so one percent equals
            // scalerSize.w / 100 px horizontally and .h / 100 px vertically.
            const isDealerSeat = idx === dealerVisualIndex;
            const betTravel = betChipFactor(isDealerSeat);
            const betOffsetX = Math.round((dx * scalerSize.w * betTravel.x) / 100);
            const betOffsetY = Math.round((dy * scalerSize.h * betTravel.y) / 100);
            // Bible V8 §1.16 — on collect, bet chips fly from their resting
            // spot the rest of the way toward the pot.
            //
            // AUDIT 2026-08-19: this was `betOffset * 2`, which puts the
            // ENDPOINT at 3x the bet factor because the chip already sits one
            // bet-offset from its seat and the keyframe translates it by a
            // FURTHER --collect-dx. That landed at 0.66 only because every seat
            // shared the same 0.22 factor. Moving the dealer seat's chips out
            // to 0.38 (item 8) turned the same multiply into 3 x 0.38 = 1.14 —
            // past the centre of the table and out the other side. The collect
            // offset is derived from the bet offset now, so the endpoint is the
            // same for every seat and the ordinary case is unchanged.
            const collectTravel = chipCollectFactor(isDealerSeat);
            const collectDx = Math.round((dx * scalerSize.w * collectTravel.x) / 100);
            const collectDy = Math.round((dy * scalerSize.h * collectTravel.y) / 100);

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
                  isTournament={tableState.isTournament}
                  bountyValue={
                    tableState.isBountyTournament && player
                      ? tableState.bountyMap[player.id]
                      : undefined
                  }
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
                  cardBack={userSettings.cardBack}
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
                    !tableState.players.some((pl) => pl && pl.id === userId)
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
                />

                {/* FIX 89: All-In Equity Overlay — shown per seat during all-in */}
                {allInEquities.length > 0 &&
                  player &&
                  (() => {
                    const eq = allInEquities.find(
                      (e) => e.seat === seatNumber || e.userId === player.id
                    );
                    if (!eq) return null;
                    const isAhead = eq.equity >= 50;
                    return (
                      <div
                        className={`equity-overlay ${isAhead ? 'equity-overlay--ahead' : 'equity-overlay--behind'}`}
                        style={{
                          position: 'absolute',
                          bottom: '-18px',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          fontSize: '12px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '10px',
                          backgroundColor: isAhead
                            ? 'rgba(46, 204, 113, 0.9)'
                            : 'rgba(231, 76, 60, 0.9)',
                          color: '#fff',
                          whiteSpace: 'nowrap',
                          zIndex: 50,
                          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                        }}
                      >
                        {eq.equity}%
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
        ) : !tableState.isHandInProgress && !isRabbitAvailable ? (
          <div className="spectator-footer-bar" data-state="waiting">
            <span className="spectator-footer-bar__label">Waiting For Next Hand…</span>
          </div>
        ) : tableState.isHandInProgress &&
          (getPlayerAtSeat(tableState.heroSeat)?.status === 'folded' ||
            getPlayerAtSeat(tableState.heroSeat)?.status === 'away') ? (
          <div className="spectator-footer-bar" data-state="folded">
            <span className="spectator-footer-bar__label">Folded, Waiting For Next Hand…</span>
          </div>
        ) : (
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
                    <span className="control-strip__icon">⏱</span>
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
                  title="Rabbit Hunt — reveal remaining cards"
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
                        canAllIn={heroStack > 0}
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
                  onPreActionChange={setPreAction}
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
            <span className="post-bb-overlay-button__title">Post BB to Enter</span>
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
                setShowSitOut(true);
                setIsSideMenuOpen(false);
              }}
            >
              <span className="menu-item-icon">⏸</span>
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
              if (tableId) setSitOut(tableId, false).catch((e) => console.error(e));
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
          Confetti, Tip Dealer, Leave Notice, Cashier, Buy-In, Rabbit Hunt,
          Leaderboard, Session Summary, Tournament Screens — all modals/overlays.
          Extracted to TableModalsLayer to keep TablePage under control. */}
      <TableModalsLayer
        tableId={tableId}
        userId={userId}
        username={username}
        tableName={tableState.tableName}
        blinds={tableState.blinds}
        gameType={tableState.gameType}
        isTournament={tableState.isTournament}
        tournamentId={tableState.tournamentId}
        heroSeat={tableState.heroSeat}
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
        showTipDealer={showTipDealer}
        onTipDealer={handleTipDealer}
        onCloseTipDealer={() => setShowTipDealer(false)}
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
            setSitOutNextHand(settingsUpdate.sitOutNextHand);
            if (tableId)
              setSitOut(tableId, settingsUpdate.sitOutNextHand).catch((e) =>
                reportError(e, 'TablePage.Failed')
              );
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
        onAddOnAccept={async () => {
          if (!tableState.tournamentId || !userId || rebuyProcessing) return;
          setRebuyProcessing(true);
          try {
            await tournamentService.processAddOn(tableState.tournamentId, userId);
            toast?.success('Add-on accepted — chips added to your stack');
            setAddOnPeriod((prev) => ({ ...prev, active: false }));
          } catch (err: any) {
            toast?.error(err.message || 'Add-on failed');
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
            toast?.success('Rebuy successful — chips added to your stack');
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
        // Session Summary
        showSessionSummary={showSessionSummary}
        sessionStartTime={sessionStartRef.current}
        handsPlayed={handsPlayedRef.current}
        handsWon={handsWonRef.current}
        totalRebuys={totalRebuysRef.current}
        sessionPL={sessionPLRef.current}
        biggestPot={biggestPotRef.current}
        peakStack={peakStackRef.current}
        onCloseSessionSummary={() => setShowSessionSummary(false)}
        onResetSessionRefs={resetSession}
        // Session HUD
        showSessionHUD={showSessionHUD}
        onCloseSessionHUD={() => setShowSessionHUD(false)}
        // Helpers
        safeBB={safeBB}
        getPlayerHUDStats={getPlayerHUDStats}
        navigate={navigate}
      />
    </div>
  );
}
