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

import { useNavigate } from 'react-router-dom';
import { useEffectiveRake } from '../../hooks/useEffectiveRake';
import PlayerNotesPanel from '../gameplay/PlayerNotesPanel';
import HandReplay from '../replay/HandReplay';
import { GameRulesModal } from './GameRulesModal';
import SitOutModal from './SitOutModal';
import WaitListModal from './WaitListModal';
import { waitlistService } from '../../services/WaitlistService';
import InsuranceModal, { type InsuranceOffer } from './InsuranceModal';
import { RunItTwicePrompt, RunItTwiceResult, type RitResultData } from './RunItTwice';
import BadBeatJackpot from './BadBeatJackpot';
import { getBBJQualifyingInfo, getBBJPayoutPercentForBB } from '../../config/RakeConfig';
import BBJInfoModal from '../bbj/BBJInfoModal';
import { BBJCelebration } from './BBJCelebration';
import { ThrowableSelector } from './ThrowableSelector';
import type { ThrowEvent } from '../../services/ThrowableService';
import TipDealer from './TipDealer';
import DiamondWalletModal from '../wallet/DiamondWalletModal';
import CashierModal from './CashierModal';
import BuyInModal from './BuyInModal';
import RabbitHunt from './RabbitHunt';
import LeaderboardPanel from './LeaderboardPanel';
import LeaveTableConfirm from './LeaveTableConfirm';
import { SessionHUD } from './SessionHUD';
import SettingsPanel from './SettingsPanel';
import ShareHand from './ShareHand';
import AddOnModal from './AddOnModal';
import RebuyModal from './RebuyModal';
import TournamentBreakScreen from './TournamentBreakScreen';
import TournamentAnnouncementOverlay from './TournamentAnnouncementOverlay';
import TournamentWinnerOverlay from './TournamentWinnerOverlay';
import HandHistoryPanel, { type HandRecord } from './HandHistoryPanel';
import SessionSummary from './SessionSummary';
import { ConfettiCanvas } from './ConfettiCanvas';
import { ParticleSystem } from './ParticleSystem';
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
  // Core context
  tableId: string | undefined;
  userId: string;
  username: string;

  // Table state (minimal surface needed by modals)
  tableName: string;
  blinds: string;
  gameType: string;
  isTournament: boolean;
  tournamentId: string | undefined;
  heroSeat: number;
  maxPlayers: 6 | 9;
  players: (SeatPlayer | null)[];
  heroStack: number;
  rakePercent: number | undefined;
  rakeCap: number | undefined;
  runItTwice: boolean | undefined;
  isHandInProgress: boolean;
  boardStage: string;
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

  // Tip Dealer
  showTipDealer: boolean;
  onTipDealer: (amount: number) => void | Promise<void>;
  onCloseTipDealer: () => void;

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
  buyInProcessingRef: React.MutableRefObject<boolean>;
  onCloseCashier: () => void;
  onAddChips: (amount: number) => Promise<boolean | void> | boolean | void;
  onWithdrawChips: (amount: number) => Promise<boolean | void> | boolean | void;

  // Bust Rebuy
  bustRebuyOpen: boolean;
  bustWalletBalance: number | null;
  bustRebuyProcessing: boolean;
  onCancelBustRebuy: () => void;
  onConfirmBustRebuy: (amount: number) => Promise<void>;

  // Buy-In Modal
  showBuyInModal: boolean;
  selectedSeat: number | null;
  heroAvatarUrl: string;
  onCloseBuyInModal: () => void;
  onConfirmBuyIn: (amount: number, autoRebuy?: boolean) => Promise<void>;

  // Rabbit Hunt
  isRabbitAvailable: boolean;
  currentBoard: Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>;
  onRabbitReveal: () => Promise<Array<{ rank: string; suit: 'h' | 'd' | 'c' | 's' }>>;

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
  onAddOnAccept: () => Promise<boolean | void>;
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

  // Session Summary
  showSessionSummary: boolean;
  sessionStartTime: number;
  handsPlayed: number;
  handsWon: number;
  totalRebuys: number;
  sessionPL: number;
  biggestPot: number;
  peakStack: number;
  onCloseSessionSummary: () => void;
  onResetSessionRefs: () => void;

  // Session HUD (Cash games)
  showSessionHUD: boolean;
  onCloseSessionHUD: () => void;

  // Helpers
  safeBB: (blinds?: string | null, fallback?: number) => number;
  getPlayerHUDStats: (userId: string) => any;

  // Navigation
  navigate: ReturnType<typeof useNavigate>;
}

// ─── Component ────────────────────────────────────────────────────────────────

import React from 'react';

