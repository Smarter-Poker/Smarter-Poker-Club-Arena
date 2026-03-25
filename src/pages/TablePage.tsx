/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Premium Poker Table Page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style table interface with Facebook color scheme
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
import { SeatSlot, PotDisplay, CommunityCards, DealerButton } from '../components/table';
import type { SeatPlayer, Card, LastAction, PositionBadge } from '../components/table/SeatSlot';
import type { SidePot } from '../components/table/PotDisplay';
import type { BoardStage } from '../components/table/CommunityCards';
import { useTableWebSocket } from '../services/TableWebSocket';
import { supabase, subscribeToHandState, getAuthUser } from '../lib/supabase';
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
import { timeBankEngine } from '../engine/TimeBankEngine'; // KEEP until Step 5
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
// [MIGRATION STEP 1] PokerEngine, HandController, ServerActionValidator, OFCPineappleEngine imports removed — server-authoritative
import { RakeWaterfallEngine } from '../engines/financial/RakeWaterfallEngine';
import { handPersistenceService } from '../services/HandPersistenceService';
import { handHistoryService } from '../services/HandHistoryService';
import { achievementTriggerService } from '../services/AchievementTriggerService';
import SpectatorBadge from '../components/table/SpectatorBadge';
import HandStrengthIndicator from '../components/table/HandStrengthIndicator';
import SessionTimer from '../components/table/SessionTimer';
import { horseBugReporter } from '../services/HorseBugReporter';
import GameServerAPI, { submitAction } from '../services/GameServerAPI';
import { retryAsync } from '../utils/retryAsync';
// [MIGRATION STEP 1] monteCarloEquity import removed — server-authoritative
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
// SEAT POSITIONS — Fixed percentages for vertical table layout (never move)
// ═══════════════════════════════════════════════════════════════════════════════

// Seat positions — PokerBros-style tight oval hugging the felt edge
const SEAT_POSITIONS_6MAX = [
  { x: 50, y: 93 }, // Seat 1 (Hero — bottom center)
  { x: 10, y: 72 }, // Seat 2 (bottom left)
  { x: 10, y: 32 }, // Seat 3 (top left)
  { x: 50, y: 7 }, // Seat 4 (top center)
  { x: 90, y: 32 }, // Seat 5 (top right)
  { x: 90, y: 72 }, // Seat 6 (bottom right)
];

const SEAT_POSITIONS_9MAX = [
  { x: 50, y: 95 }, // Seat 1 (Hero — bottom center)
  { x: 17, y: 87 }, // Seat 2 (bottom left)
  { x: 10, y: 64 }, // Seat 3 (left middle) — shifted inward to prevent label clipping
  { x: 10, y: 38 }, // Seat 4 (left upper) — shifted inward to prevent label clipping
  { x: 22, y: 12 }, // Seat 5 (top left)
  { x: 50, y: 5 }, // Seat 6 (top center)
  { x: 78, y: 12 }, // Seat 7 (top right)
  { x: 90, y: 38 }, // Seat 8 (right upper) — shifted inward to prevent label clipping
  { x: 90, y: 64 }, // Seat 9 (right middle) — shifted inward to prevent label clipping
];

