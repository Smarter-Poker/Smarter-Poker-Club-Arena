/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableTournament — Tournament-Specific State & Handlers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Manages tournament breaks, add-on periods, rebuy modals, announcements,
 * and winner overlay state.
 */

import { useState, useRef, useEffect } from 'react';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentBreakState {
  active: boolean;
  timeRemaining: number;
  /**
   * 'last_hand' is the :55 window, where the break has been announced but the
   * five minutes have not started because tables are still finishing the hand
   * in progress. 'counting_down' is the five minutes themselves. See
   * TournamentBreakScreen for why the distinction has to reach the UI.
   */
  phase?: 'last_hand' | 'counting_down';
  /** Absolute end of the break, epoch ms; null during the last-hand window. */
  breakEndsAtMs?: number | null;
  /** Blind level the break interrupted, as broadcast by the server. */
  level?: number;
  nextLevel?: {
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante?: number;
    /**
     * OPTIONAL, and it always was in practice. The server's break payload
     * carries only smallBlind, bigBlind and ante — declaring `duration`
     * required let TournamentBreakScreen divide by an undefined and render
     * NaN into the progress ring on every break.
     */
    duration?: number;
  };
}

export interface AddOnPeriodState {
  active: boolean;
  addOnCost: number;
  /**
   * House fee charged on top of addOnCost. Quoted from TournamentService so the
   * modal shows the same number the server debits (2026-08-20).
   */
  addOnFee: number;
  addOnChips: number;
  walletBalance: number;
  timeRemaining: number;
}

export interface RebuyData {
  cost: number;
  /** House fee charged on top of `cost`. See AddOnPeriodState.addOnFee. */
  fee: number;
  chips: number;
}

export interface TournamentWinner {
  prize: number;
  name: string;
  /**
   * Finishing place. Defaults to 1 for every existing caller, so the champion
   * overlay is unchanged. 2 and 3 reach the same overlay when the place PAID -
   * see "A PAID FINISH IS NOT A BUST" in TournamentWinnerOverlay.
   */
  position?: number;
}

export interface Announcement {
  type: string;
  data?: any;
}

export interface UseTableTournamentReturn {
  // Rebuy
  rebuyProcessing: boolean;
  setRebuyProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  showRebuyModal: boolean;
  setShowRebuyModal: React.Dispatch<React.SetStateAction<boolean>>;
  rebuyData: RebuyData | null;
  setRebuyData: React.Dispatch<React.SetStateAction<RebuyData | null>>;

  // Break
  tournamentBreak: TournamentBreakState;
  setTournamentBreak: React.Dispatch<React.SetStateAction<TournamentBreakState>>;
  breakChannelRef: React.MutableRefObject<any>;

  // Announcement
  announcement: Announcement | null;
  setAnnouncement: React.Dispatch<React.SetStateAction<Announcement | null>>;

  // Add-on
  addOnPeriod: AddOnPeriodState;
  setAddOnPeriod: React.Dispatch<React.SetStateAction<AddOnPeriodState>>;
  addOnChannelRef: React.MutableRefObject<any>;
  bountyChannelRef: React.MutableRefObject<any>;

  // Winner
  tournamentWinner: TournamentWinner | null;
  setTournamentWinner: React.Dispatch<React.SetStateAction<TournamentWinner | null>>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useTableTournament(): UseTableTournamentReturn {
  // Rebuy
  const [rebuyProcessing, setRebuyProcessing] = useState(false);
  const [showRebuyModal, setShowRebuyModal] = useState(false);
  const [rebuyData, setRebuyData] = useState<RebuyData | null>(null);

  // Break
  const [tournamentBreak, setTournamentBreak] = useState<TournamentBreakState>({
    active: false,
    timeRemaining: 0,
  });
  const breakChannelRef = useRef<any>(null);

  // Announcement
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  // Add-on
  const [addOnPeriod, setAddOnPeriod] = useState<AddOnPeriodState>({
    active: false,
    addOnCost: 0,
    addOnFee: 0,
    addOnChips: 0,
    walletBalance: 0,
    timeRemaining: 60,
  });
  const addOnChannelRef = useRef<any>(null);
  const bountyChannelRef = useRef<any>(null);

  // Winner
  const [tournamentWinner, setTournamentWinner] = useState<TournamentWinner | null>(null);

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      // Unsubscribe from break channel if active
      if (breakChannelRef.current) {
        try {
          breakChannelRef.current.unsubscribe?.();
        } catch (err) {
          reportError(err, 'useTableTournament.Failed_to_unsubscribe_from_break_channel');
        }
      }

      // Unsubscribe from add-on channel if active
      if (addOnChannelRef.current) {
        try {
          addOnChannelRef.current.unsubscribe?.();
        } catch (err) {
          reportError(err, 'useTableTournament.Failed_to_unsubscribe_from_addon_channel');
        }
      }

      // Unsubscribe from bounty channel if active
      if (bountyChannelRef.current) {
        try {
          bountyChannelRef.current.unsubscribe?.();
        } catch (err) {
          reportError(err, 'useTableTournament.Failed_to_unsubscribe_from_bounty_channe');
        }
      }
    };
  }, []);

  return {
    rebuyProcessing,
    setRebuyProcessing,
    showRebuyModal,
    setShowRebuyModal,
    rebuyData,
    setRebuyData,
    tournamentBreak,
    setTournamentBreak,
    breakChannelRef,
    announcement,
    setAnnouncement,
    addOnPeriod,
    setAddOnPeriod,
    addOnChannelRef,
    bountyChannelRef,
    tournamentWinner,
    setTournamentWinner,
  };
}