export function TableModalsLayer(props: TableModalsLayerProps) {
  const {
    tableId,
    userId,
    tableName,
    blinds,
    gameType,
    isTournament,
    tournamentId,
    heroSeat,
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
    showTipDealer,
    onTipDealer,
    onCloseTipDealer,
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
    // Buy-In
    showBuyInModal,
    onCloseBuyInModal,
    onConfirmBuyIn,
    // Rabbit Hunt
    isRabbitAvailable,
    currentBoard,
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
    // Session Summary
    showSessionSummary,
    sessionStartTime,
    handsPlayed,
    handsWon,
    totalRebuys,
    sessionPL,
    biggestPot,
    peakStack,
    onCloseSessionSummary,
    onResetSessionRefs,
    // Session HUD
    showSessionHUD,
    onCloseSessionHUD,
    // Helpers
    safeBB,
    getPlayerHUDStats,
    navigate,
  } = props;

  // The rake the engine will actually take at this table (table override ->
  // club default -> published schedule). Only queried while the Game Rules
  // modal is open, since this layer is mounted for the whole session.
  const effectiveRake = useEffectiveRake(tableId, blinds, gameType, showGameRules);

  // Per-variant BBJ qualifying rule for the table widget (2026-08-18).
  const bbjInfo = getBBJQualifyingInfo(gameType);
  // Tapping the jackpot banner opens the last-5-jackpots view (Dan, 2026-08-18).
  const [showBBJDetails, setShowBBJDetails] = React.useState(false);

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
        <div className="player-notes-overlay" onClick={onCloseHandReplay}>
          <div
            className="player-notes-modal hand-replay-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" onClick={onCloseHandReplay}>
              ✕
            </button>
            {lastHandId ? (
              <HandReplay handId={lastHandId} onClose={onCloseHandReplay} />
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
        onClose={onCloseGameRules}
        variant={gameType || "No Limit Hold'em"}
        stakes={blinds || '1/2'}
        minBuyIn={safeBB(blinds) * 40}
        maxBuyIn={safeBB(blinds) * 100}
        rakePercentage={effectiveRake.rakePercent ?? rakePercent}
        rakeCap={effectiveRake.rakeCap ?? rakeCap}
        isStraddleEnabled={!isTournament && isStraddleEnabled}
        isRunItTwiceEnabled={runItTwice ?? true}
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
          void waitlistService
            .leaveWaitlist(tableId)
            .catch((e) => reportError(e, 'TableModalsLayer.Leave_waitlist_failed'))
            .finally(() => onCloseWaitList());
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

      {/* Run It Twice result — the boards and payouts (2026-08-18) */}
      <RunItTwiceResult
        isOpen={ritResult !== null}
        data={ritResult}
        resolveName={ritResolveName}
        onClose={onRitResultClose}
      />

      {/* Bad Beat Jackpot Display — per-variant qualifying rule (2026-08-18).
          Hidden entirely for variants the server never pays (PLO6, Short Deck):
          advertising a jackpot that cannot hit is worse than no banner. */}
      {bbjInfo.eligible && (
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
          onComplete={onBBJCelebrationComplete}
        />
      )}

      {/* Bomb Pot Overlay */}
      {tableId && (
        <TableErrorBoundary componentName="BombPotOverlay">
          <BombPotOverlay tableId={tableId} />
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

      {/* Tip Dealer Modal */}
      <TipDealer
        isOpen={showTipDealer}
        onClose={onCloseTipDealer}
        onTip={onTipDealer}
        balance={heroStack}
      />

      {/* Leave Table Notice */}
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
            onClick={onDismissLeaveNotice}
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
      <DiamondWalletModal isOpen={showDiamondWallet} onClose={onCloseDiamondWallet} />

      {/* Bust Rebuy Modal */}

      {/* Cashier Modal */}
      <CashierModal
        isOpen={showCashier}
        onClose={onCloseCashier}
        // The success flag has to survive this hop — the old wrappers awaited
        // and then threw the result away, so the cashier could never tell a
        // refused top-up from a completed one and always closed as if it worked.
        onAddChips={async (amount: number) => await onAddChips(amount)}
        onWithdrawChips={async (amount: number) => await onWithdrawChips(amount)}
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
      />

      {/* Rabbit Hunt (post-hand) */}
      {!isHandInProgress && isRabbitAvailable && (
        <RabbitHunt
          isAvailable={isRabbitAvailable}
          onReveal={onRabbitReveal}
          currentBoard={currentBoard}
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
        onConfirm={() => {
          onCloseLeaveConfirm();
          onConfirmLeaveTable();
        }}
        onCancel={onCloseLeaveConfirm}
      />

      {/* Session Stats Modal (Cash Games) */}
      {tableId && userId !== 'guest' && (
        <SessionHUD
          isOpen={showSessionStats}
          onClose={onCloseSessionStats}
          tableId={tableId}
          userId={userId}
          initialStack={heroStack}
          bigBlind={safeBB(blinds)}
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
          animationSpeed:
            userSettings.animationSpeed === 0.5
              ? 'slow'
              : userSettings.animationSpeed === 1.5 || userSettings.animationSpeed === 2
                ? 'fast'
                : 'normal',
          fourColorDeck: userSettings.fourColorDeck,
          showStackInBB: v8Settings.show_stack_in_bb,
          showBetSizePresets: true,
          confirmAllIn: userSettings.confirmAllIn,
          sitOutNextHand,
          tableTheme: userSettings.theme,
        }}
        onSettingsChange={onSettingsChange}
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
      />

      {/* Session Summary Modal */}
      {showSessionSummary && (
        <SessionSummary
          duration={Math.floor((Date.now() - sessionStartTime) / 1000)}
          handsPlayed={handsPlayed}
          handsWon={handsWon}
          totalRebuys={totalRebuys}
          profitLoss={sessionPL}
          biggestPot={biggestPot}
          peakStack={peakStack}
          onClose={() => {
            onResetSessionRefs();
            onCloseSessionSummary();
            masterBus.emit('TABLE_LEFT', { tableId: tableId ?? '', seat: heroSeat });
            masterBus.emit('SESSION_SUMMARY_DISMISSED', { tableId: tableId ?? '' });
            /* Dan 2026-08-19: leaving must land you in the LOBBY. In
               multi-table mode the path is /hub/club-arena (no "/table/"), so
               the old guard skipped the navigation and left the player staring
               at the table they just left. Close the tab if we're embedded,
               otherwise route to the lobby unconditionally. */
            masterBus.emit('TABLE_MENU_ACTION', {
              tableId: tableId ?? '',
              action: 'CLOSE_TABLE_TAB',
            });
            navigate('/');
          }}
        />
      )}

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
    </>
  );
}

export default TableModalsLayer;
