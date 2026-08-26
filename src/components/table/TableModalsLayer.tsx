/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TableModalsLayer — All overlay/modal JSX for the poker table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx (was lines 6283–7082). Pure UI layer — receives
 * all state and callbacks as props, no game logic.
 *
 * Adding a new modal? Add it here, not to TablePage.tsx.
 */

import { useEffectiveRake } from '../../hooks/useEffectiveRake';
import PlayerNotesPanel from '../gameplay/PlayerNotesPanel';
import HandReplay from '../replay/HandReplay';
import { GameRulesModal } from './GameRulesModal';
import { ClubProfileModal } from './ClubProfileModal';
import SitOutModal from './SitOutModal';
import WaitListModal from './WaitListModal';
import { waitlistService } from '../../services/WaitlistService';
import InsuranceModal, { type InsuranceOffer } from './InsuranceModal';
import { RunItTwicePrompt, type RitResultData } from './RunItTwice';
import BadBeatJackpot from './BadBeatJackpot';
import { getBBJQualifyingInfo, getBBJPayoutPercentForBB } from '../../config/RakeConfig';
import BBJInfoModal from '../bbj/BBJInfoModal';
import { BBJCelebration } from './BBJCelebration';
import { ThrowableSelector } from './ThrowableSelector';
import type { ThrowEvent } from '../../services/ThrowableService';
import DiamondWalletModal from '../wallet/DiamondWalletModal';
import CashierModal from './CashierModal';
import BuyInModal from './BuyInModal';
import RabbitHunt from './RabbitHunt';
import type { RabbitHuntRevealResult } from './RabbitHunt';
import LeaderboardPanel from './LeaderboardPanel';
import LeaveTableConfirm from './LeaveTableConfirm';
import { SessionHUD } from './SessionHUD';
import RealTimeResultPanel from './RealTimeResultPanel';
/* Phase 2 2026-08-22: SessionAnalytics (the four-tab PokerCraft panel) was
   imported by TablePage and never rendered anywhere, which left the
   "Detailed Analytics" button RealTimeResultPanel supports permanently
   hidden — the panel's own header comment promised the deeper view was
   "still reachable" and it was not. It mounts here, behind that button. */
