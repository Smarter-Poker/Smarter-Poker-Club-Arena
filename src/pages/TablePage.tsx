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
import { useParams, useNavigate } from 'react-router-dom';
import { SeatSlot, PotDisplay, CommunityCards, DealerButton, DealAnimation } from '../components/table';
import type { SeatPlayer, Card, LastAction, PositionBadge } from '../components/table/SeatSlot';
import type { SidePot } from '../components/table/PotDisplay';
import type { BoardStage } from '../components/table/CommunityCards';
import { useTableWebSocket } from '../services/TableWebSocket';
import { supabase, subscribeToHandState, getAuthUser } from '../lib/supabase';
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
import { BBJService } from '../services/BBJService';
import RabbitHunt from '../components/table/RabbitHunt';
import LeaderboardPanel from '../components/table/LeaderboardPanel';
import HandNotation from '../components/table/HandNotation';
import { soundService, haptic } from '../services/SoundService';
import { ConfettiCanvas } from '../components/table/ConfettiCanvas';
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
import { GTOQueryService, type GTOSolution } from '../services/GTOQueryService';
import { RakeService, type RakeCalculation } from '../services/RakeService';
import { tableService } from '../services/TableService';
import { WalletService } from '../services/WalletService';
import ActionPanel from '../components/table/ActionPanel';
import PreActionBar from '../components/table/PreActionBar';
import ShareHand from '../components/table/ShareHand';
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
import { useTableStore } from '../stores/useTableStore';
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
import { achievementTriggerService } from '../services/AchievementTriggerService';
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

import { PremiumPot } from '../components/table/PremiumPot';
import { TablePerfMonitor } from '../components/table/TablePerfMonitor';
import { HoleCardReveal } from '../components/tournament/HoleCardReveal';
import { playerStyleClassifier } from '../services/PlayerStyleClassifier';
import { playerPositionStatsService } from '../services/PlayerPositionStatsService';
// Phase 9: Previously unwired table components
import { EmoteBroadcast } from '../components/table/EmoteBroadcast';
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

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CONFIG HELPER — Derives rake config from official chart
// ═══════════════════════════════════════════════════════════════════════════════

/** Official rake chart caps by blind level (mirrors RakeService.RAKE_CHART) */
function getRakeConfigForBlinds(
  sb: number,
  bb: number
): { percent: number; cap: number; noFlop: boolean } {
  // Official chart: 10% rake, tier-based cap, no flop no drop
  const CAPS: [number, number, number][] = [
    // [sb, bb, cap]
    [0.1, 0.2, 3],
    [0.2, 0.4, 3],
    [0.25, 0.5, 3],
    [0.3, 0.6, 5],
    [0.5, 1.0, 5],
    [1.0, 2.0, 5],
    [2.0, 4.0, 7.5],
    [2.0, 5.0, 7.5],
    [5.0, 5.0, 7.5],
    [3.0, 6.0, 8],
    [4.0, 8.0, 10],
    [5.0, 10.0, 12.5],
    [10.0, 20.0, 15],
    [10.0, 25.0, 15],
  ];
  const exact = CAPS.find(([s, b]) => s === sb && b === bb);
  if (exact) return { percent: 10, cap: exact[2], noFlop: true };
  // Fallback: closest by BB
  let closest = CAPS[0];
  let minDiff = Math.abs(bb - closest[1]);
  for (const tier of CAPS) {
    const diff = Math.abs(bb - tier[1]);
    if (diff < minDiff) {
      minDiff = diff;
      closest = tier;
    }
  }
  return { percent: 10, cap: closest[2], noFlop: true };
}

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
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
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
  OFC_PINEAPPLE: 'OFC PINEAPPLE',
  ofc_pineapple: 'OFC PINEAPPLE',
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
  gameType: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'SHORT_DECK' | 'OFC_PINEAPPLE' | string;
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
  // Phase 8: Action timer state
  actionTimerDeadline?: number;
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
// SEAT POSITIONS — Fixed percentages for vertical table layout (never move)
// ═══════════════════════════════════════════════════════════════════════════════

// Seat positions — premium-style tight oval hugging the felt edge
// Players positioned at the EDGE of the table — avatars/info sit OFF the felt
// Only action (chips, community cards, pot) on the actual table surface
// Seat positions — pushed OUTSIDE the felt edge so avatars/info boxes
// are off the table. Only chips and action labels on the felt surface.
const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 97 },   // Seat 1 (Hero — bottom center, pulled up slightly for card clearance)
  { x: 5,  y: 75 },   // Seat 2 (lower left)
  { x: 5,  y: 25 },   // Seat 3 (upper left)
  { x: 50, y: 3 },    // Seat 4 (top center)
  { x: 95, y: 25 },   // Seat 5 (upper right)
  { x: 95, y: 75 },   // Seat 6 (lower right)
];

const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 97 },   // Seat 1 (Hero — bottom center, pulled up slightly for card clearance)
  { x: 15, y: 90 },   // Seat 2 (bottom left)
  { x: 2,  y: 68 },   // Seat 3 (left middle-low)
  { x: 2,  y: 35 },   // Seat 4 (left middle-high)
  { x: 20, y: 5 },    // Seat 5 (top left)
  { x: 50, y: 0 },    // Seat 6 (top center)
  { x: 80, y: 5 },    // Seat 7 (top right)
  { x: 98, y: 35 },   // Seat 8 (right middle-high)
  { x: 98, y: 68 },   // Seat 9 (right middle-low)
];

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
    timeRemaining?: number;
    pot?: number;
  }) => void;
  /** Whether this table is part of a multi-table session (hides own header if tab bar is shown) */
  isMultiTable?: boolean;
}

