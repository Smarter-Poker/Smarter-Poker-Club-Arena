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
  /**
   * Absolute close of the persisted offer. The client recomputes its display
   * from this deadline so a delayed broadcast or backgrounded tab cannot
   * silently turn a one-minute or Free Buy window into a fresh 60 seconds.
   */
  endsAtMs: number | null;
  timeRemaining: number;
}

export interface RebuyData {
  cost: number;
  /** House fee charged on top of `cost`. See AddOnPeriodState.addOnFee. */
  fee: number;
  chips: number;
}

export interface TournamentWinner {
  championName?: string;
  qualifiers?: Array<{ username: string; prize: number }>;
  prize: number;
  name: string;
  /** Paid non-winners use the same celebration surface without being called champion. */
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
    endsAtMs: null,
    timeRemaining: 0,
  });
  const addOnChannelRef = useRef<any>(null);
  const bountyChannelRef = useRef<any>(null);

  // Winner
  const [tournamentWinner, setTournamentWinner] = useState<TournamentWinner | null>(null);

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      /* THE BREAK CHANNEL IS NOT THIS HOOK'S TO CLOSE (2026-10-24).
         `t-break-<tournamentId>` is the MasterBus registry's SHARED channel:
         every TablePage in the event, the tournament lobby's useMysteryBounty
         and MysteryBountyCelebration hold references to the same object, and
         TablePage gives its own reference back through the refcounted
         removeRegisteredChannel in the effect that took it. Calling
         `unsubscribe()` here closed the channel under every other holder -
         and this cleanup runs BEFORE TablePage's (it is declared first), so
         the registry was left holding a closed channel the SDK had already
         dropped from its socket. Nothing can rejoin that object, the other
         holders went deaf to breaks, level-ups and eliminations, and the
         health monitor reported "Critical realtime channel dead with no
         recovery factory" every 30s for hours (247 in a day, all after a
         table move). Releasing it is TablePage's job, and TablePage reads
         this ref to do it, so this cleanup touches neither the channel nor
         the ref. */

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