import SessionAnalytics from './SessionAnalytics';
import { sessionStatsService } from '../../services/SessionStatsService';
import SettingsPanel from './SettingsPanel';
import ShareHand from './ShareHand';
import AddOnModal from './AddOnModal';
import RebuyModal from './RebuyModal';
import TournamentBreakScreen from './TournamentBreakScreen';
import TournamentAnnouncementOverlay from './TournamentAnnouncementOverlay';
import TournamentWinnerOverlay from './TournamentWinnerOverlay';
import HandHistoryPanel, { type HandRecord } from './HandHistoryPanel';
import { ConfettiCanvas } from './ConfettiCanvas';
import { ParticleSystem } from './ParticleSystem';
import { useWallet } from '../../hooks';
// ChipAnimationManager is inline in TablePage — imported via parent
import { HandReveal } from './HandReveal';
import { BombPotOverlay } from './BombPotOverlay';
import { FinalTableOverlay } from '../tournament/FinalTableOverlay';
import { HeadsUpOverlay } from '../tournament/HeadsUpOverlay';
import { TableErrorBoundary } from '../common/TableErrorBoundary';
import { masterBus } from '../../core/MasterBus';
import { setSitOut } from '../../services/GameServerAPI';
import { roomService } from '../../services/RoomService';
import { reportError } from '../../utils/errorReporter';
import { tournamentService } from '../../services/TournamentService';
import { WalletService } from '../../services/WalletService';
import { type UserTableSettings } from '../../hooks/useUserTableSettings';
import type { SeatPlayer } from './SeatSlot';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TableModalsLayerProps {
  currentCardBack?: string;
  /* May be async and may reject: CardBackSelector only reports success once
     this has resolved, so a failed write cannot render as a success. */
  onCardBackChanged?: (id: string) => void | Promise<unknown>;
  // Core context
  tableId: string | undefined;
  userId: string;
  username: string;
  /**
   * IMPROVEMENT PASS 2026-08-20 (#175 multi-table gate): background tables
   * must not play the bomb-pot sequence's sounds or shake the screen.
   * TablePage passes its ambientSoundsAllowed. Defaults true.
   */
  ambientSoundsAllowed?: boolean;

  // Table state (minimal surface needed by modals)
  tableName: string;
  blinds: string;
  gameType: string;
  isTournament: boolean;
  tournamentId: string | undefined;
  maxPlayers: 6 | 9;
  players: (SeatPlayer | null)[];
  heroStack: number;
  rakePercent: number | undefined;
  rakeCap: number | undefined;
  runItTwice: boolean | undefined;
  isHandInProgress: boolean;
  /**
   * ─── ACCEPTED AND IGNORED (audit 2026-08-25) ──────────────────────────────
   * `boardStage`, `handNumber` and `buyInProcessingRef` below are declared
   * here, passed by TablePage on every render, and read by NOTHING in this
   * file — they are not in the destructuring block at the top of the
   * component. They are left declared rather than deleted because removing a
   * prop from this interface while TablePage still passes it is a TS2322 at
   * the call site, and TablePage belongs to another pass. The report for this
   * audit carries the verbatim removals for both files.
   * @deprecated unused by this layer
   */
  boardStage: string;
  /** @deprecated unused by this layer — see the note on boardStage */
  handNumber: number | undefined;

  // V8 Settings
  v8Settings: UserTableSettings;

  // User settings (for SettingsPanel)
  userSettings: {
    autoMuck: boolean;
    autoMuckWinners: boolean;
    autoPostBlinds: boolean;
    soundVolume: number;
    isHapticEnabled: boolean;
    showPotOdds: boolean;
    animationSpeed: number;
    fourColorDeck: boolean;
    confirmAllIn: boolean;
    theme: string;
    /* Added 2026-08-26. Its absence here is why the panel was fed a
       hard-coded `true` and the toggle could never render as off. */
    showBetSizePresets: boolean;
  };
  isSoundEnabled: boolean;
  sitOutNextHand: boolean;

  // Player Notes Modal
  showPlayerNotes: boolean;
  selectedPlayerForNotes: { id: string; name: string } | null;
  onClosePlayerNotes: () => void;

  // Hand Replay Modal
  showHandReplay: boolean;
  lastHandId: string | null;
  onCloseHandReplay: () => void;

  // Game Rules Modal
  showGameRules: boolean;
  isStraddleEnabled: boolean;
  /** Round 2 (double board): the table's bomb pot rules for the rules modal. */
  bombPotRules?: {
    enabled: boolean;
    frequency: number;
    anteBB: number;
    doubleBoard: boolean;
  } | null;
  onCloseGameRules: () => void;

  // Chip Animations
  chipAnimations: any[];
  onAnimationComplete: (id: string) => void;

  // Sit Out Modal
  showSitOut: boolean;
  /** Epoch ms when sit-out began, or null. See SitOutModal for why this is
   *  no longer a countdown. */
  sitOutSince: number | null;
  onCloseSitOut: () => void;
  onReturnFromSitOut: () => void;

  // Wait List Modal
  showWaitList: boolean;
  waitListPlayers: any[];
  onCloseWaitList: () => void;
  /** Sends the player to the cashier from a buy-in they cannot afford. */
  onTopUpAccount?: () => void;
  /** Surfaced when leaving the wait list is refused — the player is still queued. */
  onWaitListError?: (message: string) => void;

  // Insurance Modal
  showInsurance: boolean;
  insuranceOffer: InsuranceOffer | null;
  onInsuranceAccept: (amount?: number) => void;
  onInsuranceDecline: () => void;
  onInsuranceDeclineForHand: () => void;

  // Hand Reveal (show/muck)
  showHandRevealModal: boolean;
  handRevealWinnerId: string;
  handRevealWinnerName: string;
  handRevealCards: Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>;
  handRevealHandId: string;
  onHandRevealShow: () => void;
  onHandRevealMuck: () => void;
  onHandRevealClose: () => void;

  // Run It Twice
  showRIT: boolean;
  ritIsChooser: boolean;
  ritOpponent: string;
  ritTimer: number;
  ritChosenRuns: 2 | 3;
  ritMaxRuns: 2 | 3;
  ritPlayerCount: number;
  onRITChooserDecide: (runs: 1 | 2 | 3) => Promise<void>;
  onRITAccept: () => Promise<void>;
  onRITDecline: () => Promise<void>;
  ritResult: RitResultData | null;
  onRitResultClose: () => void;
  ritResolveName: (userId: string) => string;

  // Bad Beat Jackpot
  showBBJ: boolean;
  bbjAmount: number;
  /** Resolved BBJ pool id (union pool for union clubs) — for the details modal. */
  bbjPoolId?: string | null;
  /** Hero's display name, so their own payout row is highlighted. */
  bbjHeroName?: string | null;
  showBBJCelebration: boolean;
  bbjCelebrationData: {
    totalPayout: number;
    loser: { userId: string; username: string; share: number; handName: string };
    winner: { userId: string; username: string; share: number; handName: string };
    tableShare: number;
    perPlayerShare: number;
    tablePlayerCount: number;
    qualifyingLabel?: string;
    heroShare?: number;
  } | null;
  onBBJCelebrationComplete: () => void;

  // Throwables
  showThrowableSelector: boolean;
  activeThrows: ThrowEvent[];
  // Dan 2026-08-15 (item 4): `seatPositions` removed. The throw animation
  // layer moved into .table-scaler (TablePage) so it shares the seats' real
  // coordinate space; this layer no longer positions anything in table-space.
  onThrowableSelect: (throwable: any) => void;
  onThrowableClose: () => void;
  onThrowComplete: (id: string) => void;

  // Confetti / Particles
  showConfetti: boolean;
  winnerParticle: { active: boolean; origin: { x: number; y: number }; intensity: number };
  onConfettiComplete: () => void;
  onParticleComplete: () => void;

  // Leave Notice
  leaveNotice: string | null;
  onDismissLeaveNotice: () => void;

  // Diamond Wallet
  showDiamondWallet: boolean;
  onCloseDiamondWallet: () => void;

  // Cashier
  showCashier: boolean;
  accountBalance: number;
  cashoutMinBuyIn: number;
  /** @deprecated unused by this layer — see the note on boardStage */
  buyInProcessingRef: React.MutableRefObject<boolean>;
  onCloseCashier: () => void;
  /** Must report whether the chips actually moved — see CashierModal.onAddChips. */
  onAddChips: (amount: number) => Promise<boolean>;
  onWithdrawChips: (amount: number) => Promise<boolean>;

  // Bust Rebuy
  bustRebuyOpen: boolean;
  bustWalletBalance: number | null;
  /**
   * Audit 2026-08-25: also unread here, but for a different reason than the
   * three above — this one has real work to do and nowhere to do it. The bust
   * rebuy renders through BuyInModal, and BuyInModal has no `isProcessing`
   * prop at all (RebuyModal does, and gets one). So the confirm button on a
   * bust rebuy stays live while the buy-in is in flight and can be pressed
   * twice. The server's `atomic_table_buyin` is the guard that actually stops
   * a double buy-in; what the player loses is the feedback, not the chips.
   * Fixing it means adding `isProcessing` to BuyInModal, which is another
   * agent's file this pass — carried in the report instead.
   */
  bustRebuyProcessing: boolean;
  onCancelBustRebuy: () => void;
  onConfirmBustRebuy: (amount: number) => Promise<void>;

  showProfileModal: boolean;
  onCloseProfileModal: () => void;
  clubName?: string;
  // Buy-In Modal
  showBuyInModal: boolean;
  selectedSeat: number | null;
  heroAvatarUrl: string;
  /** Hero picked a new avatar from inside the settings panel. */
  onAvatarChanged?: (url: string) => void;
  onCloseBuyInModal: () => void;
  onConfirmBuyIn: (amount: number, autoRebuy?: boolean) => Promise<void>;

  // Rabbit Hunt
  isRabbitAvailable: boolean;
  /**
   * Cards a reveal will show, as counted by the SERVER. Replaces the old
   * `currentBoard` prop, which was only ever passed [] — so every reveal
   * claimed five cards regardless of the street the hand actually ended on.
   */
  rabbitCardsAvailable: number;
  /** Live diamond price from feature_pricing, delivered with the offer. */
  rabbitDiamondCost?: number | null;
  // One contract, declared once, in the component that consumes it. This shape
  // was written out inline here AND in TablePage AND in RabbitHunt — three
  // copies of the same object, which is three chances for them to drift.
  onRabbitReveal: () => Promise<RabbitHuntRevealResult>;

  // Leaderboard
  showLeaderboard: boolean;
  leaderboardPlayers: Array<{
    rank: number;
    playerId: string;
    playerName: string;
    avatar?: string;
    amount: number;
    isPositive: boolean;
    isCurrentUser?: boolean;
  }>;
  leaderboardPeriod: 'session' | 'day' | 'week' | 'month' | 'allTime';
  onCloseLeaderboard: () => void;
  onLeaderboardPeriodChange: (p: 'session' | 'day' | 'week' | 'month' | 'allTime') => void;

  // Leave Table
  showLeaveConfirm: boolean;
  onCloseLeaveConfirm: () => void;
  onConfirmLeaveTable: () => void;

  // Session Stats (2nd SessionHUD slot at bottom)
  showSessionStats: boolean;
  onCloseSessionStats: () => void;

  // Settings Panel
  showSettings: boolean;
  onCloseSettings: () => void;
  onSettingsChange: (
    update: Partial<{
      soundEnabled: boolean;
      soundVolume: number;
      autoMuckLosers: boolean;
      autoMuckWinners: boolean;
      autoPostBlinds: boolean;
      showPotOdds: boolean;
      animationSpeed: 'slow' | 'normal' | 'fast';
      fourColorDeck: boolean;
      showStackInBB: boolean;
      /* Added 2026-08-26 — the toggle existed in the panel and its value had
         nowhere to travel, so TablePage's handler could not have a branch for
         it even if someone had written one. */
      showBetSizePresets: boolean;
      confirmAllIn: boolean;
      sitOutNextHand: boolean;
      tableTheme: string;
      hapticEnabled: boolean;
    }>
  ) => void;

  // Share Hand
  showShareHand: boolean;
  sharedHandData: any;
  onCloseShareHand: () => void;

  // Tournament Add-On
  addOnPeriod: {
    active: boolean;
    addOnCost: number;
    addOnFee?: number;
    addOnChips: number;
    walletBalance: number;
    timeRemaining: number;
  };
  rebuyProcessing: boolean;
  /** Resolves false when the add-on was refused — see AddOnModal.onAccept. */
  onAddOnAccept: () => Promise<boolean>;
  onAddOnDecline: () => void;

  // Tournament Rebuy
  showRebuyModal: boolean;
  rebuyData: { cost: number; fee?: number; chips: number } | null;
  onConfirmRebuy: () => Promise<void>;
  onCloseRebuyModal: () => void;

  // Tournament Break
  tournamentBreak: {
    active: boolean;
    timeRemaining: number;
    nextLevel?: {
      level: number;
      smallBlind: number;
      bigBlind: number;
      ante?: number;
      duration: number;
    } | null;
  };

  // Tournament Announcement
  announcement: { type: string; data?: any } | null;
  onDismissAnnouncement: () => void;

  // Tournament Winner
  tournamentWinner: { prize: number; name: string } | null;
  onDismissTournamentWinner: () => void;

  // Hand History Panel
  showHandHistory: boolean;
  handHistory: HandRecord[];
  onCloseHandHistory: () => void;
  onReplay?: (hand: HandRecord) => void;

  /* Session Summary props REMOVED (Phase 2 audit 2026-08-22): the in-table
     SessionSummary modal was dead code — `showSessionSummary` was never set
     true anywhere after the app-root SessionSummaryHost (2026-08-18) took
     over the Session Complete card. Ten props existed solely to feed it. */

  // Session HUD (Cash games)
  showSessionHUD: boolean;
  onCloseSessionHUD: () => void;

  // Helpers
  safeBB: (blinds?: string | null, fallback?: number) => number;
  getPlayerHUDStats: (userId: string) => any;
}