// HORSE AVATARS — Assign custom avatars to horse players using DiceBear API
const HORSE_AVATARS: Record<string, string> = {
  'Solver Steve':
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=SolverSteve&backgroundColor=b6e3f4',
  SmallBlind:
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=SmallBlind&backgroundColor=c0aede',
  'SlowRoll Sid':
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=SlowRollSid&backgroundColor=d1d4f9',
  KingFish: 'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=KingFish&backgroundColor=ffd5dc',
  'TAG Tyler':
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=TAGTyler&backgroundColor=ffdfbf',
  'Maniac Mike':
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=ManiacMike&backgroundColor=ff9999',
  NitNat: 'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=NitNat&backgroundColor=c1f0c1',
  'Bluff Queen':
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=BluffQueen&backgroundColor=e8c1f0',
  AceHigh: 'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=AceHigh&backgroundColor=f0e6c1',
  TiltMaster:
    'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=TiltMaster&backgroundColor=f0c1c1',
};

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
  const { tableId: routeTableId } = useParams<{ tableId: string }>();
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
    const meta = document.querySelector('meta[name="viewport"]');
    const originalContent = meta?.getAttribute('content') || '';
    const pokerViewport =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

    if (meta) {
      meta.setAttribute('content', pokerViewport);
    } else {
      const newMeta = document.createElement('meta');
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
      const restoreMeta = document.querySelector('meta[name="viewport"]');
      if (restoreMeta) {
        restoreMeta.setAttribute(
          'content',
          originalContent || 'width=device-width, initial-scale=1'
        );
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
          .select('display_name, username')
          .eq('id', user.id)
          .maybeSingle();
        if (isMounted.current) setUsername(profile?.display_name || profile?.username || 'Player');
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

  // WebSocket connection for real-time game state
  const { isConnected, presence, lastEvent, sendAction, sendChat, updateSeat } = useTableWebSocket(
    tableId || '',
    userId,
    username
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

  const [raiseAmount, setRaiseAmount] = useState(20);
  const [showRaiseSlider, setShowRaiseSlider] = useState(false);
  const [preAction, setPreAction] = useState<'fold' | 'check' | 'callAny' | null>(null);

  // Time Bank State
  const [showTimeBank, setShowTimeBank] = useState(false);
  const [timeBankActive, setTimeBankActive] = useState(false);
  const [timeBanksRemaining, setTimeBanksRemaining] = useState(4);
  const [timeBankTimeRemaining, setTimeBankTimeRemaining] = useState(15);

  // Phase L: Deep Audit — Wire React state to MasterBus for cross-component telemetry
  useEffect(() => {
    if (preAction && tableId && userId) {
      masterBus.emit('PRE_ACTION_SET', {
        tableId,
        playerId: userId,
        action:
          preAction === 'fold'
            ? 'auto_fold'
            : preAction === 'check'
              ? 'auto_check'
              : 'auto_call_any',
      });
    }
  }, [preAction, tableId, userId]);

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
  const triggerChipAnimationRef = useRef<((fromSeat: number, toPot: boolean, amount: number) => void) | null>(null);
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
    }
  });

  // Buy-in processing lock to prevent double-click
  const buyInProcessingRef = useRef(false);

  // Actual club_id from the table record (NOT the tableId)
  const actualClubIdRef = useRef<string>('');
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

  // Reaction picker state
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);

  // Insurance Modal state
  const [showInsurance, setShowInsurance] = useState(false);
  const [insuranceOffer, setInsuranceOffer] = useState<InsuranceOffer | null>(null);

  // Run It Twice state
  const [showRIT, setShowRIT] = useState(false);
  const [ritTimer, setRitTimer] = useState(10);
  const [ritOpponent, setRitOpponent] = useState('Opponent');

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

  // Handle insurance offer (triggered by game engine)
  const handleInsuranceAccept = async (coverageAmount: number) => {
    if (userId && tableId) {
      try {
        // Process insurance payment via WalletService
        const premium = coverageAmount * 0.1; // 10% premium
        await WalletService.processInsurance(userId, tableId, `hand-${Date.now()}`, premium);
      } catch (error) {
        console.error('Insurance processing failed:', error);
      }
    }
    setShowInsurance(false);
  };

  const handleInsuranceDecline = () => {
    setShowInsurance(false);
    // After insurance decision, show RIT prompt if set up
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

  // Run It Twice handlers
  const handleRITAccept = () => {
    setShowRIT(false);
    // Broadcast RIT acceptance to WebSocket
    sendAction('rit_accept', { seat: tableState.heroSeat });
  };

  const handleRITDecline = () => {
    setShowRIT(false);
    sendAction('rit_decline', { seat: tableState.heroSeat });
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

  // Handle dealer tip
  const handleTipDealer = async (amount: number) => {
    if (userId && tableId) {
      try {
        await WalletService.processDealerTip(userId, tableId, amount);
      } catch (error) {
        console.error('Tip processing failed:', error);
      }
    }
    setShowTipDealer(false);
  };

  // Cashier state
  const [showCashier, setShowCashier] = useState(false);
  const [accountBalance, setAccountBalance] = useState(0); // Player Wallet balance from wallets table

  // Handle cashier add chips (deducts from wallet, adds to table stack)
  const handleAddChips = async (amount: number) => {
    if (!userId || userId === 'guest' || !tableId) {
      console.error('Cannot add chips: not authenticated');
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
      // Update hero's table stack in local state AND sync to DB
      setTableState((prev) => {
        const updatedPlayers = [...prev.players];
        const heroIdx = prev.heroSeat - 1;
        if (heroIdx >= 0 && updatedPlayers[heroIdx]) {
          updatedPlayers[heroIdx] = {
            ...updatedPlayers[heroIdx]!,
            stack: updatedPlayers[heroIdx]!.stack + amount,
          };
        }
        return { ...prev, players: updatedPlayers };
      });
      // Sync stack increment to Supabase table_seats (fire-and-forget with retry)
      // Wallet debit already handled by WalletService.lockForBuyIn above.
      // Use DB-side stack + amount to avoid stale-closure on tableState.players.
      retryAsync(
        async () =>
          await supabase
            .from('table_seats')
            .update({ stack: (tableState.players[tableState.heroSeat - 1]?.stack || 0) + amount })
            .eq('table_id', tableId)
            .eq('user_id', userId)
            .is('left_at', null),
        2,
        500
      )
        .then((result: any) => {
          if (result?.error)
            console.warn('[Cashier] Add chips DB sync failed:', result.error.message);
        })
        .catch((err: unknown) => {
          console.warn('[Cashier] Add chips sync exhausted all retries:', err);
        });
      // Emit bus event so other pages (Dashboard, Profile) know about the chip change
      const estimatedNewStack = (tableState.players[tableState.heroSeat - 1]?.stack || 0) + amount;
      masterBus.emit('CHIPS_ADDED', { tableId, userId, amount, newStack: estimatedNewStack });
    } catch (error) {
      console.error('Failed to add chips:', error);
      // Surface error to user — alert as fallback since toast not always available
      const msg = error instanceof Error ? error.message : 'Failed to add chips';
      if (typeof window !== 'undefined') toast.error(msg);
    }
  };

  // Handle cashier withdraw
  const handleWithdrawChips = async (amount: number) => {
    if (!userId || userId === 'guest' || !tableId) {
      console.error('Cannot withdraw: not authenticated');
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
      console.error('Failed to withdraw chips:', error);
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

  // Handle rabbit hunt reveal
  const handleRabbitReveal = async (): Promise<
    Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>
  > => {
    // [MIGRATION STEP 1] Local engine deck removed — rabbit hunt uses server or random fallback
    // TODO: Wire to server-side rabbit hunt endpoint in Step 3
    const cardsNeeded = 5 - currentBoard.length;

    // Generate random cards (server-side rabbit hunt not yet available)
    const suits: Array<'h' | 'd' | 'c' | 's'> = ['h', 'd', 'c', 's'];
    const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    const remainingCards: Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }> = [];
    for (let i = 0; i < cardsNeeded; i++) {
      remainingCards.push({
        rank: ranks[Math.floor(Math.random() * ranks.length)],
        suit: suits[Math.floor(Math.random() * suits.length)],
      });
    }
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
      console.error('Error fetching GTO advice:', error);
    }
    setIsGtoLoading(false);
  };

  // Rake state
  const [currentRake, setCurrentRake] = useState<RakeCalculation | null>(null);
  const [sessionRake, setSessionRake] = useState(0);

  // Handle hand complete - calculate rake, execute waterfall, and record BBJ contribution
  const handleHandComplete = async (
    handId: string,
    potSize: number,
    wentToFlop: boolean,
    players: Array<{ userId: string; clubId: string; agentId?: string }>
  ) => {
    // Parse blinds from string (e.g., "0.25/0.50" -> sb=0.25, bb=0.50)
    // Use ref for fresh blinds (this function is called from event handler closures)
    const currentBlinds = tableStateRef.current.blinds || '?/?';
    const blindParts = currentBlinds.split('/');
    const smallBlind = parseFloat(blindParts[0]) || 1;
    const bigBlind = parseFloat(blindParts[1]) || 2;

    // Calculate rake using official stake-based chart
    const rakeCalc = RakeService.calculateRake(potSize, bigBlind, wentToFlop, smallBlind);
    setCurrentRake(rakeCalc);
    setSessionRake((prev) => prev + rakeCalc.cappedRake);

    // Execute waterfall (distribute rake to all parties)
    if (tableId && players.length > 0) {
      const clubId = actualClubIdRef.current || players[0]?.clubId || tableId;
      try {
        // Resolve unionId from club → union_clubs join table
        let unionId: string | undefined;
        try {
          const { data: ucRow } = await supabase
            .from('union_clubs')
            .select('union_id')
            .eq('club_id', await resolveClubUUID(clubId))
            .limit(1)
            .maybeSingle();
          if (ucRow) unionId = ucRow.union_id;
        } catch {
          /* club may not be in a union — standalone club */
        }

        const waterfallResult = await RakeService.executeWaterfall({
          handId,
          tableId,
          clubId,
          unionId,
          smallBlind,
          potSize,
          bigBlind,
          wentToFlop,
          players: players.map((p) => ({
            ...p,
            isSittingOut: false,
            hasCards: true,
            wentToFlop,
          })),
        });

        // Update local BBJ display from waterfall result
        if (waterfallResult.bbjContributed && wentToFlop) {
          setBbjAmount((prev) => prev + BBJService.calculateContribution(bigBlind));
        }
      } catch (rakeErr) {
        console.error('[Rake] Waterfall failed:', rakeErr);
      }
    }
  };

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
        console.error('[Leave] Failed to leave table');
        setLeaveNotice(
          'Unable to leave right now. You may be in an active hand — you will leave after it completes.'
        );
      }
    } catch (error) {
      console.error('[Leave] Exception:', error);
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
      masterBus.emit('TABLE_LEFT', { tableId, seat: tableState.heroSeat });
      masterBus.emit('SESSION_ENDED', { tableId, userId });
      playerStatusService.clearPlayingAt(userId);
    } catch {
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

            const formattedCards = (rawCards || []).map((c: any) => ({
              rank: c.rank,
              suit: ENGINE_SUIT_MAP[c.suit] || (c.suit as 'h' | 'd' | 'c' | 's'),
            }));

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

  // Fallback: Check active hand if page reloads mid-hand and misses the INSERT event
  useEffect(() => {
    if (!tableId || !userId) return;
    const fetchExistingHand = async () => {
      if (!tableStateRef.current.isHandInProgress) return;
      const { data } = await supabase
        .from('table_hole_cards')
        .select('cards')
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data && data.cards) {
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
            updatedPlayers[heroIdx] = {
              ...updatedPlayers[heroIdx]!,
              holeCards: (rawCards || []).map((c: any) => ({
                rank: c.rank,
                suit: ENGINE_SUIT_MAP[c.suit] || (c.suit as any),
              })),
              showCards: true,
            };
          }
          return { ...prev, players: updatedPlayers };
        });
      }
    };
    fetchExistingHand();
  }, [tableId, userId]);

  // Subscribe to server-side hand state broadcast (ServerTableEngine deals on the server)
  useEffect(() => {
    if (!tableId) return;
    const unsubscribe = subscribeToHandState(tableId, (handState: Record<string, unknown>) => {
      if (!handState) return;

      const serverPlayers = (handState.players as any[]) || [];
      const stage = (handState.stage as string) || 'preflop';
      const communityCards = (handState.community_cards as any[]) || [];
      const pot = (handState.pot as number) || 0;
      const currentBet = (handState.current_bet as number) || 0;
      const currentPlayer = handState.current_player as string | null;
      const dealerSeat = (handState.dealer_seat as number) || 0;

      setTableState((prev) => {
        const updatedPlayers = [...prev.players];

        // Merge server player data with existing UI state
        for (const sp of serverPlayers) {
          const seatIdx = (sp.seat as number) - 1;
          if (seatIdx < 0 || seatIdx >= updatedPlayers.length) continue;

          const existing = updatedPlayers[seatIdx];
          const isHero = sp.user_id === userId;

          updatedPlayers[seatIdx] = {
            ...(existing || {}),
            id: sp.user_id,
            name: sp.username || existing?.name || `Seat ${sp.seat}`,
            stack: sp.stack,
            bet: sp.bet || 0,
            // Card security: server scrubs hole cards in broadcast (sends []) except at showdown.
            // Hero gets cards via RLS-protected table_hole_cards channel.
            // At showdown, server sends actual cards for all players → use sp.cards.
            holeCards: sp.cards && sp.cards.length > 0
              ? sp.cards
              : existing?.holeCards || [],
            status: sp.is_folded
              ? 'folded'
              : sp.is_all_in
                ? 'all_in'
                : sp.is_sitting_out
                  ? 'sitting_out'
                  : 'active',
            isHero,
            // Show cards for hero always; show opponent cards at showdown ONLY if not folded
            showCards: isHero || (sp.cards && sp.cards.length > 0 && !sp.is_folded),
          } as any;
        }

        // Clear seats that have no server player
        const serverSeatNums = new Set(serverPlayers.map((sp: any) => sp.seat));
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
          currentPlayerSeat,
          dealerSeat,
          isHandInProgress: stage !== 'preflop' || pot > 0,
        };
      });

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

  // Component visibility states
  const [showSettings, setShowSettings] = useState(false);
  const [showShareHand, setShowShareHand] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  const [showSessionStats, setShowSessionStats] = useState(false);
  const [sharedHandData, setSharedHandData] = useState<any>(null);

  // Load table info from Supabase on mount
  useEffect(() => {
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
        setActionTimeSeconds(table.action_time_seconds || 15);

        // ─── Load bounty data for KO/PKO tournaments ───
        if (table.tournament_id) {
          const { data: tournData } = await supabase
            .from('tournaments')
            .select('is_bounty, is_pko, is_mystery_bounty, bounty_amount, spin_multiplier, blind_structure, current_level')
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
                    console.error('[TablePage] Addon period wallet fetch error:', e);
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
                    console.error('[TablePage] Error checking player table during rebalance:', err);
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
            .select('id, username, avatar_url, is_horse')
            .in('id', userIds);

          const profileMap = new Map((profiles || []).map((p) => [p.id, p]));

          // BUG-09 FIX: Merged heroSeat update into same setTableState callback
          // (was previously calling setTableState inside setTableState which causes React warnings)
          // CRITICAL: Detect and clean up duplicate seats for the same user
          const heroSeats = existingSeats.filter((s) => s.user_id === userId);
          if (heroSeats.length > 1) {
            console.error('[Seat] DUPLICATE SEATS DETECTED for user', userId, '— cleaning up extras');
            // Keep the first seat, remove the rest from DB
            const [keepSeat, ...extraSeats] = heroSeats;
            for (const extra of extraSeats) {
              supabase
                .from('table_seats')
                .update({ left_at: new Date().toISOString() })
                .eq('table_id', table.id)
                .eq('seat_number', extra.seat_number)
                .eq('user_id', userId)
                .then(({ error }) => {
                  if (error) console.error('[Seat] Failed to remove duplicate seat:', error);
                  else console.debug('[Seat] Removed duplicate seat', extra.seat_number);
                });
            }
            // Filter existingSeats to exclude duplicates for local state
            const cleanedSeats = existingSeats.filter(
              (s) => s.user_id !== userId || s.seat_number === keepSeat.seat_number
            );
            existingSeats.length = 0;
            existingSeats.push(...cleanedSeats);
          }

          setTableState((prev) => {
            const updatedPlayers = [...prev.players];
            let resolvedHeroSeat = prev.heroSeat;
            let heroAlreadyAssigned = false;
            for (const seat of existingSeats) {
              const seatIdx = seat.seat_number - 1;
              if (seatIdx < 0 || seatIdx >= updatedPlayers.length) continue;
              const profile = profileMap.get(seat.user_id);
              // Only the FIRST matching seat gets isHero — prevents duplicates
              const isHero = seat.user_id === userId && !heroAlreadyAssigned;
              if (isHero) heroAlreadyAssigned = true;

              updatedPlayers[seatIdx] = {
                id: seat.user_id,
                name: profile?.username || `Player ${seat.seat_number}`,
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
            return { ...prev, players: updatedPlayers, heroSeat: resolvedHeroSeat };
          });
          // heroSeat already set inside the setTableState callback above (L1796)
          // No second setTableState needed — avoids unnecessary re-render
        }

        // ─── Initialize Time Bank Engine for the human player ───
        const isTournamentTable = table.game_type === 'tournament' || !!table.tournament_id;
        // Use table settings from Supabase; fall back to sensible defaults
        const tbSeconds = (table as any).time_bank_seconds || (isTournamentTable ? 15 : 30);
        const perUseSeconds = (table as any).action_time_seconds || 15;
        timeBankEngine.configure(table.id, {
          totalBankSeconds: tbSeconds,
          maxUses: isTournamentTable ? 2 : Math.max(1, Math.ceil(tbSeconds / perUseSeconds)),
          secondsPerUse: perUseSeconds,
          refillPerOrbit: !isTournamentTable,
          refillSeconds: perUseSeconds,
          autoActivate: true,
        });
        if (userId && userId !== 'guest') {
          const heroSeatData = existingSeats?.find((s) => s.user_id === userId);
          timeBankEngine.initializePlayer(table.id, userId, {
            remainingSeconds: (heroSeatData as any)?.time_bank_remaining ?? undefined,
            usesRemaining: (heroSeatData as any)?.time_bank_uses_remaining ?? undefined,
          });
          // Sync React state from engine
          const bank = timeBankEngine.getPlayerBank(table.id, userId);
          if (bank) {
            setTimeBanksRemaining(bank.usesRemaining);
            setTimeBankTimeRemaining(bank.remainingSeconds);
          }
        }
      }
    }
    loadTableInfo();
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

          // Step 1: Show action label immediately (200ms display)
          if (seatIdx >= 0) {
            setTableState((prev) => {
              const newActions = [...prev.lastActions];
              newActions[seatIdx] = action as any;
              const newBets = [...prev.lastBetAmounts];
              if (actionAmount > 0) newBets[seatIdx] = actionAmount;
              return { ...prev, lastActions: newActions, lastBetAmounts: newBets };
            });

            // Clear action label after 2 seconds
            setTimeout(() => {
              setTableState((prev) => {
                const newActions = [...prev.lastActions];
                newActions[seatIdx] = null;
                return { ...prev, lastActions: newActions };
              });
            }, 2000);
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
            if ((action === 'bet' || action === 'raise' || action === 'call' || action === 'allin') && actionSeat > 0) {
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
      timeBankEngine.dispose(tableId); // Clean up timer entries to prevent zombie accumulation
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
    console.error(
      `[StateVerifier] ⚠️ INTEGRITY VIOLATION hand #${payload.handNumber}:`,
      payload.violations
    );
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

  useMasterBusSubscription('INSURANCE_OFFERED', (payload: any) => {
    if (payload.tableId !== tableId || payload.playerId !== userId) return;
    setInsuranceOffer(payload.offer);
    setShowInsurance(true);
  });

  useMasterBusSubscription('TIME_BANK_ACTIVATED', (payload: any) => {
    if (payload.tableId !== tableId) return;

    const seconds =
      payload.secondsGranted ?? payload.additionalSeconds ?? payload.secondsAdded ?? 15;

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
        console.error('[TablePage] Failed to persist time bank state:', err);
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
    if (isHeroTurn && timeBankEngine.hasTimeBank(tableId, userId)) {
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
      if (tableId && userId) {
        timeBankEngine.playerActed(tableId, userId);
      }
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
            console.debug('[Horses] seedTable returned', seededHorses.length, 'horses, populating UI');
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
        console.error('[Horses] Failed to load horses:', err);
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
                HORSE_AVATARS[horse.name] ||
                `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(horse.name || 'default')}&backgroundColor=b6e3f4`,
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
  // [MIGRATION STEP 1] HandController removed — server is authoritative
  // Only keeping state needed by other parts of the component
  // ═══════════════════════════════════════════════════════════════════════════
  const [displayHandNumber, setDisplayHandNumber] = useState<number | null>(null);

  // Keep a ref to the latest tableState for use inside event closures
  const tableStateRef = useRef(tableState);
  useEffect(() => {
    tableStateRef.current = tableState;
  }, [tableState]);

  // ═══════════════════════════════════════════════════════════════════════════
  // [MIGRATION STEP 1] startNextHand removed — server manages the game loop
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
      case 'POT_WIN':
        // Show winner animation
        break;
      case 'HAND_COMPLETE':
        // Reset for next hand
        setTableState((prev) => ({
          ...prev,
          communityCards: [],
          boardStage: 'preflop',
          pot: 0,
          sidePots: [],
        }));
        setIsAllInMode(false);
        break;
    }
  }, [lastEvent]);

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
                avatar: p.avatar || '',
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
  const seatPositions = useMemo(
    () => seatRotationMap.map((s) => s.pos),
    [seatRotationMap]
  );

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
    // Don't allow sitting if already seated at this table
    // Check BOTH heroSeat AND scan players array for any seat with our userId
    if (tableState.heroSeat > 0) {
      console.debug('[Seat] Hero already seated at seat', tableState.heroSeat, '— ignoring click');
      return;
    }
    const existingHeroIdx = tableState.players.findIndex((p) => p && p.id === userId);
    if (existingHeroIdx >= 0) {
      console.debug('[Seat] Hero found at seat', existingHeroIdx + 1, 'via player scan — ignoring click');
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

  // [MIGRATION STEP 1] broadcastLocalHandState removed — server broadcasts state authoritatively

  // Unified Table Timer Logic (Phase M) - Moved out of the way of all earlier references
  const isHeroTurnContext =
    tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress;

  const handleTimerAutoFold = useCallback(() => {
    if (actionLockRef.current) return; // Prevent race with manual fold
    // [MIGRATION STEP 1] Local engine call removed — server is authoritative
    try {
      sendAction('fold', { seat: tableState.heroSeat, autoFold: true });
      soundService.playFold();
      if (tableId)
        submitAction(tableId, userId || 'guest', 'fold').catch((e) =>
          console.warn('[Table] Server fold failed:', e)
        );
    } catch (err) {
      console.error('[AutoFold] Error during auto-fold:', err);
    }
  }, [tableState.heroSeat, tableId, userId, sendAction]);

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
      // Auto-activate time bank if available
      if (tableId && userId && timeBankEngine.hasTimeBank(tableId, userId)) {
        const didActivate = timeBankEngine.onPrimaryTimerExpired(
          tableId,
          userId,
          handleTimerAutoFold
        );
        if (didActivate) {
          GameServerAPI.activateTimeBank(tableId, userId).catch(console.error);
        } else {
          handleTimerAutoFold();
        }
      } else {
        handleTimerAutoFold();
      }
    },
    initialTime: actionTimeSeconds,
  });

  // Handle immediate UI Activation when button is clicked
  const handleActivateTimeBank = useCallback(() => {
    if (!tableId || !userId) return;
    const activated = timeBankEngine.activate(tableId, userId, handleTimerAutoFold);
    if (activated) {
      soundService.playChips();
      GameServerAPI.activateTimeBank(tableId, userId).catch(console.error);
    }
  }, [tableId, userId, handleTimerAutoFold]);

  // Handle buying a time bank extension (VIP quota or diamond purchase)
  const handleBuyTimeBank = useCallback(async () => {
    if (!tableId || !userId) return;
    await timeBankEngine.requestExtension(tableId, userId);
  }, [tableId, userId]);

  // [MIGRATION STEP 1] Validation moved to server — client does basic guard only
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
    // [MIGRATION STEP 1] Local engine call removed — server is authoritative
    soundService.playFold();
    haptic?.light();
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
    // [MIGRATION STEP 1] Local engine call removed — server is authoritative
    soundService.playCheck();
    haptic?.light();
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
    // [MIGRATION STEP 1] Local engine call removed — server is authoritative
    soundService.playChips();
    haptic?.light();
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
        // [MIGRATION STEP 1] Use tableState instead of local engine state
        const canCheck = (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0) === 0;
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
  // [MIGRATION STEP 1] Server is authoritative — all actions go through submitAction
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

      // [MIGRATION STEP 1] All local engine calls removed — server is authoritative
      switch (action) {
        case 'fold':
          if (!validateAndExecuteAction('fold')) return;
          soundService.playFold();
          haptic?.light();
          if (tableId)
            await submitAction(tableId, userId, 'fold').catch((e) =>
              console.warn('[Table] Server fold failed:', e)
            );
          break;
        case 'check':
          if (!validateAndExecuteAction('check')) return;
          soundService.playCheck();
          haptic?.light();
          if (tableId)
            await submitAction(tableId, userId, 'check').catch((e) =>
              console.warn('[Table] Server check failed:', e)
            );
          break;
        case 'call':
          if (!validateAndExecuteAction('call')) return;
          soundService.playChips();
          haptic?.light();
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
            soundService.playRaise();
            haptic?.light();
            if (tableId)
              await submitAction(tableId, userId, 'raise', clamped).catch((e) =>
                console.warn('[Table] Server raise failed:', e)
              );
          }
          break;
        case 'allin':
          if (heroStack <= 0) return;
          if (!validateAndExecuteAction('allin')) return;
          soundService.playAllIn();
          haptic?.light();
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
      // [MIGRATION STEP 1] Local engine call removed — server is authoritative
      soundService.playRaise();
      haptic?.light();
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
      // [MIGRATION STEP 1] Local engine call removed — server is authoritative
      soundService.playAllIn();
      haptic?.light();
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

      // If heads-up all-in (2 players all-in), trigger insurance
      if (activePlayers.length === 0 && allInPlayers.length >= 2) {
        const opponent = allInPlayers.find((p) => p?.id !== hero?.id);
        const potSize = currentState.pot;
        const maxCoverage = Math.trunc(potSize * 0.8 * 100) / 100; // 80% of pot coverage

        // Convert board cards to proper format — use ref for fresh data inside workerTimeout
        const boardCards = tableStateRef.current.communityCards.map((c) => ({
          rank: c.rank,
          suit: c.suit as 'h' | 'd' | 'c' | 's',
        }));

        // Hero's hole cards — BUG-F FIX: read from fresh ref, not stale 'hero' closure
        const freshHero = tableStateRef.current.players[heroSeat - 1];
        const heroCards =
          (freshHero?.holeCards || hero?.holeCards)?.map((c) => ({
            rank: c.rank,
            suit: c.suit as 'h' | 'd' | 'c' | 's',
          })) || [];

        // [MIGRATION STEP 1] monteCarloEquity removed — equity calc moves to server
        // TODO: Wire to server-side equity endpoint in Step 3
        // Using heuristic fallback until server endpoint is ready
        const numOpponents = allInPlayers.length - 1;
        let equityPercent = numOpponents <= 1 ? 55 : Math.max(20, 65 - numOpponents * 10);

        setInsuranceOffer({
          maxCoverage,
          equityPercent,
          premiumRate: 0.1, // 10% premium rate
          potAmount: potSize,
          yourStack: heroStack,
          opponentStack: opponent?.stack || 0,
          yourCards: heroCards,
          board: boardCards,
        });
        setShowInsurance(true);

        // Also trigger Run It Twice prompt after insurance decision
        setRitOpponent(opponent?.name || 'Opponent');
        setRitTimer(10);
        // RIT prompt will show after insurance modal closes
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
      // [MIGRATION STEP 1] Use tableState instead of local engine state
      const canCheck = (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0) === 0;
      if (canCheck) {
        handleCheck();
      } else {
        handleCall();
      }
    },
    onRaise: handleRaise,
    onAllIn: handleAllIn,
    onToggleSound: () => setIsSoundEnabled((prev) => !prev),
    onToggleHandStrength: () => updateSetting('showHUD', !userSettings.showHUD),
    onToggleStats: () => updateSetting('showHUD', !userSettings.showHUD),
    onBetPreset: (preset: number) => {
      // Bet presets: 0=1/3 pot, 1=1/2 pot, 2=3/4 pot, 3=pot
      // [MIGRATION STEP 1] Use tableState.pot instead of local engine state
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
      console.error('Failed to load waitlist:', error);
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
            // [MIGRATION STEP 1] Use tableState instead of local engine state
            const callAmount = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
            if (callAmount === 0) {
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
          } else if (preAction === 'callAny') {
            // "Call Any" = stay in hand: if nothing to call, check instead
            // [MIGRATION STEP 1] Use tableState instead of local engine state
            const callAmount2 = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
            if (callAmount2 > 0) {
              await handleCall();
            } else {
              await handleCheck();
            }
            masterBus.emit('PRE_ACTION_EXECUTED', {
              tableId: tableId!,
              playerId: userId!,
              action: callAmount2 > 0 ? 'call' : 'check',
              amount: 0,
            });
          }
          // Clear the pre-action after executing
          setPreAction(null);
        } catch (err) {
          console.error('[PreAction] Error executing pre-action:', err);
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
      data-felt-theme={userSettings.theme || 'black'}
    >
      <style>{`
                @keyframes boardSlideIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
                @keyframes boardFade { from { opacity: 0.7; } to { opacity: 1; } }
                .community-area { animation: boardFade 0.4s ease-out; }
                .board-transition { animation: boardSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
            `}</style>
      {/* ═══════════════════════════════════════════════════════════════════════
          HEADER BAR — Compact PokerBros-style with game info
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
          {tableState.tableName && (
            <span className="header-table-name">{tableState.tableName}</span>
          )}
          <span className="header-game-type">{tableState.gameType}</span>
          <span className="header-blinds">{tableState.blinds}</span>
        </div>
        <div className="header-right">
          <button
            className="header-btn"
            onClick={() => {
              soundService.playButtonClick();
              setShowHandHistory((prev) => !prev);
            }}
            title="Hand History"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M3 4h12M3 7h8M3 10h10M3 13h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className="header-btn"
            onClick={() => {
              soundService.playButtonClick();
              setShowSettings(true);
            }}
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className="header-btn menu-btn"
            onClick={() => {
              soundService.playButtonClick();
              setShowTableMenu(true);
            }}
            title="Menu"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="4" r="1.5" fill="currentColor" />
              <circle cx="9" cy="9" r="1.5" fill="currentColor" />
              <circle cx="9" cy="14" r="1.5" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

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
                  <div className="hand-number-display">
                    Hand #{displayHandNumber}
                  </div>
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

                {/* Hand Strength Indicator - Shows during hero's turn (respects showHUD toggle) */}
                {userSettings.showHUD &&
                  tableState.isHandInProgress &&
                  tableState.players[tableState.heroSeat - 1]?.holeCards &&
                  tableState.players[tableState.heroSeat - 1]!.holeCards!.length >= 2 && (
                    <div className="hand-strength-hud">
                      <HandStrengthIndicator
                        cards={tableState.players[tableState.heroSeat - 1]!.holeCards!.map(
                          (c: Card) => `${c.rank}${c.suit}`
                        )}
                        communityCards={tableState.communityCards.map(
                          (c: Card) => `${c.rank}${c.suit}`
                        )}
                        size="sm"
                      />
                    </div>
                  )}

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

          {/* Player Seats */}
          {seatPositions.map((pos, idx) => {
            const seatNumber = idx + 1;
            const player = getPlayerAtSeat(seatNumber);

            return (
              <div
                key={seatNumber}
                className="seat-wrapper"
                style={{
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                }}
              >
                <SeatSlot
                  seatNumber={seatNumber}
                  player={player || null}
                  position={tableState.positions[idx] || null}
                  isActive={seatNumber === tableState.currentPlayerSeat}
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
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          BOTTOM CONTROLS + ACTION PANEL
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="action-panel-wrapper">
        {/* Spectator Mode - Show when user is not seated */}
        {!tableState.players[tableState.heroSeat - 1] ? (
          <div className="spectator-mode">
            <span className="spectator-mode__icon">👁</span>
            <span className="spectator-mode__text">
              {tableState.isTournament ? 'Observing tournament' : 'Click a seat to join'}
            </span>
          </div>
        ) : (
          <>
            {/* ─── CONTROL STRIP — Clean icon row above action buttons ─── */}
            {tableState.isHandInProgress && (
              <div className="control-strip">
                {/* Straddle Toggle rendered in footer area (line ~5162), not duplicated here */}

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
                {tableState.currentPlayerSeat === tableState.heroSeat && (
                  <div className="control-strip__timer">
                    <span className="control-strip__timer-val">{actionTimeRemaining || 0}s</span>
                  </div>
                )}

                {/* Spacer */}
                <div className="control-strip__spacer" />

                {/* Rabbit Hunt */}
                <button
                  className="control-strip__btn"
                  title="Rabbit Hunt"
                  onClick={() => {
                    if (isRabbitAvailable) handleRabbitReveal();
                  }}
                  disabled={!isRabbitAvailable}
                >
                  <span className="control-strip__icon">🐰</span>
                </button>

                {/* Chat Toggle */}
                <button
                  className={`control-strip__btn ${isChatMuted ? 'control-strip__btn--muted' : ''}`}
                  title="Chat"
                  onClick={() => setIsChatCollapsed(!isChatCollapsed)}
                >
                  <span className="control-strip__icon">💬</span>
                </button>
              </div>
            )}

            {/* ─── ACTION PANEL — PokerBros 3-button layout ─── */}
            {/* Quick Actions Bar — always available when seated */}
            <QuickActionsBar
              isSoundEnabled={isSoundEnabled}
              isChatVisible={!isChatCollapsed}
              isHandStrengthVisible={userSettings.showHUD}
              isStatsVisible={userSettings.showHUD}
              isAutoRebuyEnabled={isAutoRebuyEnabled}
              onToggleSound={() => setIsSoundEnabled((prev) => !prev)}
              onToggleChat={() => setIsChatCollapsed((prev) => !prev)}
              onToggleHandStrength={() => updateSetting('showHUD', !userSettings.showHUD)}
              onToggleStats={() => updateSetting('showHUD', !userSettings.showHUD)}
              onToggleAutoRebuy={() => {
                const next = !isAutoRebuyEnabled;
                setIsAutoRebuyEnabled(next);
                try {
                  localStorage.setItem('ca_auto_rebuy', String(next));
                } catch {
                  /* localStorage unavailable */
                }
              }}
              onOpenSettings={() => setShowSettings(true)}
            />

            {tableState.currentPlayerSeat === tableState.heroSeat && tableState.isHandInProgress
              ? (() => {
                  // [MIGRATION STEP 1] Use tableState instead of local engine state
                  const callAmount = tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0;
                  const heroStack = getPlayerAtSeat(tableState.heroSeat)?.stack || 0;
                  const bb = safeBB(tableState.blinds);
                  const minRaise = Math.max(bb * 2, callAmount + bb);

                  return (
                    <>
                      <ActionPanel
                        canFold={true}
                        canCheck={callAmount === 0}
                        canCall={callAmount > 0}
                        canRaise={heroStack >= minRaise}
                        canAllIn={heroStack > 0}
                        callAmount={callAmount}
                        minRaise={minRaise}
                        maxRaise={heroStack}
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

            {/* ─── PRE-ACTION BAR — Show when not hero's turn ─── */}
            {tableState.isHandInProgress &&
              tableState.currentPlayerSeat !== tableState.heroSeat && (
                <PreActionBar
                  canCheck={
                    // [MIGRATION STEP 1] Use tableState instead of local engine state
                    (tableState.lastBetAmounts?.[tableState.heroSeat - 1] || 0) === 0
                  }
                  isMyTurn={false}
                  preAction={preAction}
                  onPreActionChange={setPreAction}
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

      {/* Observing Mode Indicator (when not seated) */}
      {!tableState.players.some((p) => p?.isHero) && (
        <div className="observing-indicator">
          <span className="eye-icon">◉</span>
          <span>Observing</span>
        </div>
      )}

      {/* Table Chat */}
      <TableChat
        messages={chatMessages}
        onSendMessage={handleSendChatMessage}
        myPlayerId={userId}
        tableId={tableId}
        isCollapsed={isChatCollapsed}
        onToggleCollapse={() => setIsChatCollapsed(!isChatCollapsed)}
        placeholder="Say something..."
        isMuted={isChatMuted}
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
        variant={tableState.gameType || 'No Limit Hold\'em'}
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
        onReturn={() => setShowSitOut(false)}
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
          offer={insuranceOffer}
          timeRemaining={15}
        />
      )}

      {/* Run It Twice Prompt */}
      <RunItTwicePrompt
        isOpen={showRIT}
        onAccept={handleRITAccept}
        onDecline={handleRITDecline}
        timeRemaining={ritTimer}
        opponentName={ritOpponent}
      />

      {/* Hand Reveal DISABLED — no popup overlays after hands, auto-muck silently */}
      {/* Winner cards are shown directly on the seat during showdown */}

      {/* Bad Beat Jackpot Display */}
      <BadBeatJackpot amount={bbjAmount} qualifyingHand="Quad 8s or better" isHit={showBBJ} />

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
                  console.warn('[BuyIn] BLOCKED — user already seated at seat', existingSeat.seat_number);
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
                  console.error('[BuyIn] atomic_table_buyin FAILED:', rpcErr);
                  throw new Error('Failed to buy-in: ' + rpcErr.message);
                }

                // Validate RPC return data — the function returns {success, amount}
                const rpcResult = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData;
                if (rpcResult && rpcResult.success === false) {
                  console.error('[BuyIn] atomic_table_buyin returned failure:', rpcResult);
                  throw new Error('Buy-in rejected: ' + (rpcResult.error || 'Unknown server error'));
                }

                console.debug('[BuyIn] atomic_table_buyin SUCCESS:', rpcResult);

                setAccountBalance((prev) => Math.max(0, prev - amount));
                totalBuyInRef.current += amount; // Track initial buy-in for session P/L
                if (amount > peakStackRef.current) peakStackRef.current = amount; // Init peak stack

                // Add player to local table state (use functional updater to preserve
                // concurrent WebSocket updates during the async RPC call)
                setTableState((prev) => {
                  const updatedPlayers = [...prev.players];
                  updatedPlayers[selectedSeat - 1] = {
                    id: userId,
                    name: username || 'Player',
                    avatar: '',
                    stack: amount,
                    status: 'active',
                    isHero: true,
                    showCards: false,
                  };
                  return { ...prev, players: updatedPlayers, heroSeat: selectedSeat };
                });

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
                console.error('[BuyIn] Buy-in FAILED:', error);
                toast.error('Buy-in failed. Please try again or check your balance.');
              }
            } else {
              console.error('[BuyIn] FELL THROUGH - no branch matched:', {
                userId,
                isGuest: userId === 'guest',
                tableId,
                selectedSeat,
              });
              toast.error('Unable to complete buy-in. Please try again.');
            }
            setShowBuyInModal(false);
          } catch (outerErr) {
            console.error('[BuyIn] UNHANDLED error in onConfirm:', outerErr);
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
          return bb * 40;
        })()}
        maxBuyIn={(() => {
          const bb = safeBB(tableState.blinds);
          return bb * 100;
        })()}
        accountBalance={accountBalance}
        bigBlind={safeBB(tableState.blinds)}
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

      {/* Table Menu */}
      <TableMenu
        isOpen={showTableMenu}
        onClose={() => setShowTableMenu(false)}
        onToggle={() => setShowTableMenu((prev) => !prev)}
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
              {
                id: 'settings',
                label: 'Settings',
                icon: <SettingsIcon />,
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
          showHandStrength: userSettings.showHUD,
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
          if (settingsUpdate.showHandStrength !== undefined)
            updateSetting('showHUD', settingsUpdate.showHandStrength);
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