export default function TablePage({
  embeddedTableId,
  onTableInfoUpdate,
  isMultiTable = false,
}: TablePageProps = {}) {
  const { tableId: routeTableId } = useParams<{ tableId: string; }>();
  const tableId = embeddedTableId || routeTableId;
  const navigate = useNavigate();
  const toast = useToast();

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
  const USE_ENGINE_WS = (
    import.meta as unknown as { env: Record<string, string | undefined> }
  ).env?.VITE_USE_ENGINE_WS === '1';
  const { snapshot: engineSnapshot, status: engineWsStatus } = useEngineTableState(
    tableId || undefined,
    { enabled: USE_ENGINE_WS }
  );

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
    setTableState((prev) => {
      // Merge per-seat players carefully: engine provides the full authoritative
      // roster. The SeatPlayer shape the UI wants matches mapped.players[i].
      const nextPlayers: (SeatPlayer | null)[] = mapped.players.map((p) =>
        p ? (p as unknown as SeatPlayer) : null
      );
      return {
        ...prev,
        pot: mapped.pot,
        communityCards: mapped.communityCards as Card[],
        boardStage: mapped.boardStage as BoardStage,
        dealerSeat: mapped.dealerSeat,
        currentPlayerSeat: mapped.currentPlayerSeat,
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
        actionTimerPlayerId: mapped.actionTimerPlayerId,
        isHandInProgress:
          mapped.boardStage !== 'waiting' &&
          (mapped.handNumber > 0 || mapped.players.some((p) => p !== null)),
      };
    });
  }, [engineSnapshot, USE_ENGINE_WS, userId, tableState.maxPlayers]);

  const [raiseAmount, setRaiseAmount] = useState(20);
  const [showRaiseSlider, setShowRaiseSlider] = useState(false);
  /** FIX 185: Bible V8 §4.15 — Added 'call' (auto_call) distinct from 'callAny' (auto_call_any) */
  const [preAction, setPreAction] = useState<'fold' | 'check' | 'call' | 'callAny' | null>(null);

  // Deal Animation State — triggers card dealing visual at start of new hand
  const [dealAnimationKey, setDealAnimationKey] = useState(0);
  const prevHandNumberForDealRef = useRef(0);

  // Time Bank State
  const [showTimeBank, setShowTimeBank] = useState(false);
  const [timeBankActive, setTimeBankActive] = useState(false);
  const [timeBanksRemaining, setTimeBanksRemaining] = useState(4);
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
              `You were auto-${data.timedOutAction === 'check' ? 'checked' : 'folded'} — no time banks remaining. Visit the Diamond Store to purchase more!`,
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
                ? 'auto_call'  // FIX 185: Bible V8 §4.15 — auto_call (current bet only)
                : 'auto_call_any';
        // Tell server about pre-action so it can auto-execute on player's turn
        serverSetPreAction(tableId, serverAction).catch((e) => reportError(e, 'TablePage.Failed_to_set'));
        // Also emit to MasterBus for local telemetry
        masterBus.emit('PRE_ACTION_SET', {
          tableId,
          playerId: userId || '',
          action: serverAction,
        });
      } else {
        // Clear pre-action on server
        serverSetPreAction(tableId, 'clear').catch((e) => reportError(e, 'TablePage.Failed_to_clear'));
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
  const [handRevealWinnerId, setHandRevealWinnerId] = useState('');
  const [handRevealWinnerName, setHandRevealWinnerName] = useState('');
  const [handRevealCards, setHandRevealCards] = useState<
    Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>
  >([]);
  const [handRevealHandId, setHandRevealHandId] = useState('');

  const [showSitOut, setShowSitOut] = useState(false);
  const [sitOutNextHand, setSitOutNextHand] = useState(false);
  const [sitOutTimeRemaining, setSitOutTimeRemaining] = useState(300); // 5 min default
  const [showWaitList, setShowWaitList] = useState(false);

  // Session tracking for end-of-session summary
  const [showSessionSummary, setShowSessionSummary] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showSessionHUD, setShowSessionHUD] = useState(false);
  const sessionStartRef = useRef(Date.now());
  const handsPlayedRef = useRef(0);
  const biggestPotRef = useRef(0);
  const peakStackRef = useRef(0);
  const sessionPLRef = useRef(0);
  const totalBuyInRef = useRef(0); // Track total chips invested for accurate session P/L
  const handsWonRef = useRef(0); // Session hands won by hero
  const heroWonCurrentHandRef = useRef(false); // Tracks if hero won current hand (cross-event ref)
  const hadShowdownRef = useRef(false); // Tracks if current hand reached showdown (cross-event ref)
  const totalRebuysRef = useRef(0); // Add-chips/rebuy count for session summary
  const actionLockRef = useRef(false); // Debounce rapid action button taps (300ms)

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

  // Actual club_id from the table record (NOT the tableId)
  const actualClubIdRef = useRef<string>('');
  const [actualClubIdLoaded, setActualClubIdLoaded] = useState(false); // Tracks when club_id is available
  const [actionTimeSeconds, setActionTimeSeconds] = useState(15);

  // Chat — extracted to useTableChat hook
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
  } = useTableChat(tableId, userId, tableState.players);

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
          const { data: unionMembership } = await supabase
            .from('union_members')
            .select('role')
            .eq('union_id', club.union_id)
            .eq('user_id', userId)
            .maybeSingle();

          if (unionMembership) {
            const unionRole = unionMembership.role?.toLowerCase() || '';
            if (['owner', 'admin'].includes(unionRole)) {
              setCanChatAsObserver(true);
              return;
            }
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
      timeRemaining: isHeroTurn ? 15 : undefined,
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
    onTableInfoUpdate,
  ]);

  // Bad Beat Jackpot state
  const [showBBJ, setShowBBJ] = useState(false);
  const [bbjAmount, setBbjAmount] = useState(0);

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
  } | null>(null);

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
    getSeatPositions,
    chipAnimations,
    setChipAnimations,
    showConfetti,
    setShowConfetti,
  } = useTableAnimations(tableId, userId, tableState.heroSeat);

  // Tip Dealer state
  const [showTipDealer, setShowTipDealer] = useState(false);

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
      serverToggleStraddle(tableId, isStraddleEnabled).catch((e) => reportError(e, 'TablePage.Toggle_failed'));
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
      reportError(new Error('Cannot add chips: not authenticated'), 'TablePage.Cannot_add_chips_not_authenticated');
      return;
    }
    try {
      await WalletService.lockForBuyIn(userId, tableId, amount);
      setAccountBalance((prev) => Math.max(0, prev - amount));
      totalBuyInRef.current += amount; // Track for session P/L
      totalRebuysRef.current += 1; // Track rebuy count for session summary
      // Update peak stack if rebuy pushes hero above previous peak
      const newPeakCandidate = (tableState.players[tableState.heroSeat - 1]?.stack || 0) + amount;
      if (newPeakCandidate > peakStackRef.current) peakStackRef.current = newPeakCandidate;
      // Send to authoritative engine memory (which also syncs back to DB safely)
      const res = await GameServerAPI.addChips(tableId, amount);
      if (!res.success) {
        console.error('[Cashier] GameServerAPI.addChips failed:', res.error);
        // We do not revert Wallet lock here since RPC deduct is locked. 
        // This is a rare edge case: money left wallet but table engine failed to ingest.
        // Needs a manual intervention/audit log.
      }

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
      reportError(new Error('Cannot withdraw: not authenticated'), 'TablePage.Cannot_withdraw_not_authenticated');
      return;
    }
    try {
      await WalletService.unlockFromTable(userId, tableId, amount);
      setAccountBalance((prev) => prev + amount); // BUG-08 FIX: Withdrawing FROM table adds TO wallet
      // Update hero's table stack in local state AND sync to DB
      setTableState((prev) => {
        const updatedPlayers = [...prev.players];
        const heroIdx = prev.heroSeat - 1;
        if (heroIdx >= 0 && updatedPlayers[heroIdx]) {
          updatedPlayers[heroIdx] = {
            ...updatedPlayers[heroIdx]!,
            stack: Math.max(0, updatedPlayers[heroIdx]!.stack - amount),
          };
        }
        return { ...prev, players: updatedPlayers };
      });
      // Sync stack to Supabase table_seats (with retry for resilience)
      // Compute the NEW stack directly — tableState hasn't updated yet (setState is async)
      const currentStack = tableState.players[tableState.heroSeat - 1]?.stack || 0;
      const newStack = Math.max(0, currentStack - amount);
      retryAsync(
        async () =>
          await supabase
            .from('table_seats')
            .update({ stack: newStack })
            .eq('table_id', tableId)
            .eq('seat_number', tableState.heroSeat)
            .is('left_at', null),
        2,
        500
      )
        .then((result: any) => {
          if (result?.error)
            console.warn('[Cashier] Withdraw chips stack sync failed:', result.error.message);
        })
        .catch((err: unknown) => {
          console.warn('[Cashier] Withdraw chips sync exhausted all retries:', err);
        });
      // Emit bus event so other pages know about the chip change
      masterBus.emit('CHIPS_WITHDRAWN', { tableId, userId, amount, newStack: newStack });
    } catch (error) {
      reportError(error, 'TablePage.Failed_to_withdraw_chips');
    }
  };

  // Load BBJ pool data
  useEffect(() => {
    const loadBBJPool = async () => {
      if (!tableId) return;

      try {
        // Get BBJ pool — fetch the actual club_id from the table record
        const { data: tableData } = await supabase
          .from('tables')
          .select('club_id')
          .eq('id', tableId)
          .maybeSingle();
        const actualClubId = tableData?.club_id || tableId;
        const pool = await BBJService.getPool({ clubId: actualClubId });
        if (pool && isMounted.current) {
          setBbjAmount(pool.main_balance);
        }
      } catch (error) {
        console.debug('Error loading BBJ pool:', error);
      }
    };

    loadBBJPool();
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

    // Fallback: generate random cards if server didn't provide
    // (edge case: stale state, reconnection, etc.)
    const suits: Array<'h' | 'd' | 'c' | 's'> = ['h', 'd', 'c', 's'];
    const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    const remainingCards: Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }> = [];
    const usedCards = new Set(currentBoard.map(c => `${c.rank}${c.suit}`));
    for (let i = 0; i < cardsNeeded; i++) {
      let card: { rank: string; suit: 'h' | 'd' | 'c' | 's' };
      do {
        card = {
          rank: ranks[Math.floor(Math.random() * ranks.length)],
          suit: suits[Math.floor(Math.random() * suits.length)],
        };
      } while (usedCards.has(`${card.rank}${card.suit}`));
      usedCards.add(`${card.rank}${card.suit}`);
      remainingCards.push(card);
    }
    setIsRabbitAvailable(false);
    return remainingCards;
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

  const [isSoundEnabled, setIsSoundEnabled] = useState(() => {
    try {
      return localStorage.getItem('ca_sound_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const [isVibrationEnabled, setIsVibrationEnabled] = useState(() => {
    try {
      return localStorage.getItem('ca_vibration_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const [isAutoRebuyEnabled, setIsAutoRebuyEnabled] = useState(() => {
    try {
      return localStorage.getItem('ca_auto_rebuy') === 'true';
    } catch {
      /* localStorage unavailable */ return false;
    }
  });

  // Play turn alert when it's hero's turn
  const playTurnAlert = () => {
    // NEW-BUG-1 FIX: use dynamic isEnabled() not stale isSoundEnabled closure
    if (soundService.isEnabled()) {
      soundService.playTurnAlert();
    }
  };

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

  // Bible V8 §11.1 + §10.3: skip_animations → override animation speed to instant (0)
  useEffect(() => {
    if (v8Settings.skip_animations) {
      document.documentElement.style.setProperty('--animation-speed', '0');
    }
    // Cleanup: restore normal animation speed if user toggles it off
    return () => {
      if (v8Settings.skip_animations) {
        document.documentElement.style.removeProperty('--animation-speed');
      }
    };
  }, [v8Settings.skip_animations]);

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
  // Per-street pot tracking — records pot at each stage transition for accurate hand history
  const streetPotsRef = useRef<Record<string, number>>({ preflop: 0, flop: 0, turn: 0, river: 0 });

  // Play win sound — escalates based on pot size
  const playWinSound = (potAmount?: number) => {
    // NEW-BUG-2 FIX: use dynamic isEnabled() not stale isSoundEnabled closure
    if (!soundService.isEnabled()) return;
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
  const [currentRake, setCurrentRake] = useState<RakeCalculation | null>(null);
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
  const handleLeaveTable = async () => {
    if (!tableId || !userId) return;
    setLeaveNotice(null);

    // Capture hero stack BEFORE leave (seat data may be cleared by leaveTable)
    const heroPlayer = tableState.players[tableState.heroSeat - 1];
    const stackAtLeave = heroPlayer?.stack || 0;

    try {
      const result = await tableService.leaveTable(tableId, tableState.heroSeat, userId);
      if (result.success) {
        // FIX 132: Clear heroSeatRef so player can re-seat at another table
        heroSeatRef.current = 0;
        console.debug(`[Leave] Success — ${result.chipsReturned} chips returned to wallet`);

        // Notify system (TABLE_LEFT is deliberately delayed until Session Summary closes)
        masterBus.emit('SESSION_ENDED', { tableId, userId });

        // Q3: Clear "Playing At" status when leaving table
        playerStatusService.clearPlayingAt(userId);

        // Show session summary instead of navigating immediately
        // P/L = chips returned to wallet minus total chips invested at table
        sessionPLRef.current = (result.chipsReturned || 0) - totalBuyInRef.current;
        setShowSessionSummary(true);
      } else {
        reportError(new Error('[Leave] Failed to leave table'), 'TablePage.Failed_to_leave_table');
        setLeaveNotice(
          'Unable to leave right now. You may be in an active hand — you will leave after it completes.'
        );
      }
    } catch (error) {
      reportError(error, 'TablePage.Exception');
      setLeaveNotice('Error leaving table. Please try again.');
    }
  };

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

  // 🛡️ SECURE HOLE CARD PROVISIONING RECEIVER (ANTI-GOD-MODE) 🛡️
  // Subscribes directly to Postgres RLS-protected table to bypass public WebSocket leak

  // Callback for handling new hole cards
  const handleHoleCardPayload = useCallback(
    (payload: any) => {
      const row = payload.new;
      if (row && row.user_id === userId && row.cards) {
        // Play deal sound if enabled
        if (soundService.isEnabled()) soundService.playDeal();

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
        .select('cards')
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;

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
            cardsApplied = true;
          }
          return cardsApplied ? { ...prev, players: updatedPlayers } : prev;
        });

        // Bug #7 fix: Stop polling once cards are successfully received
        if (cardsApplied || data.cards) {
          if (retryTimer) clearTimeout(retryTimer);
          if (pollTimer) clearInterval(pollTimer);
        }
      }
    };
    // Initial fetch + retry at 2s, then poll every 5s
    fetchExistingHand();
    retryTimer = setTimeout(fetchExistingHand, 2000);
    pollTimer = setInterval(fetchExistingHand, 5000);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [tableId, userId]);

  // Subscribe to server-side hand state broadcast (ServerTableEngine deals on the server)
  useEffect(() => {
    if (!tableId) return;
    const unsubscribe = subscribeToHandState(tableId, (handState: Record<string, unknown>) => {
      if (!handState) return;

      // ═══════════════════════════════════════════════════════════════════════
      // FIX 89: Dispatch server Realtime event types.
      // The server sends different event types on the same hand-state channel:
      // - Regular hand state: players, stage, community_cards, etc.
      // - insurance_offers: insurance offer data for InsuranceModal
      // - all_in_equity: equity percentages for all-in display
      // ═══════════════════════════════════════════════════════════════════════
      const eventType = handState.type as string | undefined;

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
        setRitOpponent(chooserId); // Will resolve to username via player list
        setRitTimer(10); // Others get 10 seconds
        setShowRIT(true);
        return;
      }

      // FIX 97: RIT result — display board results (future: animation)
      if (eventType === 'rit_result') {
        setShowRIT(false);
        // RIT boards and distribution can be displayed via a future component
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
              `You were auto-${timedOutAction === 'check' ? 'checked' : 'folded'} — no time banks remaining. Visit the Diamond Store to purchase more!`,
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
        setTimeout(() => {
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
          });

          // NOW trigger the HUD hit animation + full celebration overlay
          setShowBBJ(true);
          setShowBBJCelebration(true);

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

      // Rabbit Hunt: Server sends remaining deck cards after hand completes
      if (eventType === 'rabbit_hunt_available') {
        const rabbitCards = handState.rabbit_cards as any[] || [];
        if (rabbitCards.length > 0 && heroFoldedInCurrentHandRef.current) {
          // Convert server card format (hearts/diamonds/clubs/spades) to client shorthand (h/d/c/s)
          const suitMap: Record<string, 'h' | 'd' | 'c' | 's'> = {
            hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's',
            h: 'h', d: 'd', c: 'c', s: 's',
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

      const serverPlayers = (handState.players as any[]) || [];
      const stage = (handState.stage as string) || 'preflop';
      const communityCards = (handState.community_cards as any[]) || [];
      const pot = (handState.pot as number) || 0;
      const currentBet = (handState.current_bet as number) || 0;
      const currentPlayer = handState.current_player as string | null;
      const dealerSeat = (handState.dealer_seat as number) || 0;
      // Bible V8 §2.4: Extract betting state fields from server broadcast
      const serverMinRaise = (handState.min_raise as number) || 0;
      const serverLastRaise = (handState.last_raise as number) || 0;
      const serverPots = (handState.pots as any[]) || [];
      const serverActionHistory = (handState.action_history as any[]) || [];
      const handNumber = (handState.hand_number as number) || 0;

      // FIX 172: Play new-hand sound when hand number increases (Bible V8 §5.1)
      if (handNumber > 0 && soundService.isEnabled()) {
        if (handNumber > (tableStateRef.current.handNumber || 0)) {
          soundService.playNewHand();
        }
      }
      // Trigger deal animation on new hand — increment key to force re-trigger even if prev animation still playing
      if (handNumber > 0 && handNumber > prevHandNumberForDealRef.current) {
        prevHandNumberForDealRef.current = handNumber;
        setDealAnimationKey((k) => k + 1);
      }

      setTableState((prev) => {
        const updatedPlayers = [...prev.players];
        const isNewHand = handNumber > 0 && handNumber !== prev.handNumber;

        // FIX: ONE-SEAT-PER-USER — deduplicate server players BEFORE merging.
        // If the same user_id appears in multiple seats (engine bug or stale state),
        // only keep the FIRST occurrence. This prevents ghost multi-seat rendering.
        const seenUserIds = new Set<string>();
        const dedupedServerPlayers = serverPlayers.filter((sp: any) => {
          if (seenUserIds.has(sp.user_id)) {
            console.warn('[Broadcast] DUPLICATE user_id in broadcast — ignoring extra seat', sp.seat, 'for', sp.user_id);
            return false;
          }
          seenUserIds.add(sp.user_id);
          return true;
        });

        // Merge server player data with existing UI state
        for (const sp of dedupedServerPlayers) {
          const seatIdx = (sp.seat as number) - 1;
          if (seatIdx < 0 || seatIdx >= updatedPlayers.length) continue;

          // FIX: Before placing this user, remove them from any OTHER seat they occupy
          // (prevents same user appearing in multiple seats if seat changed)
          for (let j = 0; j < updatedPlayers.length; j++) {
            if (j !== seatIdx && updatedPlayers[j]?.id === sp.user_id) {
              console.debug('[Broadcast] Clearing stale seat', j + 1, 'for user', sp.user_id, '(now at seat', sp.seat, ')');
              updatedPlayers[j] = null as any;
            }
          }

          const existing = updatedPlayers[seatIdx];
          const isHero = sp.user_id === userId;

          // Card security: server scrubs hole cards in broadcast (sends []) except at showdown.
          // Hero gets cards via RLS-protected table_hole_cards channel.
          // At showdown, server sends actual cards for all players → use sp.cards.
          // FIX: On new hand, clear stale hero cards (they'll arrive fresh via secure channel).
          let resolvedCards: any[] = [];
          if (sp.cards && sp.cards.length > 0) {
            resolvedCards = sp.cards; // Server sent cards (showdown or initial deal for opponents)
          } else if (isNewHand) {
            resolvedCards = []; // New hand — clear stale cards, hero will get fresh ones via RLS
          } else {
            resolvedCards = existing?.holeCards || []; // Same hand — preserve existing cards
          }

          updatedPlayers[seatIdx] = {
            ...(existing || {}),
            id: sp.user_id,
            name: sp.username || existing?.name || `Seat ${sp.seat}`,
            stack: sp.stack,
            bet: sp.bet || 0,
            holeCards: resolvedCards,
            status: sp.is_folded
              ? 'folded'
              : sp.is_all_in
                ? 'all_in'
                : sp.is_sitting_out
                  ? 'sitting_out'
                  : sp.is_disconnected
                    ? 'disconnected'
                    : 'active',
            isHero,
            // Show cards for hero always; show opponent cards at showdown ONLY if not folded
            showCards: isHero || (sp.cards && sp.cards.length > 0 && !sp.is_folded),
          } as any;
        }

        // Clear seats that have no server player (engine is authoritative during active hands)
        const serverSeatNums = new Set(dedupedServerPlayers.map((sp: any) => sp.seat));
        for (let i = 0; i < updatedPlayers.length; i++) {
          if (updatedPlayers[i] && !serverSeatNums.has(i + 1)) {
            // Keep seat occupied from DB — don't clear non-playing spectator seats
          }
        }

        // Determine current player's seat index
        let currentPlayerSeat = 0;
        if (currentPlayer) {
          const cpSeat = serverPlayers.find((sp: any) => sp.user_id === currentPlayer);
          if (cpSeat) currentPlayerSeat = cpSeat.seat;
        }

        return {
          ...prev,
          players: updatedPlayers,
          pot,
          communityCards: communityCards.map((c: any) => {
            if (typeof c === 'string') {
              try {
                return JSON.parse(c);
              } catch {
                return c;
              }
            }
            return c;
          }),
          boardStage: stage as BoardStage,
          // Clear action labels on street change so they don't persist across streets
          lastActions: stage !== prev.boardStage
            ? Array(prev.lastActions.length).fill(null)
            : prev.lastActions,
          currentPlayerSeat,
          dealerSeat,
          isHandInProgress: stage !== 'preflop' || pot > 0,
          // Bible V8 §2.4: Server-authoritative betting state
          minRaise: serverMinRaise,
          lastRaise: serverLastRaise,
          currentBet,
          sidePots: serverPots,
          actionHistory: serverActionHistory,
          handNumber,
          // Sync lastBetAmounts from server broadcast player bets
          lastBetAmounts: (() => {
            const bets = [...prev.lastBetAmounts];
            for (const sp of serverPlayers) {
              const idx = (sp.seat as number) - 1;
              if (idx >= 0 && idx < bets.length) {
                bets[idx] = (sp.bet as number) || 0;
              }
            }
            return bets;
          })(),
          // Bible V8 §2.3: Sync position labels from server broadcast
          positions: (() => {
            const pos = [...prev.positions];
            for (const sp of serverPlayers) {
              const idx = (sp.seat as number) - 1;
              if (idx >= 0 && idx < pos.length) {
                const label = (sp.position as string) || '';
                // Map server BTN → D for dealer chip display
                if (label === 'BTN') pos[idx] = 'D';
                else if (
                  label === 'SB' ||
                  label === 'BB' ||
                  label === 'UTG' ||
                  label === 'MP' ||
                  label === 'CO' ||
                  label === 'HJ' ||
                  label.startsWith('UTG+') ||
                  label.startsWith('MP+')
                )
                  pos[idx] = label as any;
                else if (label) pos[idx] = label as any;
                else pos[idx] = null;
              }
            }
            return pos;
          })(),
        };
      });

      // ═══════════════════════════════════════════════════════════════════════
      // Rabbit Hunt: Track community cards for board state
      // ═══════════════════════════════════════════════════════════════════════
      if (communityCards.length > 0) {
        const suitMap: Record<string, 'h' | 'd' | 'c' | 's'> = {
          hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's',
          h: 'h', d: 'd', c: 'c', s: 's',
        };
        const boardForRabbit = communityCards.map((c: any) => {
          if (typeof c === 'string') {
            // Parse string format like "Ah" or "Td"
            return { rank: c.slice(0, -1), suit: (c.slice(-1) as 'h' | 'd' | 'c' | 's') };
          }
          return { rank: String(c.rank), suit: suitMap[c.suit] || c.suit };
        });
        setCurrentBoard(boardForRabbit);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Bible V8 §5.1 + §5.3: Winner detection — play win sound + set winner highlighting
      // Server broadcasts winner_ids[] when WINNERS event fires (stage = showdown).
      // ═══════════════════════════════════════════════════════════════════════
      const serverWinnerIds = (handState.winner_ids as string[]) || [];
      if (serverWinnerIds.length > 0) {
        // Check if hero won — play appropriate sound
        const heroWon = serverWinnerIds.includes(userId);
        if (heroWon) {
          playWinSound(pot);
        }
        // Set winner info for UI highlighting (community card indices, hand name)
        // Winner hand name comes from the evaluated hand at showdown
        const winnerPlayers = serverPlayers.filter((sp: any) =>
          serverWinnerIds.includes(sp.user_id)
        );
        const handName =
          winnerPlayers.length > 0 ? (winnerPlayers[0].hand_name as string) || '' : '';
        setWinnerInfo({
          playerIds: serverWinnerIds,
          handName,
          cardIndices: [], // Server can provide highlighted community card indices in future
          amounts: {},
        });

        // Bible V8 §5.1 + §10.2: Pot-to-winner chip animation
        // Fire chips from pot center to each winner's seat
        const potCenter = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.45 };
        const winnerShare = pot / Math.max(serverWinnerIds.length, 1);
        for (const winnerId of serverWinnerIds) {
          const winnerSeatIdx = serverPlayers.findIndex((sp: any) => sp.user_id === winnerId);
          if (winnerSeatIdx >= 0) {
            // seatPositions is 0-indexed array — use winnerSeatIdx directly
            const seatPos = seatPositions[winnerSeatIdx];
            if (seatPos) {
              const winnerPixelPos = {
                x: (seatPos.x / 100) * window.innerWidth,
                y: (seatPos.y / 100) * window.innerHeight,
              };
              const events = createPotToWinnerEvent(potCenter, winnerPixelPos, winnerShare);
              setChipAnimations((prev) => [...prev, ...events]);
            }
          }
        }

        // Clear winner highlighting after 4 seconds so it doesn't persist into next hand
        setTimeout(() => {
          setWinnerInfo({ playerIds: [], handName: '', cardIndices: [], amounts: {} });
        }, 4000);
      }

      // Detect all-in runout: if all non-folded players are all-in, enable dramatic mode
      const nonFolded = serverPlayers.filter((sp: any) => !sp.is_folded);
      const allInCount = nonFolded.filter((sp: any) => sp.is_all_in).length;
      if (nonFolded.length >= 2 && allInCount >= nonFolded.length - 1) {
        setIsAllInMode(true);
      }

      // --- NEW LOGIC: Hydrate the exact remaining time from the server payload ---
      const serverTurnStart = handState.turn_start_time_ms as number | undefined;
      const serverTurnDuration = handState.turn_duration_ms as number | undefined;
      const cpId = handState.current_player as string | null;

      if (cpId) {
        if (serverTurnStart && serverTurnDuration) {
          const elapsed = Date.now() - serverTurnStart;
          const remainingSeconds = Math.max(0, Math.ceil((serverTurnDuration - elapsed) / 1000));
          resetTimer(remainingSeconds);
        } else {
          // Fallback if the server didn't send precise timing
          resetTimer(actionTimeSeconds);
        }
      }
    });

    return () => unsubscribe();
  }, [tableId, userId]);

  const [showSettings, setShowSettings] = useState(false);
  const [showShareHand, setShowShareHand] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  const [showSessionStats, setShowSessionStats] = useState(false);
  const [sharedHandData, setSharedHandData] = useState<any>(null);
  
  // Real Name vs Alias
  const [useRealName, setUseRealName] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME) === 'true';
  });
  const [heroProfile, setHeroProfile] = useState<{username: string, display_name: string} | null>(null);

  // Sync settings when changed from other components (like TableMenu)
  useMasterBusSubscription('SETTINGS_CHANGED', (event: any) => {
    if (event.setting === 'useRealName') {
      setUseRealName(event.value);
    }
  });

  // Fetch Hero profile just once if needed
  useEffect(() => {
    if (userId && userId !== 'guest') {
      supabase.from('profiles').select('username, display_name').eq('id', userId).maybeSingle()
        .then(({data}) => {
          if (data) {
             setHeroProfile({ username: data.username || '', display_name: data.display_name || ''});
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

        // Fetch club name for table header display
        if (table.club_id) {
          supabase
            .from('clubs')
            .select('name')
            .eq('id', table.club_id)
            .maybeSingle()
            .then(({ data: clubData }) => {
              if (clubData?.name) {
                setTableState((prev) => ({ ...prev, clubName: clubData.name }));
              }
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
                  console.debug('[TablePage] ❌ Realtime channel error:', err?.message || err);
                }
                if (status === 'TIMED_OUT') {
                  console.debug('[TablePage] ⏱️ Realtime channel timed out');
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
                console.debug('[TablePage] ❌ Realtime channel error:', err?.message || err);
              }
              if (status === 'TIMED_OUT') {
                console.debug('[TablePage] ⏱️ Realtime channel timed out');
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
              ).then(({ error }) => {
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
            const updatedPlayers: (typeof prev.players[0] | null)[] = Array(prev.players.length).fill(null) as any;
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

              // Restore hero seat if this is the current user
              if (isHero) {
                resolvedHeroSeat = seat.seat_number;
              }
            }

            // Log any ghost seats that were cleared
            for (let i = 0; i < prev.players.length; i++) {
              if (prev.players[i] && !dbSeatNums.has(i + 1)) {
                console.debug('[Seat] Cleared ghost player from seat', i + 1, '— not in DB:', prev.players[i]?.id);
              }
            }

            // FIX 132: Set heroSeatRef immediately so duplicate-seat guard works
            if (resolvedHeroSeat > 0) {
              heroSeatRef.current = resolvedHeroSeat;
            } else {
              heroSeatRef.current = 0; // Hero not seated — ensure ref is clean
            }
            return { ...prev, players: updatedPlayers as typeof prev.players, heroSeat: resolvedHeroSeat };
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
    };
  }, [tableId, userId]);

  // Join/leave multiplayer room
  useEffect(() => {
    if (!tableId || !userId) return;

    // Join the room
    roomService.joinRoom(
      tableId,
      userId,
      tableState.players[tableState.heroSeat - 1]?.name || 'Player',
      tableState.heroSeat,
      tableState.players[tableState.heroSeat - 1]?.stack || 0
    );

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
          // Handle player action broadcast — Bible V8 §5.2 sequential animation
          const actionPayload = msg.payload as any;
          const action = (actionPayload?.action?.toLowerCase() || '') as string;
          const actionSeat = (actionPayload?.seat as number) || 0;
          const actionAmount = (actionPayload?.amount as number) || 0;
          const seatIdx = actionSeat - 1;

          // Step 1: Show action label immediately — persists until next action or new street
          if (seatIdx >= 0) {
            setTableState((prev) => {
              const newActions = [...prev.lastActions];
              newActions[seatIdx] = action as any;
              const newBets = [...prev.lastBetAmounts];
              if (actionAmount > 0) newBets[seatIdx] = actionAmount;
              return { ...prev, lastActions: newActions, lastBetAmounts: newBets };
            });
            // NO timeout — action label stays visible until replaced by next action
            // or cleared on new street/hand (handled in STAGE_CHANGE/NEW_HAND events)
          }

          // Step 2: Sound + chip animation after 200ms delay (Bible §5.2 sequence)
          setTimeout(() => {
            if (soundService.isEnabled()) {
              if (action === 'allin') {
                soundService.playAllIn();
              } else if (action === 'bet' || action === 'raise' || action === 'call') {
                soundService.playChips();
              } else if (action === 'check') {
                soundService.playCheck();
              } else if (action === 'fold') {
                soundService.playFold();
              }
            }
            // Chip animation for bet actions
            if (
              (action === 'bet' || action === 'raise' || action === 'call' || action === 'allin') &&
              actionSeat > 0
            ) {
              triggerChipAnimationRef.current?.(seatIdx, true, actionAmount);
            }
          }, 200); // 200ms after action label per Bible V8 §5.2

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
  }, [tableId, userId, tableState.heroSeat]);

  // ── Bus Listener: cross-tab live balance sync (Triple-Wallet sync) ──
  useMasterBusSubscription('BALANCE_UPDATED', (payload: any) => {
    if (!payload.userId || payload.userId === userId) {
      if (payload.balance !== undefined) {
        setAccountBalance(payload.balance);
      } else {
        WalletService.getPlayerBalance(userId).then(setAccountBalance).catch((e) => reportError(e, 'TablePage.balanceSync'));
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
    // Apply deck/theme preference if changed
    if (s.deckStyle) {
      localStorage.setItem(STORAGE_KEYS.DECK_STYLE, s.deckStyle);
    }
  });

  // ── Bus Listeners: Phase 8 — Action Rejection + Timer Events ──
  useMasterBusSubscription('ACTION_REJECTED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    if (payload.playerId === userId) {
      toast?.warning?.(`Action rejected: ${payload.reason || 'Invalid action'}`);
    }
  });

  useMasterBusSubscription('ACTION_TIMER_STARTED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    setTableState((prev) => ({
      ...prev,
      actionTimerDeadline: payload.deadline,
      actionTimerPlayerId: payload.playerId,
    }));
  });

  useMasterBusSubscription('ACTION_TIMER_EXPIRED', (payload: any) => {
    if (payload.tableId !== tableId) return;
    setTableState((prev) => ({
      ...prev,
      actionTimerDeadline: undefined,
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

  useMasterBusSubscription('PRE_ACTION_SET', (payload: any) => {
    if (payload.tableId !== tableId || payload.playerId !== userId) return;
    setPreAction(payload.action);
  });

  // FIX 89: INSURANCE_OFFERED is now server-authoritative via Realtime broadcast.
  // The subscribeToHandState callback handles 'insurance_offers' events.
  // Legacy MasterBus handler removed — server is the single source of truth.

  useMasterBusSubscription('TIME_BANK_ACTIVATED', (payload: any) => {
    if (payload.tableId !== tableId) return;

    const seconds =
      payload.secondsGranted ?? payload.additionalSeconds ?? payload.secondsAdded ?? 15;

    // FIX 172: Play time bank activation sound (Bible V8 §5.3)
    if (soundService.isEnabled()) soundService.playTimeBankActivated();

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
        ? `Time Bank Extended! (${payload.diamondsCharged} 💎)`
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
    } else if (isConnected && !prevConnectedRef.current) {
      toast?.success?.('Reconnected');
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
          if (soundService.isEnabled()) soundService.playSeatTaken();

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
                console.debug('[RealtimeSeats] Removing user', newSeat.user_id, 'from stale seat', j + 1, '(moving to', newSeat.seat_number, ')');
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
  const [displayHandNumber, setDisplayHandNumber] = useState<number | null>(null);

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

  // Handle incoming game events from WebSocket
  useEffect(() => {
    if (!lastEvent) return;

    switch (lastEvent.type) {
      case 'GAME_START': {
        // Fast UI recovery via GameServerAPI.getTableState() full snapshot
        const syncData = lastEvent.data as any;
        if (!syncData) break;
        
        setTableState((prev) => {
          const updatedPlayers = [...prev.players];
          const serverPlayers = syncData.players || [];
          
          serverPlayers.forEach((sp: any) => {
            const seatIdx = sp.seat - 1;
            if (seatIdx >= 0 && seatIdx < updatedPlayers.length) {
              const existing = updatedPlayers[seatIdx];
              updatedPlayers[seatIdx] = {
                ...(existing || {}),
                id: sp.user_id,
                name: sp.username || existing?.name || `Seat ${sp.seat}`,
                stack: sp.stack,
                bet: sp.bet || 0,
                holeCards: sp.user_id === userId || (sp.cards && sp.cards.length > 0 && !sp.is_folded) 
                  ? sp.cards || existing?.holeCards || [] 
                  : [],
                status: sp.is_folded ? 'folded' : (sp.is_all_in ? 'all_in' : (sp.is_sitting_out ? 'sitting_out' : 'active')),
                isHero: sp.user_id === userId,
                showCards: sp.cards && sp.cards.length > 0 && !sp.is_folded,
              } as any;
            }
          });
          
          return {
            ...prev,
            handNumber: syncData.hand_number,
            pot: syncData.pot || 0,
            communityCards: syncData.community_cards || [],
            stage: syncData.stage || 'idle',
            dealerSeat: syncData.dealer_seat || 0,
            players: updatedPlayers,
          };
        });
        break;
      }
      case 'DEAL_CARDS':
        // Update community cards
        if (lastEvent.data.communityCards) {
          setTableState((prev) => ({
            ...prev,
            communityCards: lastEvent.data.communityCards as Card[],
          }));
        }
        break;
      case 'PLAYER_ACTION':
        // Update pot, player stacks, etc.
        if (lastEvent.data.pot !== undefined) {
          setTableState((prev) => ({
            ...prev,
            pot: lastEvent.data.pot as number,
          }));
        }
        break;
      case 'POT_WIN': {
        // Bible V8 §5.1: Winner event — play sound + trigger chip-to-winner animation
        const winnerIds = (lastEvent.data.winner_ids as string[]) || [];
        const potAmount = (lastEvent.data.pot as number) || 0;
        if (winnerIds.length > 0 && winnerIds.includes(userId)) {
          playWinSound(potAmount);
        }
        break;
      }
      case 'HAND_COMPLETE':
        // Reset table state for next hand — but delay clearing community cards + winner info
        // so players can see the winning hand for 3 seconds before the next deal.
        // Bible V8 §5.1: Winner display persists 2.5-3s before table resets.
        setTimeout(() => {
          setTableState((prev) => ({
            ...prev,
            communityCards: [],
            boardStage: 'preflop',
            pot: 0,
            sidePots: [],
          }));
          setIsAllInMode(false);
          setAllInEquities([]); // Clear equity display on new hand
          // Clear winner highlighting
          setWinnerInfo({ playerIds: [], handName: '', cardIndices: [], amounts: {} });
        }, 3000);
        break;
    }
  }, [lastEvent]);

  // ═══════════════════════════════════════════════════════════════════════
  // Previous hand tracking — detects hand number change, captures result
  // for the bottom-left PreviousHandCard HUD widget
  // ═══════════════════════════════════════════════════════════════════════
  const prevHandNumberRef = useRef<number>(0);
  const prevHandStackRef = useRef<number>(0);
  const heroFoldedInCurrentHandRef = useRef(false);

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
      }
      prevHandNumberRef.current = handNum;
      prevHandStackRef.current = heroStack;
      heroFoldedInCurrentHandRef.current = false; // Reset for new hand
      // Rabbit Hunt: Reset for new hand
      setIsRabbitAvailable(false);
      serverRabbitCardsRef.current = [];
      setCurrentBoard([]);
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
                avatar: p.avatar || existing?.avatar || (p.userId === userId ? heroAvatarUrl : '') || '',
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
  const baseSeatPositions = tableState.maxPlayers === 9 ? SEAT_POSITIONS_9MAX : SEAT_POSITIONS_6MAX;

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
  const seatPositions = useMemo(() => seatRotationMap.map((s) => s.pos), [seatRotationMap]);

  // ── Dealer Button visual index (after hero rotation) ──
  // dealerSeat is 1-indexed physical seat. Convert to 0-indexed rotated visual index.
  const dealerVisualIndex = useMemo(() => {
    if (tableState.dealerSeat <= 0) return -1;
    const physIdx = tableState.dealerSeat - 1;
    const maxP = baseSeatPositions.length;
    const heroIdx = tableState.heroSeat > 0 ? tableState.heroSeat - 1 : 0;
    return (physIdx - heroIdx + maxP) % maxP;
  }, [tableState.dealerSeat, tableState.heroSeat, baseSeatPositions.length]);

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
    console.debug('[Seat] Opening buy-in modal for seat', seatNumber);
    setSelectedSeat(seatNumber);
    setShowBuyInModal(true);
    // Fire-and-forget: update presence (non-blocking — do NOT await)
    updateSeat(seatNumber).catch((e) => console.warn('[Seat] Presence update failed:', e));
  };

  //broadcastLocalHandState removed — server broadcasts state authoritatively

  // Unified Table Timer Logic (Phase M) - Moved out of the way of all earlier references
  const isHeroTurnContext =
    tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;

  const handleTimerAutoFold = useCallback(() => {
    if (actionLockRef.current) return; // Prevent race with manual fold
    // Bible V8 §1.4: Server is authoritative — only send HTTP action, no Realtime broadcast
    try {
      soundService.playFold();
      if (tableId)
        submitAction(tableId, userId || 'guest', 'fold').catch((e) =>
          console.warn('[Table] Server auto-fold failed:', e)
        );
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
    onTimeout: () => {
      // Server-authoritative: when client timer expires, try to activate time bank
      if (tableId && userId && timeBanksRemaining > 0) {
        setTimeBankActive(true);
        setShowTimeBank(true);
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
    GameServerAPI.activateTimeBank(tableId, userId).catch((e) => reportError(e, 'TablePage.activateTimeBank'));
  }, [tableId, userId, timeBanksRemaining]);

  // Handle buying a time bank extension (VIP quota or diamond purchase)
  const handleBuyTimeBank = useCallback(async () => {
    if (!tableId || !userId) return;
    // Server-authoritative: request time bank extension via API
    await GameServerAPI.activateTimeBank(tableId, userId);
  }, [tableId, userId]);

  //Validation moved to server — client does basic guard only
  const validateAndExecuteAction = (
    action: 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'bet',
    _amount?: number
  ) => {
    if (!tableId) return false;
    // Auto-allow fold
    if (action === 'fold') return true;
    // Basic client-side guard — real validation happens on server
    const heroSeat = tableState.heroSeat;
    const heroPlayer = tableState.players[heroSeat - 1];
    if (!heroPlayer || heroPlayer.status === 'folded') return false;
    return true;
  };

  const handleFold = async () => {
    if (actionLockRef.current) return;
    if (!validateAndExecuteAction('fold')) return;
    actionLockRef.current = true;
    setTimeout(() => {
      actionLockRef.current = false;
    }, 300);
    const heroSeat = tableState.heroSeat;
    setShowRaiseSlider(false);
    //Local engine call removed — server is authoritative
    soundService.playFold(); // SoundService handles haptic (light) per Bible V8 §5.4
    if (tableId)
      await submitAction(tableId, userId, 'fold').catch((e) =>
        console.warn('[Table] Server fold failed:', e)
      );
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
    if (tableId)
      await submitAction(tableId, userId, 'check').catch((e) =>
        console.warn('[Table] Server check failed:', e)
      );
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
    if (tableId)
      await submitAction(tableId, userId, 'call').catch((e) =>
        console.warn('[Table] Server call failed:', e)
      );
  };

  const handleBet = () => {
    setShowRaiseSlider(true);
  };

  const handleRaise = () => {
    setShowRaiseSlider(true);
  };

  // ── Keyboard Shortcuts for Table Actions ──
  // F = Fold | C = Check/Call | R = Raise/Bet | A = All-in
  // Only active when it's hero's turn, not typing in an input
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!isHeroTurnContext) return;
      if (actionLockRef.current) return;

      const key = e.key.toLowerCase();
      if (key === 'f') {
        e.preventDefault();
        handleFold();
      } else if (key === 'c') {
        e.preventDefault();
        // Determine if check is legal (no outstanding bet to match); otherwise call
        // Bible V8: Check is legal when currentBet <= hero's current bet
        const canCheck =
          (tableState.currentBet || 0) <=
          (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0);
        if (canCheck) {
          handleCheck();
        } else {
          handleCall();
        }
      } else if (key === 'r') {
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
      const heroSeat = tableState.heroSeat;
      const hero = getPlayerAtSeat(heroSeat);
      const heroStack = hero?.stack || 0;

      // Track VPIP: voluntary preflop action (call/raise/allin, NOT fold/check)
      if (
        tableState.boardStage === 'preflop' &&
        (action === 'call' || action === 'raise' || action === 'allin')
      ) {
        vpipCountRef.current++;
      }

      //All local engine calls removed — server is authoritative
      switch (action) {
        case 'fold':
          if (!validateAndExecuteAction('fold')) return;
          soundService.playFold(); // SoundService handles haptic per Bible V8 §5.4
          if (tableId)
            await submitAction(tableId, userId, 'fold').catch((e) =>
              console.warn('[Table] Server fold failed:', e)
            );
          break;
        case 'check':
          if (!validateAndExecuteAction('check')) return;
          soundService.playCheck();
          if (tableId)
            await submitAction(tableId, userId, 'check').catch((e) =>
              console.warn('[Table] Server check failed:', e)
            );
          break;
        case 'call':
          if (!validateAndExecuteAction('call')) return;
          soundService.playChips();
          if (tableId)
            await submitAction(tableId, userId, 'call').catch((e) =>
              console.warn('[Table] Server call failed:', e)
            );
          break;
        case 'raise':
          if (amount) {
            const clamped = Math.min(amount, heroStack);
            if (clamped <= 0) return;
            if (!validateAndExecuteAction('raise', clamped)) return;
            soundService.playRaise(); // SoundService handles haptic (medium) per Bible V8 §5.4
            if (tableId)
              await submitAction(tableId, userId, 'raise', clamped).catch((e) =>
                console.warn('[Table] Server raise failed:', e)
              );
          }
          break;
        case 'allin':
          if (heroStack <= 0) return;
          if (!validateAndExecuteAction('allin')) return;
          soundService.playAllIn(); // SoundService handles haptic (strong) per Bible V8 §5.4
          setIsAllInMode(true);
          if (tableId)
            await submitAction(tableId, userId, 'allin', heroStack).catch((e) =>
              console.warn('[Table] Server allin failed:', e)
            );
          break;
      }
    },
    [tableState.heroSeat, tableId, userId]
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
      if (tableId)
        await submitAction(tableId, userId, 'raise', clampedRaise).catch((e) =>
          console.warn('[Table] Server raise failed:', e)
        );
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
      if (tableId)
        await submitAction(tableId, userId, 'allin', heroStack).catch((e) =>
          console.warn('[Table] Server allin failed:', e)
        );
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
    onToggleSound: () => setIsSoundEnabled((prev) => !prev),
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

  // Pre-action execution — When it becomes player's turn, execute queued action
  useEffect(() => {
    if (
      tableState.currentPlayerSeat === tableState.heroSeat &&
      preAction &&
      tableState.isHandInProgress &&
      userId &&
      tableId
    ) {
      // Small delay to ensure state is updated
      const timer = setTimeout(async () => {
        try {
          if (preAction === 'fold') {
            await handleFold();
            masterBus.emit('PRE_ACTION_EXECUTED', {
              tableId: tableId!,
              playerId: userId!,
              action: 'fold',
              amount: 0,
            });
          } else if (preAction === 'check') {
            // Only check if can check (no bet to call)
            // Bible V8: Check legal when currentBet <= hero's current bet
            const heroBetForCheck = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
            const toCallForCheck = Math.max(0, (tableState.currentBet || 0) - heroBetForCheck);
            if (toCallForCheck === 0) {
              await handleCheck();
              masterBus.emit('PRE_ACTION_EXECUTED', {
                tableId: tableId!,
                playerId: userId!,
                action: 'check',
                amount: 0,
              });
            } else {
              masterBus.emit('PRE_ACTION_INVALIDATED', {
                tableId: tableId!,
                playerId: userId!,
                reason: 'bet_placed',
              });
            }
          } else if (preAction === 'call') {
            // FIX 185: Bible V8 §4.15 auto_call — call current bet only
            // If bet changed since pre-action was set, invalidate
            const heroBetForAutoCall = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
            const toCallForAutoCall = Math.max(0, (tableState.currentBet || 0) - heroBetForAutoCall);
            if (toCallForAutoCall > 0) {
              await handleCall();
              masterBus.emit('PRE_ACTION_EXECUTED', {
                tableId: tableId!,
                playerId: userId!,
                action: 'call',
                amount: toCallForAutoCall,
              });
            } else {
              // No bet to call — check instead
              await handleCheck();
              masterBus.emit('PRE_ACTION_EXECUTED', {
                tableId: tableId!,
                playerId: userId!,
                action: 'check',
                amount: 0,
              });
            }
          } else if (preAction === 'callAny') {
            // "Call Any" = stay in hand: if nothing to call, check instead
            // Bible V8: Derive call amount from server's currentBet vs hero's bet
            const heroBetForCall = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
            const toCallForCallAny = Math.max(0, (tableState.currentBet || 0) - heroBetForCall);
            if (toCallForCallAny > 0) {
              await handleCall();
            } else {
              await handleCheck();
            }
            masterBus.emit('PRE_ACTION_EXECUTED', {
              tableId: tableId!,
              playerId: userId!,
              action: toCallForCallAny > 0 ? 'call' : 'check',
              amount: 0,
            });
          }
          // Clear the pre-action after executing
          setPreAction(null);
        } catch (err) {
          reportError(err, 'TablePage.Error_executing_preaction');
          setPreAction(null);
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [
    tableState.currentPlayerSeat,
    tableState.heroSeat,
    preAction,
    tableState.isHandInProgress,
    userId,
    tableId,
  ]);

  // Trigger board animation + sounds on stage transition
  const prevBoardStageRef = useRef<string>('preflop');
  useEffect(() => {
    setBoardStageKey((prev) => prev + 1);

    const prevStage = prevBoardStageRef.current;
    const newStage = tableState.boardStage;
    prevBoardStageRef.current = newStage;

    // Play community card sound when new board cards are dealt
    if (soundService.isEnabled() && prevStage !== newStage) {
      if (newStage === 'flop' || newStage === 'turn' || newStage === 'river') {
        soundService.playCommunityCard();
      }
      // Play showdown sound when reaching showdown stage
      if (newStage === 'showdown') {
        soundService.playShowdown();
      }
    }
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
      data-felt-theme={v8Theme.table_id || v8Theme.theme_id || userSettings.theme || 'black'}
      data-background-theme={v8Theme.background_id || 'diamond-pattern'}
      data-button-theme={v8Theme.button_id || 'classic-white'}
      data-cards-theme={v8Theme.cards_id || 'standard-red'}
      data-theme-preset={v8Theme.theme_id || 'default-dark'}
    >
      <style>{`
                @keyframes boardSlideIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
                @keyframes boardFade { from { opacity: 0.7; } to { opacity: 1; } }
                .community-area { animation: boardFade 0.4s ease-out; }
                .board-transition { animation: boardSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
            `}</style>
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
              if (tableState.players[tableState.heroSeat - 1]) setShowBuyInModal(true);
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
            <span className="header-game-type">{tableState.gameType}</span>
            <span className="header-blinds">{tableState.blinds}</span>
          </div>
          <div className="header-center__bottom-row">
            <span className="header-brand">smarter.poker</span>
            {tableState.clubName && (
              <span className="header-club-name">{tableState.clubName}</span>
            )}
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
                            try { localStorage.setItem('ca_auto_rebuy', String(next)); } catch { /* */ }
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
          <button 
            className="add-chips-icon-btn" 
            style={{ marginTop: 12 }}
            onClick={() => {
              soundService.playButtonClick();
              if (tableState.players[tableState.heroSeat - 1]) setShowBuyInModal(true);
            }}
            title="Add Chips"
          >
            <svg width="24" height="24" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 6v6M6 9h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
          <div className="hud-ul-column" style={{ alignItems: 'flex-start' }}>
            <PreviousHandCard
              handNumber={prevHandResult?.handNumber ?? null}
              result={prevHandResult?.result ?? 0}
              didWin={prevHandResult?.didWin ?? false}
              didFold={prevHandResult?.didFold ?? false}
              handDescription={prevHandResult?.handDescription}
              onTap={() => setShowHandReplay(true)}
              onShareHand={() => setShowShareHand(true)}
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
        <div className="table-scaler">
          {/* Table Felt */}
          <div className="table-felt">
            <div className="table-rail">
              <div className="table-surface">
                {/* Hand Number Display — shown on table felt during active hands */}
                {displayHandNumber != null && (
                  <div className="hand-number-display">Hand #{displayHandNumber}</div>
                )}
                {/* Pot Display — click to toggle chips/BB */}
                <div className="pot-area">
                  <PotDisplay
                    mainPot={tableState.pot}
                    sidePots={tableState.sidePots}
                    bigBlind={safeBB(tableState.blinds, 0)}
                    displayMode={userSettings.showStackInBB ? 'bb' : 'chips'}
                    onToggleDisplayMode={() =>
                      updateSetting('showStackInBB', !userSettings.showStackInBB)
                    }
                  />
                  {/* Premium Pot — animated counter + tier glow overlay */}
                  <PremiumPot
                    mainPot={tableState.pot}
                    sidePots={tableState.sidePots.map((sp, i) => ({
                      id: `sp_${i}`,
                      amount: sp.amount,
                      eligible: sp.eligiblePlayers?.map(String) || [],
                    }))}
                    compact
                  />
                </div>

                {/* Community Cards */}
                <div className="community-area" key={`board-${boardStageKey}`}>
                  <CommunityCards
                    cards={tableState.communityCards}
                    stage={tableState.boardStage}
                    highlightedIndices={winnerInfo.cardIndices}
                    winningHandName={winnerInfo.handName}
                    deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                  />
                </div>

                {/* Game Info Strip — premium-style: "1/2 NLH" capitalized, table name below */}
                <div className="table-game-info">
                  <span className="table-game-info__stakes">
                    {(tableState.blinds || '1/2').toUpperCase()}{' '}
                    {(tableState.gameType === "No Limit Hold'em" ? 'NLH' :
                      tableState.gameType === "Pot Limit Omaha" ? 'PLO' :
                      tableState.gameType === "Fixed Limit Hold'em" ? 'FLH' :
                      tableState.gameType || 'NLH').toUpperCase()}
                  </span>
                  {tableState.tableName && (
                    <span className="table-game-info__name">{tableState.tableName.toUpperCase()}</span>
                  )}
                </div>

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
                      <span className="spinMultiplierIcon">🎰</span>
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

          {/* Deal Animation — card backs flying from dealer to players on new hand */}
          {dealAnimationKey > 0 && (
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

          {/* Player Seats */}
          {seatPositions.map((pos, idx) => {
            const seatNumber = idx + 1;
            const player = getPlayerAtSeat(seatNumber);
            
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
                derivedHeroName = heroProfile.display_name || heroProfile.username || derivedHeroName;
              }
            }
            const displayPlayer = player ? {
              ...player,
              name: derivedHeroName!
            } : null;

            // Compute bet-chip offset direction toward table center (50%, 50%)
            const dx = 50 - pos.x;
            const dy = 50 - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // Normalize and scale: chips appear ~70px toward center from the seat
            const betOffsetX = Math.round((dx / dist) * 70);
            const betOffsetY = Math.round((dy / dist) * 70);

            return (
              <div
                key={seatNumber}
                className="seat-wrapper"
                style={{
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                  '--bet-offset-x': `${betOffsetX}px`,
                  '--bet-offset-y': `${betOffsetY}px`,
                } as React.CSSProperties}
              >
                <SeatSlot
                  seatNumber={seatNumber}
                  player={displayPlayer}
                  position={tableState.positions[idx] || null}
                  isActive={seatNumber === tableState.currentPlayerSeat && v8Settings.highlight_active_players}
                  lastAction={tableState.lastActions[idx] || null}
                  lastBetAmount={tableState.lastBetAmounts[idx] || 0}
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
                  hudStats={player && !player.isHero ? getPlayerHUDStats(player.id) : null}
                  showHUD={userSettings.showHUD && !!player && !player.isHero}
                  deckStyle={userSettings.fourColorDeck ? '4color' : '2color'}
                  cardBack={userSettings.cardBack}
                  showStackInBB={userSettings.showStackInBB}
                  showAvatar={v8Settings.show_avatars}
                  showBadges={v8Settings.show_badges}
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
                  onAvatarClick={() => {
                    // Open throwable selector targeting this seat
                    setThrowTargetSeat(seatNumber);
                    setShowThrowableSelector(true);
                    // Also record clicked player for Player Notes targeting
                    if (player && !player.isHero) {
                      setSelectedPlayerForNotes({ id: player.id, name: player.name });
                    }
                  }}
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
        {/* Spectator Mode - hidden (seats already show "+ SIT") */}
        {!tableState.players[tableState.heroSeat - 1] ? (
          <>{/* No spectator banner — empty seats already invite players to sit */}</>
        ) : (
          <>
            {/* ─── CONTROL STRIP — Minimal: Time Bank + Timer during hand, Rabbit Hunt after hand ─── */}
            {tableState.isHandInProgress && tableState.currentPlayerSeat === tableState.heroSeat && (
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
                  <span className="control-strip__timer-val">{Math.ceil(actionTimeRemaining) || 0}s</span>
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
                  <span className="control-strip__icon">🐰</span>
                  <span className="control-strip__label">Rabbit Hunt</span>
                </button>
              </div>
            )}

            {/* ─── ACTION PANEL — Premium 3-button layout ─── */}
            {/* QuickActionsBar REMOVED — Auto-Rebuy is a hamburger menu setting,
                Chat and Stats have their own dedicated locations */}

            {tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress
              ? (() => {
                  // Bible V8 §1.4: Use SERVER-AUTHORITATIVE values, not local calculations
                  const heroPlayer = getPlayerAtSeat(tableState.heroSeat);
                  const heroStack = heroPlayer?.stack || 0;
                  const heroBet = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
                  const bb = safeBB(tableState.blinds);

                  // Derive callAmount from server's currentBet minus hero's current bet
                  const serverCurrentBet = tableState.currentBet || 0;
                  const callAmount = Math.min(Math.max(0, serverCurrentBet - heroBet), heroStack);

                  // Use server's authoritative minRaise (Bible V8 §4.14)
                  // Fallback to local calc only if server hasn't broadcast yet
                  const minRaise =
                    tableState.minRaise && tableState.minRaise > 0
                      ? tableState.minRaise
                      : Math.max(bb * 2, serverCurrentBet + bb);

                  // Bible V8 §4.14: maxRaise = stack for NL, pot-limited for PLO
                  const gameVariant = tableState.gameType?.toLowerCase() || '';
                  const isPotLimit = gameVariant.startsWith('plo'); // FIX 116: 'flo' dead variant removed
                  const maxRaise = isPotLimit
                    ? Math.min(heroStack, tableState.pot + callAmount + callAmount)
                    : heroStack;

                  return (
                    <>
                      <ActionPanel
                        canFold={true}
                        canCheck={callAmount === 0}
                        canCall={callAmount > 0}
                        canRaise={heroStack > callAmount && heroStack >= minRaise}
                        canAllIn={heroStack > 0}
                        callAmount={callAmount}
                        minRaise={minRaise}
                        maxRaise={maxRaise}
                        pot={tableState.pot}
                        bigBlind={bb}
                        onAction={handleActionPanelAction}
                        isMyTurn={true}
                        showPotOdds={userSettings.showPotOdds}
                        confirmAllIn={userSettings.confirmAllIn}
                      />
                    </>
                  );
                })()
              : null}

            {/* ─── SHOW HAND BUTTON — Bible V8 §4.21: Voluntary show at showdown ─── */}
            {tableState.boardStage === 'showdown' &&
              tableState.heroSeat > 0 &&
              tableId &&
              getPlayerAtSeat(tableState.heroSeat)?.status !== 'folded' && (
                <button
                  className="show-hand-btn"
                  onClick={async () => {
                    const result = await serverShowHand(tableId);
                    if (!result.success) {
                      reportError(result.error, 'TablePage.Failed');
                    }
                  }}
                  style={{
                    position: 'absolute',
                    bottom: '100px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    padding: '8px 20px',
                    borderRadius: '20px',
                    background: 'rgba(255, 255, 255, 0.15)',
                    border: '1px solid rgba(255, 255, 255, 0.3)',
                    color: '#fff',
                    fontSize: '13px',
                    cursor: 'pointer',
                    zIndex: 20,
                  }}
                >
                  Show Hand
                </button>
              )}

            {/* ─── PRE-ACTION BAR — Show when not hero's turn ─── */}
            {tableState.isHandInProgress &&
              tableState.currentPlayerSeat !== tableState.heroSeat && (
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
                setShowBuyInModal(true);
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
              <span className="menu-item-icon">💬</span>
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
                toast.info('VIP features coming soon!');
                setIsSideMenuOpen(false);
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
              <span className="menu-item-icon">📊</span>
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
      <div className="floating-action-br" style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
        {tableState.players[tableState.heroSeat - 1]?.status === 'sitting_out' && (
          <button 
            className="floating-im-back" 
            onClick={() => {
               soundService.playButtonClick();
               if (tableId) setSitOut(tableId, false).catch(e => console.error(e));
            }}
          >
            I'm Back
          </button>
        )}
        {/* Duplicate chat toggle REMOVED — TableChat renders its own collapsed icon */}
      </div>

      {/* Table Chat */}
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

      {/* Table Reactions — floating emoji picker + active reactions */}
      <TableReactions
        tableId={tableId}
        userId={userId}
        heroSeat={tableState.heroSeat}
        isOpen={isReactionPickerOpen}
        onClose={() => setIsReactionPickerOpen(false)}
        activeReactions={activeReactions}
      />

      {/* Performance Monitor — dev-only */}
      <TablePerfMonitor />

      {/* Player Notes Modal */}
      {showPlayerNotes && (
        <div className="player-notes-overlay" onClick={() => setShowPlayerNotes(false)}>
          <div className="player-notes-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowPlayerNotes(false)}>
              ✕
            </button>
            <PlayerNotesPanel
              targetUserId={selectedPlayerForNotes?.id}
              targetName={selectedPlayerForNotes?.name}
              onClose={() => setShowPlayerNotes(false)}
            />
          </div>
        </div>
      )}

      {/* Hand Replay Modal */}
      {showHandReplay && (
        <div className="player-notes-overlay" onClick={() => setShowHandReplay(false)}>
          <div
            className="player-notes-modal hand-replay-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setShowHandReplay(false)}>
              ✕
            </button>
            {lastHandId ? (
              <HandReplay handId={lastHandId} onClose={() => setShowHandReplay(false)} />
            ) : (
              <div className="no-hand-history">
                <span className="empty-icon">♠</span>
                <p>No recent hand to replay</p>
                <p className="hint">Complete a hand to view its replay</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Game Rules Modal */}
      <GameRulesModal
        isOpen={showGameRules}
        onClose={() => setShowGameRules(false)}
        variant={tableState.gameType || "No Limit Hold'em"}
        stakes={tableState.blinds || '1/2'}
        minBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 40;
        })()}
        maxBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 100;
        })()}
        rakePercentage={tableState.rakePercent ?? 5}
        rakeCap={tableState.rakeCap ?? 3}
        isStraddleEnabled={!tableState.isTournament && isStraddleEnabled}
        isRunItTwiceEnabled={tableState.runItTwice ?? true}
      />

      {/* Chip Animations */}
      <ChipAnimationManager
        animations={chipAnimations}
        onAnimationComplete={handleAnimationComplete}
      />

      {/* Sit Out Modal */}
      <SitOutModal
        isOpen={showSitOut}
        onClose={() => setShowSitOut(false)}
        onReturn={() => {
          setShowSitOut(false);
          setSitOutNextHand(false);
          // Bible V8 §7.12: Tell server player is sitting back in
          if (tableId) {
            setSitOut(tableId, false).catch((e) => reportError(e, 'TablePage.Return_failed'));
          }
        }}
        onLeaveTable={() => navigate('/')}
        timeRemaining={sitOutTimeRemaining}
        maxSitOutTime={300}
        tableName={tableState.tableName}
      />

      {/* Wait List Modal */}
      <WaitListModal
        isOpen={showWaitList}
        onClose={() => setShowWaitList(false)}
        tableName={tableState.tableName}
        blinds={tableState.blinds}
        players={waitListPlayers}
        myPlayerId={userId}
        onLeaveWaitList={() => setShowWaitList(false)}
      />

      {/* Insurance Modal */}
      {insuranceOffer && (
        <InsuranceModal
          isOpen={showInsurance}
          onClose={() => setShowInsurance(false)}
          onAccept={handleInsuranceAccept}
          onDecline={handleInsuranceDecline}
          onDeclineForHand={handleInsuranceDeclineForHand}
          offer={insuranceOffer}
          timeRemaining={15}
        />
      )}

      {/* Run It Twice Prompt — FIX 96: 2-phase flow with chooser model */}
      <RunItTwicePrompt
        isOpen={showRIT}
        isChooser={ritIsChooser}
        onChooserDecide={handleRITChooserDecide}
        onAccept={handleRITAccept}
        onDecline={handleRITDecline}
        timeRemaining={ritTimer}
        chosenRuns={ritChosenRuns}
        maxRuns={ritMaxRuns}
        playerCount={ritPlayerCount}
        opponentName={ritOpponent}
      />

      {/* Hand Reveal DISABLED — no popup overlays after hands, auto-muck silently */}
      {/* Winner cards are shown directly on the seat during showdown */}

      {/* Bad Beat Jackpot Display */}
      <BadBeatJackpot amount={bbjAmount} qualifyingHand="Quad 8s or better" isHit={showBBJ} />

      {/* FIX 128: BBJ Celebration Overlay — full-screen explosion when jackpot pays out */}
      {bbjCelebrationData && (
        <BBJCelebration
          visible={showBBJCelebration}
          totalPayout={bbjCelebrationData.totalPayout}
          loser={bbjCelebrationData.loser}
          winner={bbjCelebrationData.winner}
          tableShare={bbjCelebrationData.tableShare}
          perPlayerShare={bbjCelebrationData.perPlayerShare}
          tablePlayerCount={bbjCelebrationData.tablePlayerCount}
          onComplete={() => {
            setShowBBJCelebration(false);
            setBbjCelebrationData(null);
            setShowBBJ(false);
          }}
        />
      )}

      {/* Bomb Pot Overlay (dramatic announcement) */}
      {tableId && (
        <TableErrorBoundary componentName="BombPotOverlay">
          <BombPotOverlay tableId={tableId} />
        </TableErrorBoundary>
      )}

      {/* Final Table Overlay (tournament only) */}
      {tableId && tableState.isTournament && tableState.tournamentId && (
        <FinalTableOverlay
          tournamentId={tableState.tournamentId}
          tournamentName={tableState.tableName || 'Tournament'}
          hudStatsProvider={(userId) => {
            const stats = getPlayerHUDStats(userId);
            return stats
              ? {
                  handsPlayed: stats.handsPlayed,
                  vpipCount: stats.vpipCount,
                  pfrCount: stats.pfrCount,
                }
              : null;
          }}
        />
      )}

      {/* Heads-Up Overlay (tournament only) */}
      {tableId && tableState.isTournament && tableState.tournamentId && (
        <HeadsUpOverlay
          tournamentId={tableState.tournamentId}
          tournamentName={tableState.tableName || 'Tournament'}
        />
      )}

      {/* Hole Card Reveal DISABLED — showdown cards show directly on seats, no overlay */}
      {/* {tableId && <HoleCardReveal tableId={tableId} revealDelayMs={600} />} */}

      {/* Quick Chat Presets removed per user request */}

      {/* Throwable Selector */}
      {showThrowableSelector && userId && (
        <div className="throwable-selector-overlay" onClick={() => setShowThrowableSelector(false)}>
          <ThrowableSelector
            userId={userId}
            onSelect={handleThrowableSelect}
            onClose={() => setShowThrowableSelector(false)}
          />
        </div>
      )}

      {/* Throw Animations */}
      <ThrowAnimationContainer
        events={activeThrows}
        seatPositions={getSeatPositions(tableState.maxPlayers || 6)}
        onEventComplete={handleThrowComplete}
      />

      {/* Win Confetti — disabled (cheesy and annoying on repeated wins) */}
      {/* <ConfettiCanvas active={showConfetti} duration={3500} count={55} onComplete={() => setShowConfetti(false)} /> */}

      {/* Tip Dealer Modal */}
      <TipDealer
        isOpen={showTipDealer}
        onClose={() => setShowTipDealer(false)}
        onTip={handleTipDealer}
        balance={tableState.players[tableState.heroSeat - 1]?.stack || 0}
      />

      {/* Straddle Toggle — REMOVED from table overlay.
          Straddle enable/disable is handled via the hamburger TableMenu.
          The StraddleEngine still manages the state internally. */}

      {/* Time Bank — REMOVED from table overlay.
          Time bank activation is now handled inline via the timer UI
          (handleActivateTimeBank / handleBuyTimeBank are still wired).
          The floating TimeBank widget was overlapping the action area. */}

      {/* Leave Table Notice (non-blocking replacement for alert()) */}
      {leaveNotice && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1a1a2e',
            border: '1px solid #e74c3c',
            borderRadius: 8,
            padding: '12px 20px',
            color: '#fff',
            fontSize: 14,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            maxWidth: '90vw',
          }}
        >
          <span>{leaveNotice}</span>
          <button
            onClick={() => setLeaveNotice(null)}
            style={{
              background: '#e74c3c',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 12px',
              cursor: 'pointer',
            }}
          >
            OK
          </button>
        </div>
      )}

      {/* Diamond Wallet Modal */}
      <DiamondWalletModal
        isOpen={showDiamondWallet}
        onClose={() => setShowDiamondWallet(false)}
      />

      {/* Cashier Modal */}
      <CashierModal
        isOpen={showCashier}
        onClose={() => setShowCashier(false)}
        onAddChips={handleAddChips}
        onWithdrawChips={handleWithdrawChips}
        currentStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
        accountBalance={accountBalance}
        minBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 40;
        })()}
        maxBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 100;
        })()}
        maxStack={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 200;
        })()}
      />

      {/* Buy-In Modal */}
      <BuyInModal
        isOpen={showBuyInModal}
        onClose={() => setShowBuyInModal(false)}
        onConfirm={async (amount, autoRebuy) => {
          console.debug('[BuyIn] onConfirm FIRED — amount:', amount, 'autoRebuy:', autoRebuy);
          // Debounce protection: prevent double-click
          if (buyInProcessingRef.current) {
            console.warn('[BuyIn] Debounce: buyInProcessingRef is true — ignoring duplicate click');
            return;
          }
          buyInProcessingRef.current = true;
          try {
            // DEBUG: Log all buy-in conditions
            console.debug('[BuyIn] onConfirm called:', {
              amount,
              autoRebuy,
              tableId,
              userId,
              selectedSeat,
              isGuest: userId === 'guest',
            });

            if (userId && userId !== 'guest' && tableId && selectedSeat) {
              try {
                // CRITICAL: Server-side duplicate seat check — prevent same user in 2+ seats
                const { data: existingSeat } = await supabase
                  .from('table_seats')
                  .select('seat_number')
                  .eq('table_id', tableId)
                  .eq('user_id', userId)
                  .is('left_at', null)
                  .maybeSingle();

                if (existingSeat) {
                  console.warn(
                    '[BuyIn] BLOCKED — user already seated at seat',
                    existingSeat.seat_number
                  );
                  toast.error(`You're already seated at seat ${existingSeat.seat_number}.`);
                  setShowBuyInModal(false);
                  return;
                }

                console.debug('[BuyIn] Calling atomic_table_buyin:', {
                  userId,
                  tableId,
                  amount,
                  selectedSeat,
                });

                // Execute FULLY ATOMIC buy-in and seat insertion
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

                // Validate RPC return data — the function returns {success, amount}
                const rpcResult = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData;
                if (rpcResult && rpcResult.success === false) {
                  reportError(rpcResult, 'TablePage.atomic_table_buyin_returned_failure');
                  throw new Error(
                    'Buy-in rejected: ' + (rpcResult.error || 'Unknown server error')
                  );
                }

                console.debug('[BuyIn] atomic_table_buyin SUCCESS:', rpcResult);

                setAccountBalance((prev) => Math.max(0, prev - amount));
                totalBuyInRef.current += amount; // Track initial buy-in for session P/L
                if (amount > peakStackRef.current) peakStackRef.current = amount; // Init peak stack

                // Add player to local table state (use functional updater to preserve
                // concurrent WebSocket updates during the async RPC call)
                setTableState((prev) => {
                  const updatedPlayers = [...prev.players];
                  // FIX: ONE-SEAT-PER-USER — clear any stale hero entries in other seats
                  for (let j = 0; j < updatedPlayers.length; j++) {
                    if (updatedPlayers[j]?.id === userId && j !== selectedSeat - 1) {
                      console.debug('[BuyIn] Clearing stale hero from seat', j + 1);
                      updatedPlayers[j] = null as any;
                    }
                  }
                  updatedPlayers[selectedSeat - 1] = {
                    id: userId,
                    name: username || 'Player',
                    avatar: heroAvatarUrl || '',
                    stack: amount,
                    status: 'active',
                    isHero: true,
                    showCards: false,
                  };
                  return { ...prev, players: updatedPlayers, heroSeat: selectedSeat };
                });

                // FIX 132: Set heroSeatRef immediately on buy-in success
                heroSeatRef.current = selectedSeat;

                // Notify Hydra service that a real player joined (triggers horse recede)
                HydraService.onRealPlayerJoined(tableId, userId);

                // Broadcast seat update to other clients
                await sendAction('player_seated', {
                  seat: selectedSeat,
                  userId,
                  stack: amount,
                  autoRebuy,
                });

                // Update RoomService presence state so the user is globally seen as seated
                roomService.joinRoom(tableId, userId, username || 'Player', selectedSeat, amount);

                // Notify all consumers (MultiTablePage tabs, WaitlistPage, ClubLobby, DailyChallenges, etc.)
                masterBus.emit('TABLE_SEATED', {
                  tableId,
                  seat: selectedSeat,
                  tableName: tableState.tableName,
                });

                // Player seated successfully
              } catch (error) {
                reportError(error, 'TablePage.Buyin_FAILED');
                toast.error('Buy-in failed. Please try again or check your balance.');
              }
            } else {
              reportError({
                userId,
                isGuest: userId === 'guest',
                tableId,
                selectedSeat,
              }, 'TablePage.FELL_THROUGH__no_branch_matched');
              toast.error('Unable to complete buy-in. Please try again.');
            }
            setShowBuyInModal(false);
          } catch (outerErr) {
            reportError(outerErr, 'TablePage.UNHANDLED_error_in_onConfirm');
            toast.error('An unexpected error occurred. Please try again.');
            setShowBuyInModal(false);
          } finally {
            buyInProcessingRef.current = false;
            setSelectedSeat(null); // Reset to prevent stale seat on future interactions
          }
        }}
        tableName={tableState.tableName}
        minBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          const standardMin = bb * 40;
          // FIX 136: If player has a recent cashout at this table, min buy-in is the cashout amount
          return cashoutMinBuyIn > standardMin ? cashoutMinBuyIn : standardMin;
        })()}
        maxBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 100;
        })()}
        accountBalance={accountBalance}
        bigBlind={safeBB(tableState.blinds)}
        cashoutRestriction={cashoutMinBuyIn > 0 ? cashoutMinBuyIn : undefined}
      />

      {/* Rabbit Hunt (post-hand card reveal) */}
      <RabbitHunt
        isAvailable={isRabbitAvailable}
        onReveal={handleRabbitReveal}
        currentBoard={currentBoard}
      />

      {/* Leaderboard Panel */}
      <LeaderboardPanel
        isOpen={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
        title="Session Leaderboard"
        players={leaderboardPlayers}
        period={leaderboardPeriod}
        onPeriodChange={setLeaderboardPeriod}
      />

      {/* Old TableMenu removed — now rendered inside TableHUD upper-left corner */}

      {/* Leave Table Confirmation */}
      <LeaveTableConfirm
        isOpen={showLeaveConfirm}
        currentStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
        tableName={tableState.tableName || 'this table'}
        onConfirm={() => {
          setShowLeaveConfirm(false);
          handleLeaveTable();
        }}
        onCancel={() => setShowLeaveConfirm(false)}
      />

      {/* Session Stats Modal (Cash Games) */}
      {tableId && userId !== 'guest' && (
        <SessionHUD
          isOpen={showSessionStats}
          onClose={() => setShowSessionStats(false)}
          tableId={tableId}
          userId={userId}
          initialStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
          bigBlind={safeBB(tableState.blinds)}
        />
      )}

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={{
          autoMuckLosers: userSettings.autoMuck,
          autoMuckWinners: userSettings.autoMuckWinners,
          autoPostBlinds: userSettings.autoPostBlinds,
          soundEnabled: isSoundEnabled,
          soundVolume: userSettings.soundVolume,
          hapticEnabled: userSettings.isHapticEnabled,
          showPotOdds: userSettings.showPotOdds,
          animationSpeed:
            userSettings.animationSpeed === 0.5
              ? 'slow'
              : userSettings.animationSpeed === 1.5 || userSettings.animationSpeed === 2
                ? 'fast'
                : 'normal',
          fourColorDeck: userSettings.fourColorDeck,
          showStackInBB: userSettings.showStackInBB,
          showBetSizePresets: true,
          confirmAllIn: userSettings.confirmAllIn,
          sitOutNextHand: sitOutNextHand,
          tableTheme: userSettings.theme,
        }}
        onSettingsChange={(settingsUpdate) => {
          if (settingsUpdate.soundEnabled !== undefined) {
            setIsSoundEnabled(settingsUpdate.soundEnabled);
            updateSetting('isSoundEnabled', settingsUpdate.soundEnabled);
            soundService.setEnabled(settingsUpdate.soundEnabled);
          }
          if (settingsUpdate.autoMuckLosers !== undefined)
            updateSetting('autoMuck', settingsUpdate.autoMuckLosers);
          // FIX 199: showHandStrength handler REMOVED — not allowed for live online gameplay
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
          if (settingsUpdate.showStackInBB !== undefined) {
            updateSetting('showStackInBB', settingsUpdate.showStackInBB);
          }
          if (settingsUpdate.sitOutNextHand !== undefined) {
            setSitOutNextHand(settingsUpdate.sitOutNextHand);
            // Bible V8 §7.12: Notify server of sit-out status change
            if (tableId) {
              setSitOut(tableId, settingsUpdate.sitOutNextHand).catch((e) => reportError(e, 'TablePage.Failed'));
            }
          }
          if (settingsUpdate.autoMuckWinners !== undefined) {
            updateSetting('autoMuckWinners', settingsUpdate.autoMuckWinners);
          }
          if (settingsUpdate.autoPostBlinds !== undefined) {
            updateSetting('autoPostBlinds', settingsUpdate.autoPostBlinds);
          }
          if (settingsUpdate.hapticEnabled !== undefined) {
            updateSetting('isHapticEnabled', settingsUpdate.hapticEnabled);
          }
          if (settingsUpdate.tableTheme !== undefined) {
            updateSetting('theme', settingsUpdate.tableTheme);
          }
          if (settingsUpdate.soundVolume !== undefined) {
            updateSetting('soundVolume', settingsUpdate.soundVolume);
            soundService.setMasterVolume(settingsUpdate.soundVolume / 100);
          }
        }}
      />

      {/* Share Hand */}
      {showShareHand && sharedHandData && (
        <ShareHand
          isOpen={showShareHand}
          onClose={() => setShowShareHand(false)}
          hand={sharedHandData}
        />
      )}

      {/* Tournament Add-On Period Modal */}
      {tableState.isTournament && addOnPeriod.active && (
        <AddOnModal
          isVisible={addOnPeriod.active}
          addOnCost={addOnPeriod.addOnCost}
          addOnChips={addOnPeriod.addOnChips}
          walletBalance={addOnPeriod.walletBalance}
          timeRemaining={addOnPeriod.timeRemaining}
          onAccept={async () => {
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
          onDecline={() => {
            setAddOnPeriod((prev) => ({ ...prev, active: false }));
          }}
        />
      )}

      {/* Tournament Rebuy Modal */}
      {rebuyData && (
        <RebuyModal
          isOpen={showRebuyModal}
          rebuyCost={rebuyData.cost}
          rebuyChips={rebuyData.chips}
          walletBalance={accountBalance || 0}
          onConfirm={async () => {
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
          onClose={() => setShowRebuyModal(false)}
          isProcessing={rebuyProcessing}
        />
      )}

      {/* Tournament Break Screen Overlay */}
      {tableState.isTournament && (
        <TournamentBreakScreen
          isVisible={tournamentBreak.active}
          breakTimeRemaining={tournamentBreak.timeRemaining}
          tournamentName={tableState.tableName}
          currentLevel={0}
          nextLevel={
            tournamentBreak.nextLevel || { level: 1, smallBlind: 0, bigBlind: 0, duration: 0 }
          }
          playersRemaining={tableState.players.filter(Boolean).length}
          totalPlayers={tableState.maxPlayers}
          averageStack={
            tableState.players.filter(Boolean).reduce((s, p) => s + (p?.stack || 0), 0) /
            Math.max(tableState.players.filter(Boolean).length, 1)
          }
          topPlayers={[]}
          prizePool={0}
        />
      )}

      {/* Tournament Announcement Overlay */}
      {tableState.isTournament && (
        <TournamentAnnouncementOverlay
          type={announcement?.type as any}
          data={announcement?.data}
          onDismiss={() => setAnnouncement(null)}
        />
      )}

      {/* Tournament Winner Overlay */}
      {tableState.isTournament && tournamentWinner && (
        <TournamentWinnerOverlay
          isWinner={true}
          prize={tournamentWinner.prize}
          tournamentName={tournamentWinner.name}
          onDismiss={() => setTournamentWinner(null)}
        />
      )}

      {/* Hand History Panel */}
      <HandHistoryPanel
        isOpen={showHandHistory}
        onClose={() => setShowHandHistory(false)}
        hands={handHistory}
        heroId={userId || ''}
      />

      {/* Session Summary Modal — shown when player leaves table */}
      {showSessionSummary && (
        <SessionSummary
          duration={Math.floor((Date.now() - sessionStartRef.current) / 1000)}
          handsPlayed={handsPlayedRef.current}
          handsWon={handsWonRef.current}
          totalRebuys={totalRebuysRef.current}
          profitLoss={sessionPLRef.current}
          biggestPot={biggestPotRef.current}
          peakStack={peakStackRef.current}
          onClose={() => {
            // #6: Reset all session tracking refs to prevent stale data on re-seat
            handsPlayedRef.current = 0;
            biggestPotRef.current = 0;
            peakStackRef.current = 0;
            sessionPLRef.current = 0;
            totalBuyInRef.current = 0;
            handsWonRef.current = 0;
            totalRebuysRef.current = 0;
            sessionStartRef.current = Date.now();
            setShowSessionSummary(false);

            // Notify system to gracefully unmount tab AFTER user clicks close
            masterBus.emit('TABLE_LEFT', { tableId: tableId ?? '', seat: tableState.heroSeat });
            masterBus.emit('SESSION_SUMMARY_DISMISSED', { tableId: tableId ?? '' });

            if (window.location.pathname.includes('/table/')) {
              navigate('/');
            }
          }}
        />
      )}
      {/* Session HUD Modal (Cash Games Only) */}
      {!tableState.isTournament && tableId && userId !== 'guest' && (
        <TableErrorBoundary componentName="SessionHUD">
          <SessionHUD
            isOpen={showSessionHUD}
            onClose={() => setShowSessionHUD(false)}
            tableId={tableId}
            userId={userId}
            initialStack={tableState.players[tableState.heroSeat - 1]?.stack || 0}
            bigBlind={safeBB(tableState.blinds)}
          />
        </TableErrorBoundary>
      )}
    </div>
  );
}