// ─── Component ────────────────────────────────────────────────────────────────

import React from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';

export function TableModalsLayer(props: TableModalsLayerProps) {
  const { diamonds } = useWallet();
  const {
    currentCardBack,
    onCardBackChanged,
    tableId,
    userId,
    username,
    ambientSoundsAllowed = true,
    tableName,
    blinds,
    gameType,
    isTournament,
    tournamentId,
    maxPlayers,
    players,
    heroStack,
    rakePercent,
    rakeCap,
    runItTwice,
    isHandInProgress,
    v8Settings,
    userSettings,
    isSoundEnabled,
    sitOutNextHand,
    // Player Notes
    showPlayerNotes,
    selectedPlayerForNotes,
    onClosePlayerNotes,
    // Hand Replay
    showHandReplay,
    lastHandId,
    onCloseHandReplay,
    // Game Rules
    showGameRules,
    isStraddleEnabled,
    bombPotRules,
    onCloseGameRules,
    // Chips
    chipAnimations,
    onAnimationComplete,
    // Sit Out
    showSitOut,
    sitOutSince,
    onCloseSitOut,
    onReturnFromSitOut,
    // Wait List
    showWaitList,
    waitListPlayers,
    onCloseWaitList,
    onWaitListError,
    onTopUpAccount,
    // Insurance
    showInsurance,
    insuranceOffer,
    onInsuranceAccept,
    onInsuranceDecline,
    onInsuranceDeclineForHand,
    // Hand Reveal
    showHandRevealModal,
    handRevealWinnerId,
    handRevealWinnerName,
    handRevealCards,
    handRevealHandId,
    onHandRevealShow,
    onHandRevealMuck,
    onHandRevealClose,
    // RIT
    showRIT,
    ritResult,
    onRitResultClose,
    ritResolveName,
    ritIsChooser,
    ritOpponent: _ritOpponent,
    ritTimer,
    ritChosenRuns,
    ritMaxRuns,
    ritPlayerCount,
    onRITChooserDecide,
    onRITAccept,
    onRITDecline,
    // BBJ
    showBBJ,
    bbjAmount,
    bbjPoolId,
    bbjHeroName,
    showBBJCelebration,
    bbjCelebrationData,
    onBBJCelebrationComplete,
    // Throwables
    showThrowableSelector,
    activeThrows,
    onThrowableSelect,
    onThrowableClose,
    onThrowComplete,
    // Confetti
    showConfetti,
    winnerParticle,
    onConfettiComplete,
    onParticleComplete,
    // Tip
    // Leave Notice
    leaveNotice,
    onDismissLeaveNotice,
    // Diamond Wallet
    showDiamondWallet,
    onCloseDiamondWallet,
    // Cashier
    showCashier,
    accountBalance,
    cashoutMinBuyIn,
    onCloseCashier,
    onAddChips,
    onWithdrawChips,
    // Bust Rebuy
    bustRebuyOpen,
    bustWalletBalance,
    onCancelBustRebuy,
    onConfirmBustRebuy,
    showProfileModal,
    onCloseProfileModal,
    clubName,
    // Buy-In
    showBuyInModal,
    selectedSeat,
    heroAvatarUrl,
    onAvatarChanged,
    onCloseBuyInModal,
    onConfirmBuyIn,
    // Rabbit Hunt
    isRabbitAvailable,
    rabbitCardsAvailable,
    rabbitDiamondCost,
    onRabbitReveal,
    // Leaderboard
    showLeaderboard,
    leaderboardPlayers,
    leaderboardPeriod,
    onCloseLeaderboard,
    onLeaderboardPeriodChange,
    // Leave Confirm
    showLeaveConfirm,
    onCloseLeaveConfirm,
    onConfirmLeaveTable,
    // Session stats
    showSessionStats,
    onCloseSessionStats,
    // Settings
    showSettings,
    onCloseSettings,
    onSettingsChange,
    // Share Hand
    showShareHand,
    sharedHandData,
    onCloseShareHand,
    // Add-On
    addOnPeriod,
    rebuyProcessing,
    onAddOnAccept,
    onAddOnDecline,
    // Rebuy
    showRebuyModal,
    rebuyData,
    onConfirmRebuy,
    onCloseRebuyModal,
    // Tournament Break
    tournamentBreak,
    // Announcement
    announcement,
    onDismissAnnouncement,
    // Tournament Winner
    tournamentWinner,
    onDismissTournamentWinner,
    // Hand History
    showHandHistory,
    handHistory,
    onCloseHandHistory,
    onReplay,
    // Session HUD
    showSessionHUD,
    onCloseSessionHUD,
    // Helpers
    safeBB,
    getPlayerHUDStats,
  } = props;

  const toast = useToast();
  // We use local state for diamonds listening directly to MasterBus because useWalletStore is cached.
  const [localDiamonds, setLocalDiamonds] = React.useState(0);
  const [ownedCardBacks, setOwnedCardBacks] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!userId) return;
    let mounted = true;

    /* Audit 2026-08-25: both of these discarded `error`. A failed diamonds read
       leaves the balance at its initial 0 and SettingsPanel then tells the
       player they cannot afford a card back they CAN afford; a failed
       feature_purchases read leaves `ownedCardBacks` empty and offers to sell
       them a design they already own. Neither is recoverable from the UI, and
       neither left a trace anywhere. They still degrade rather than block — the
       panel is usable — but the failure is now reported. */
    supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          reportError(error, 'TableModalsLayer.diamondBalanceFetchFailed');
          return;
        }
        if (mounted && data) setLocalDiamonds(Number(data.diamonds) || 0);
      });

    // Fetch owned card backs from feature_purchases
    supabase
      .from('feature_purchases')
      .select('feature')
      .eq('user_id', userId)
      .like('feature', 'card_back_%')
      .then(({ data, error }) => {
        if (error) {
          reportError(error, 'TableModalsLayer.ownedCardBacksFetchFailed');
          return;
        }
        if (mounted && data) {
          setOwnedCardBacks(data.map((r: any) => r.feature.replace('card_back_', '')));
        }
      });

    // Listen to real-time diamond balance updates
    const off = masterBus.subscribe('DIAMOND_BALANCE_CHANGED', (e) => {
      const balance = (e as any).payload?.balance;
      if (typeof balance === 'number' && mounted) {
        setLocalDiamonds(balance);
      }
    });

    return () => {
      mounted = false;
      off();
    };
  }, [userId]);

  const handleCardBackPurchase = React.useCallback(
    async (id: string, price: number) => {
      if (!userId) return;

      const { data, error } = await supabase.rpc('fn_purchase_feature', {
        p_user_id: userId,
        p_feature: `card_back_${id}`,
        p_cost: price,
      });

      if (error || (data as any)?.success === false) {
        // THROW, do not just return. The store awaits this call to decide
        // whether to equip the design and congratulate the player; a silent
        // return let a FAILED purchase equip a card back the player does not
        // own and report it as bought.
        reportError(
          error || new Error('fn_purchase_feature returned success:false'),
          'TableModalsLayer.cardBackPurchaseFailed'
        );
        throw error || new Error('Card back purchase failed');
      }

      setLocalDiamonds((prev: number) => Math.max(0, prev - price));
      setOwnedCardBacks((prev: string[]) => [...prev, id]);
      // The equip toast comes from the store once the change has landed, so
      // this one only reports the purchase itself.
      toast.success('Card Back Purchased');
      await onCardBackChanged?.(id);
    },
    [userId, toast, onCardBackChanged]
  );

  // The rake the engine will actually take at this table (table override ->
  // club default -> published schedule). Only queried while the Game Rules
  // modal is open, since this layer is mounted for the whole session.
  const effectiveRake = useEffectiveRake(tableId, blinds, gameType, showGameRules);

  /**
   * ─── LEAVE NOTICE: THROUGH THE TOAST LAYER (audit 2026-08-25) ─────────────
   *
   * This used to be a hand-rolled `position: fixed` div with inline styles and
   * an OK button, rendered at the bottom of this layer. Two problems, one of
   * them a binding house rule (CLAUDE.md section 5.7): popup text renders with
   * The First Letter Of Every Word Capitalized and em dashes are forbidden,
   * enforced centrally in utils/popupStyle via the Toast provider — and the
   * rule ends "never bypass the Toast layer with a hand-rolled popup". This
   * was the bypass. TablePage's messages ("Error leaving table. Please try
   * again.") therefore reached the player in raw sentence case.
   *
   * The second problem is multi-table: `position: fixed` at `bottom: 80` with
   * `z-index: 9999`, rendered by whichever of up to four mounted TablePages
   * raised it. A hidden table's slot is `display: none` so it did not actually
   * paint, but the toast is the honest surface either way — it is deduped,
   * dismisses itself, and stacks with everything else the table says.
   *
   * `onDismissLeaveNotice` is still called, immediately, because the notice has
   * been handed off; leaving `leaveNotice` set would re-fire on every render.
   */
  React.useEffect(() => {
    if (!leaveNotice) return;
    toast.error(leaveNotice, 6000);
    onDismissLeaveNotice();
  }, [leaveNotice, toast, onDismissLeaveNotice]);

  // Per-variant BBJ qualifying rule for the table widget (2026-08-18).
  const bbjInfo = getBBJQualifyingInfo(gameType);
  // Tapping the jackpot banner opens the last-5-jackpots view (Dan, 2026-08-18).
  const [showBBJDetails, setShowBBJDetails] = React.useState(false);
  // Phase 2 2026-08-22: the deeper analytics panel behind RealTimeResultPanel's
  // "Detailed Analytics" button. Local state — nothing outside this layer
  // needs to open it.
  const [showDetailedAnalytics, setShowDetailedAnalytics] = React.useState(false);

  return (
    <>
      {/* Player Notes Modal */}
      {showPlayerNotes && (
        <div className="player-notes-overlay" onClick={onClosePlayerNotes}>
          <div className="player-notes-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={onClosePlayerNotes}>
              ✕
            </button>
            <PlayerNotesPanel
              targetUserId={selectedPlayerForNotes?.id}
              targetName={selectedPlayerForNotes?.name}
              onClose={onClosePlayerNotes}
            />
          </div>
        </div>
      )}

      {/* Hand Replay Modal */}
      {showHandReplay && (
        <div
          className="hand-replay-overlay"
          onClick={onCloseHandReplay}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
          }}
        >
          <div
            className="hand-replay-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              height: '100%',
              maxWidth: '100vw',
              maxHeight: '100vh',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <button className="modal-close" onClick={onCloseHandReplay}>
              ✕
            </button>
            {lastHandId ? (
              <HandReplay handId={lastHandId} onClose={onCloseHandReplay} />
            ) : (
              <div className="no-hand-history">
                <span className="empty-icon">♠</span>
                <p>No Recent Hand To Replay</p>
                <p className="hint">Complete A Hand To View Its Replay</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Game Rules Modal */}
      <GameRulesModal
        isOpen={showGameRules}
        onClose={onCloseGameRules}
        variant={gameType || "No Limit Hold'em"}
        stakes={blinds || '1/2'}
        minBuyIn={safeBB(blinds) * 40}
        maxBuyIn={safeBB(blinds) * 100}
        rakePercentage={effectiveRake.rakePercent ?? rakePercent}
        rakeCap={effectiveRake.rakeCap ?? rakeCap}
        isStraddleEnabled={!isTournament && isStraddleEnabled}
        isRunItTwiceEnabled={runItTwice ?? true}
        bombPotRules={bombPotRules}
      />

      {/* Chip Animations - pass-through to parent's ChipAnimationManager */}
      {/* Note: TablePage renders ChipAnimationManager directly before this layer */}

      {/* Sit Out Modal */}
      <SitOutModal
        isOpen={showSitOut}
        onClose={onCloseSitOut}
        /**
         * 2026-08-20: this closed the modal FIRST and then fired a
         * `.catch()`-guarded sit-in. `GameServerAPI.setSitOut` never throws —
         * it resolves `{ success: false, error }` — so a refused sit-in was
         * completely silent and the player was returned to a felt they were
         * still sitting out of. Close only after the server agrees.
         */
        onReturn={() => {
          if (!tableId) {
            onReturnFromSitOut();
            return;
          }
          void setSitOut(tableId, false).then((res) => {
            if (res?.success) {
              onReturnFromSitOut();
            } else {
              reportError(
                new Error(res?.error || 'setSitOut(false) rejected by engine'),
                'TableModalsLayer.Return_failed'
              );
            }
          });
        }}
        /**
         * 2026-08-20: was `() => navigate('/')`. "Leave Table" navigated away
         * without ever leaving the table — no cash-out, no seat release. The
         * player's chips stayed locked in a seat they had walked away from, and
         * the blinds kept coming. `onConfirmLeaveTable` is the real path, and it
         * was already being passed into this component for the other exit.
         */
        onLeaveTable={onConfirmLeaveTable}
        sitOutSince={sitOutSince}
        tableName={tableName}
      />

      {/* Wait List Modal */}
      <WaitListModal
        isOpen={showWaitList}
        onClose={onCloseWaitList}
        tableName={tableName}
        blinds={blinds}
        players={waitListPlayers}
        myPlayerId={userId}
        /**
         * 2026-08-20: this was `onCloseWaitList` — the confirm button and the
         * cancel button did exactly the same thing. A player who confirmed
         * "leave the wait list" stayed queued and could be called to a table
         * they had walked away from. `waitlistService.leaveWaitlist` existed
         * the whole time with zero callers in the table UI.
         */
        onLeaveWaitList={() => {
          if (!tableId) {
            onCloseWaitList();
            return;
          }
          // `leaveWaitlist` never throws — it reports its own Supabase error and
          // resolves. The old `.catch(...).finally(close)` was therefore dead
          // code wrapped around an unconditional close: the modal shut as though
          // the player had left the queue whether or not the row was cancelled.
          void waitlistService.leaveWaitlist(tableId).then((res) => {
            if (res?.success) {
              onCloseWaitList();
              return;
            }
            reportError(
              new Error(res?.error || 'leaveWaitlist failed'),
              'TableModalsLayer.Leave_waitlist_failed'
            );
            // Stay open. Closing here is what put players back in a queue they
            // believed they had left.
            onWaitListError?.(
              res?.error || 'Could not leave the wait list - you are still queued.'
            );
          });
        }}
      />

      {/* Insurance Modal */}
      {insuranceOffer && (
        <InsuranceModal
          isOpen={showInsurance}
          onClose={onInsuranceDecline}
          onAccept={onInsuranceAccept}
          onDecline={onInsuranceDecline}
          onDeclineForHand={onInsuranceDeclineForHand}
          offer={insuranceOffer}
          timeRemaining={15}
        />
      )}

      {/* Bible V8 §4.19: Show/Muck prompt when hero wins without showdown */}
      {showHandRevealModal && tableId && (
        <HandReveal
          isOpen={showHandRevealModal}
          isWinner={handRevealWinnerId === userId}
          winnerId={handRevealWinnerId}
          winnerName={handRevealWinnerName}
          revealedCards={handRevealCards as any}
          tableId={tableId}
          handId={handRevealHandId}
          autoMuckTimer={6}
          onShow={() => {
            if (tableId && userId) {
              roomService.sendChat(tableId, userId, '[SHOW_CARDS]');
            }
            onHandRevealShow();
          }}
          onMuck={onHandRevealMuck}
          onClose={onHandRevealClose}
        />
      )}

      {/* Run It Twice Prompt */}
      <RunItTwicePrompt
        isOpen={showRIT}
        isChooser={ritIsChooser}
        onChooserDecide={onRITChooserDecide}
        onAccept={onRITAccept}
        onDecline={onRITDecline}
        timeRemaining={ritTimer}
        chosenRuns={ritChosenRuns}
        maxRuns={ritMaxRuns}
        playerCount={ritPlayerCount}
        opponentName={_ritOpponent}
      />

      {/* Bad Beat Jackpot Display — per-variant qualifying rule (2026-08-18).
          Hidden entirely for variants the server never pays (PLO6, Short Deck),
          and never displayed during MTT, Spins, or Heads-Up games. */}
      {bbjInfo.eligible &&
        !isTournament &&
        !tournamentId &&
        maxPlayers > 2 &&
        gameType !== 'heads_up' &&
        gameType !== 'hu' &&
        gameType !== 'spin' &&
        gameType !== 'spins' && (
          <BadBeatJackpot
            amount={bbjAmount}
            qualifyingHand={bbjInfo.shortLabel}
            subText={bbjInfo.subLabel}
            payoutPercent={getBBJPayoutPercentForBB(safeBB(blinds))}
            isHit={showBBJ}
            onOpenDetails={() => setShowBBJDetails(true)}
          />
        )}

      {/* Last 5 jackpots + what this table pays */}
      <BBJInfoModal
        isOpen={showBBJDetails}
        onClose={() => setShowBBJDetails(false)}
        poolId={bbjPoolId ?? null}
        poolAmount={bbjAmount}
        gameType={gameType}
        bigBlind={safeBB(blinds)}
        currentUserName={bbjHeroName}
        currentUserId={userId}
      />

      {/* BBJ Celebration Overlay */}
      {bbjCelebrationData && (
        <BBJCelebration
          visible={showBBJCelebration}
          totalPayout={bbjCelebrationData.totalPayout}
          loser={bbjCelebrationData.loser}
          winner={bbjCelebrationData.winner}
          tableShare={bbjCelebrationData.tableShare}
          perPlayerShare={bbjCelebrationData.perPlayerShare}
          tablePlayerCount={bbjCelebrationData.tablePlayerCount}
          qualifyingLabel={bbjCelebrationData.qualifyingLabel}
          heroShare={bbjCelebrationData.heroShare}
          /* Audit 2026-08-25 (multi-table): a BBJ hit at a BACKGROUND table fired
             a 10-second fanfare plus a reveal sting over whatever table the
             player was actually looking at. `display: none` hides the overlay;
             it does not silence the Web Audio API. Same gate BombPotOverlay
             already uses. */
          soundsAllowed={ambientSoundsAllowed}
          onComplete={onBBJCelebrationComplete}
        />
      )}

      {/* Bomb Pot Overlay */}
      {tableId && (
        <TableErrorBoundary componentName="BombPotOverlay">
          <BombPotOverlay tableId={tableId} playSounds={ambientSoundsAllowed} />
        </TableErrorBoundary>
      )}

      {/* Final Table Overlay (tournament only) */}
      {tableId && isTournament && tournamentId && (
        <FinalTableOverlay
          tournamentId={tournamentId}
          tournamentName={tableName || 'Tournament'}
          hudStatsProvider={(uid) => {
            const stats = getPlayerHUDStats(uid);
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
      {tableId && isTournament && tournamentId && (
        <HeadsUpOverlay tournamentId={tournamentId} tournamentName={tableName || 'Tournament'} />
      )}

      {/* Throwable Selector */}
      {showThrowableSelector && userId && v8Settings.emoji_enabled && (
        <div className="throwable-selector-overlay" onClick={onThrowableClose}>
          <ThrowableSelector
            userId={userId}
            onSelect={onThrowableSelect}
            onClose={onThrowableClose}
          />
        </div>
      )}

      {/* Dan 2026-08-15 (item 4): ThrowAnimationContainer used to render HERE,
          but this layer is a SIBLING of .table-scaler, so the container's
          `position:absolute; inset:0` resolved against the wrong ancestor and
          seat coordinates landed nowhere near the avatars. It now mounts
          inside .table-scaler in TablePage, sharing the seats' own geometry.
          The throwable SELECTOR stays here — it is a modal, not table-space. */}

      {/* Bible V8 §5.1: Tiered winner celebration */}
      <ConfettiCanvas
        active={showConfetti}
        duration={3500}
        count={55}
        onComplete={onConfettiComplete}
      />
      <ParticleSystem
        active={winnerParticle.active}
        mode="sparks"
        origin={winnerParticle.origin}
        duration={1800}
        count={40}
        intensity={winnerParticle.intensity}
        onComplete={onParticleComplete}
      />

      {/* Leave Table Notice — see the effect above; it is a toast now. */}

      {/* Diamond Wallet Modal */}
      <DiamondWalletModal isOpen={showDiamondWallet} onClose={onCloseDiamondWallet} />

      {/* Bust Rebuy Modal */}

      {/* Cashier Modal */}
      <CashierModal
        isOpen={showCashier}
        onClose={onCloseCashier}
        // Passed straight through. Wrapping these in `async (a) => { await f(a) }`
        // is what threw the success flag away originally.
        onAddChips={onAddChips}
        onWithdrawChips={onWithdrawChips}
        currentStack={heroStack}
        accountBalance={accountBalance}
        minBuyIn={safeBB(blinds) * 40}
        maxBuyIn={safeBB(blinds) * 100}
        maxStack={safeBB(blinds) * 200}
      />
      <BuyInModal
        isOpen={bustRebuyOpen}
        onClose={onCancelBustRebuy}
        onConfirm={async (amount: number) => {
          await onConfirmBustRebuy(amount);
        }}
        tableName={tableName}
        minBuyIn={safeBB(blinds) * 40}
        maxBuyIn={safeBB(blinds) * 100}
        accountBalance={bustWalletBalance ?? 0}
        bigBlind={safeBB(blinds)}
        countdown={undefined}
        onTopUp={onTopUpAccount}
      />

      {/* Buy-In Modal */}
      <BuyInModal
        isOpen={showBuyInModal}
        onClose={onCloseBuyInModal}
        onConfirm={onConfirmBuyIn}
        tableName={tableName}
        minBuyIn={(() => {
          const bb = safeBB(blinds);
          const standardMin = bb * 40;
          return cashoutMinBuyIn > standardMin ? cashoutMinBuyIn : standardMin;
        })()}
        maxBuyIn={safeBB(blinds) * 100}
        accountBalance={accountBalance}
        bigBlind={safeBB(blinds)}
        cashoutRestriction={cashoutMinBuyIn > 0 ? cashoutMinBuyIn : undefined}
        onTopUp={onTopUpAccount}
      />

      {/* Rabbit Hunt (post-hand) */}
      {!isHandInProgress && isRabbitAvailable && (
        <RabbitHunt
          isAvailable={isRabbitAvailable}
          cardsAvailable={rabbitCardsAvailable}
          rabbitDiamondCost={rabbitDiamondCost}
          onReveal={onRabbitReveal}
        />
      )}

      {/* Leaderboard Panel */}
      <LeaderboardPanel
        isOpen={showLeaderboard}
        onClose={onCloseLeaderboard}
        title="Session Leaderboard"
        players={leaderboardPlayers}
        period={leaderboardPeriod}
        onPeriodChange={onLeaderboardPeriodChange}
      />

      {/* Leave Table Confirmation */}
      <LeaveTableConfirm
        isOpen={showLeaveConfirm}
        currentStack={heroStack}
        tableName={tableName || 'this table'}
        isTournament={isTournament}
        onConfirm={() => {
          onCloseLeaveConfirm();
          onConfirmLeaveTable();
        }}
        onCancel={onCloseLeaveConfirm}
      />

      {/* ── In-game stats card ──
          Dan 2026-08-20, with a reference: "the stats card when you click the
          in game stats card should look more like this and have these stats
          inside of it." SESSION_STATS used to open SessionHUD; it now opens the
          REAL TIME RESULT ledger, which answers the flat factual questions a
          player actually opens this for — how long the table has run, the real
          blinds, what they have in, what they are up or down. Same props, so it
          is a drop-in. */}
      {tableId && userId !== 'guest' && (
        <RealTimeResultPanel
          isOpen={showSessionStats}
          onClose={onCloseSessionStats}
          tableId={tableId}
          userId={userId}
          initialStack={heroStack}
          bigBlind={safeBB(blinds)}
          onOpenDetailed={() => setShowDetailedAnalytics(true)}
        />
      )}

      {/* Detailed Analytics — the four-tab panel behind the button above. */}
      {tableId && showDetailedAnalytics && sessionStatsService.getStats(tableId) && (
        <SessionAnalytics
          isOpen={showDetailedAnalytics}
          onClose={() => setShowDetailedAnalytics(false)}
          stats={sessionStatsService.getStats(tableId)!}
        />
      )}

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={onCloseSettings}
        settings={{
          autoMuckLosers: userSettings.autoMuck,
          autoMuckWinners: userSettings.autoMuckWinners,
          autoPostBlinds: userSettings.autoPostBlinds,
          soundEnabled: isSoundEnabled,
          soundVolume: userSettings.soundVolume,
          hapticEnabled: userSettings.isHapticEnabled,
          showPotOdds: userSettings.showPotOdds,
          /* --animation-speed is a DURATION MULTIPLIER: bigger = slower
             (utils/animationSpeed.ts, and `calc(0.4s * var(--animation-speed))`
             throughout the stylesheets). This read-back had it INVERTED —
             0.5 was shown as "slow" and 1.5 as "fast" — matching an equally
             inverted write in TablePage. The pair was self-consistent and
             backwards: picking "Slow" halved every duration, and /settings,
             which maps it correctly, then displayed the opposite word for the
             same stored value. Both ends corrected 2026-08-26. */
          animationSpeed:
            userSettings.animationSpeed >= 1.5
              ? 'slow'
              : userSettings.animationSpeed <= 0.5
                ? 'fast'
                : 'normal',
          fourColorDeck: userSettings.fourColorDeck,
          showStackInBB: v8Settings.show_stack_in_bb,
          /* Was a hard-coded `true`, so the toggle could never render as off
             and flipping it changed nothing. It reads the stored setting now,
             and TablePage's handler has a branch for it. */
          showBetSizePresets: userSettings.showBetSizePresets,
          confirmAllIn: userSettings.confirmAllIn,
          sitOutNextHand,
          tableTheme: userSettings.theme,
        }}
        /* The avatar row in this panel rendered a generated stand-in and told
           nobody when the picture changed, because neither prop was passed.
           Now it shows what the hero is actually wearing, and a change from
           inside the panel repaints the felt through the same path the
           gallery uses everywhere else. */
        currentAvatarUrl={heroAvatarUrl}
        onAvatarChanged={onAvatarChanged}
        onSettingsChange={onSettingsChange}
        userId={userId}
        userDiamonds={localDiamonds}
        ownedCardBacks={ownedCardBacks}
        onCardBackPurchase={handleCardBackPurchase}
        currentCardBack={currentCardBack}
        onCardBackChanged={onCardBackChanged}
      />

      {/* Share Hand */}
      {showShareHand && sharedHandData && (
        <ShareHand isOpen={showShareHand} onClose={onCloseShareHand} hand={sharedHandData} />
      )}

      {/* Tournament Add-On Modal */}
      {isTournament && addOnPeriod.active && (
        <AddOnModal
          isVisible={addOnPeriod.active}
          addOnCost={addOnPeriod.addOnCost}
          addOnFee={addOnPeriod.addOnFee ?? 0}
          addOnChips={addOnPeriod.addOnChips}
          walletBalance={addOnPeriod.walletBalance}
          timeRemaining={addOnPeriod.timeRemaining}
          onAccept={onAddOnAccept}
          onDecline={onAddOnDecline}
        />
      )}

      {/* Tournament Rebuy Modal */}
      {rebuyData && (
        <RebuyModal
          isOpen={showRebuyModal}
          rebuyCost={rebuyData.cost}
          rebuyFee={rebuyData.fee ?? 0}
          rebuyChips={rebuyData.chips}
          walletBalance={accountBalance || 0}
          onConfirm={onConfirmRebuy}
          onClose={onCloseRebuyModal}
          isProcessing={rebuyProcessing}
        />
      )}

      {/* Tournament Break Screen */}
      {isTournament && (
        <TournamentBreakScreen
          isVisible={tournamentBreak.active}
          breakTimeRemaining={tournamentBreak.timeRemaining}
          tournamentName={tableName}
          currentLevel={0}
          nextLevel={
            tournamentBreak.nextLevel || { level: 1, smallBlind: 0, bigBlind: 0, duration: 0 }
          }
          playersRemaining={players.filter(Boolean).length}
          totalPlayers={maxPlayers}
          averageStack={
            players.filter(Boolean).reduce((s, p) => s + (p?.stack || 0), 0) /
            Math.max(players.filter(Boolean).length, 1)
          }
          topPlayers={[]}
          prizePool={0}
        />
      )}

      {/* Tournament Announcement Overlay */}
      {isTournament && (
        <TournamentAnnouncementOverlay
          type={announcement?.type as any}
          data={announcement?.data}
          onDismiss={onDismissAnnouncement}
        />
      )}

      {/* Tournament Winner Overlay */}
      {isTournament && tournamentWinner && (
        <TournamentWinnerOverlay
          isWinner={true}
          prize={tournamentWinner.prize}
          tournamentName={tournamentWinner.name}
          onDismiss={onDismissTournamentWinner}
        />
      )}

      {/* Hand History Panel */}
      <HandHistoryPanel
        isOpen={showHandHistory}
        onClose={onCloseHandHistory}
        hands={handHistory}
        heroId={userId || ''}
        onReplay={onReplay}
      />

      {/* Session Summary modal REMOVED (Phase 2 audit 2026-08-22). It could
          never render: no code path ever set showSessionSummary true. The
          Session Complete card lives in SessionSummaryHost at the app root,
          fed by services/pendingSessionSummary — see that file's header. */}

      {/* Session HUD Modal (Cash Games Only) */}
      {!isTournament && tableId && userId !== 'guest' && (
        <TableErrorBoundary componentName="SessionHUD">
          <SessionHUD
            isOpen={showSessionHUD}
            onClose={onCloseSessionHUD}
            tableId={tableId}
            userId={userId}
            initialStack={heroStack}
            bigBlind={safeBB(blinds)}
          />
        </TableErrorBoundary>
      )}

      {/* Club Profile Modal */}
      <ClubProfileModal
        isOpen={showProfileModal}
        onClose={onCloseProfileModal}
        userId={userId}
        username={username}
        avatarUrl={heroAvatarUrl}
        clubName={clubName}
      />
    </>
  );
}

export default TableModalsLayer;
