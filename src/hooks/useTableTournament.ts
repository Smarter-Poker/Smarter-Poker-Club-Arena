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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentBreakState {
  active: boolean;
  timeRemaining: number;
  nextLevel?: {
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante?: number;
    duration: number;
  };
}

export interface AddOnPeriodState {
  active: boolean;
  addOnCost: number;
  addOnChips: number;
  walletBalance: number;
  timeRemaining: number;
}

export interface RebuyData {
  cost: number;
  chips: number;
}

export interface TournamentWinner {
  prize: number;
  name: string;
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
          console.error('[useTableTournament] Failed to unsubscribe from break channel:', err);
        }
      }

      // Unsubscribe from add-on channel if active
      if (addOnChannelRef.current) {
        try {
          addOnChannelRef.current.unsubscribe?.();
        } catch (err) {
          console.error('[useTableTournament] Failed to unsubscribe from add-on channel:', err);
        }
      }

      // Unsubscribe from bounty channel if active
      if (bountyChannelRef.current) {
        try {
          bountyChannelRef.current.unsubscribe?.();
        } catch (err) {
          console.error('[useTableTournament] Failed to unsubscribe from bounty channel:', err);
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
