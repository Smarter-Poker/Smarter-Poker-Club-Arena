/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableSession — Session tracking refs for the poker table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx (was lines 880–893). Groups all the
 * write-once-read-in-summary session refs into a single hook with a
 * typed API surface.
 *
 * All values are `useRef` (not state) so mutations don't cause re-renders —
 * identical to the original TablePage behaviour.
 */

import { useRef } from 'react';

export interface SessionRefs {
  /** Wall-clock timestamp when the player first sat down. */
  sessionStartRef: React.MutableRefObject<number>;

  /** Total hands dealt while the hero was seated. */
  handsPlayedRef: React.MutableRefObject<number>;

  /** Hands the hero won (any share of the pot). */
  handsWonRef: React.MutableRefObject<number>;

  /** Largest pot the hero participated in (chips). */
  biggestPotRef: React.MutableRefObject<number>;

  /** Highest stack the hero held during the session. */
  peakStackRef: React.MutableRefObject<number>;

  /**
   * Session profit/loss in chips.
   * Set to `(chipsReturned - totalBuyIn)` when the player leaves.
   */
  sessionPLRef: React.MutableRefObject<number>;

  /** Sum of all buy-in + add-chip amounts during this session. */
  totalBuyInRef: React.MutableRefObject<number>;

  /** Number of rebuys / add-chips actions during this session. */
  totalRebuysRef: React.MutableRefObject<number>;

  /**
   * Guard: prevents the bust-rebuy dialog from firing more than once
   * per bust event. Reset to `false` whenever the hero's stack becomes > 0.
   */
  bustPromptFiredRef: React.MutableRefObject<boolean>;

  /** Did the hero win the current hand? Cross-event tracking. */
  heroWonCurrentHandRef: React.MutableRefObject<boolean>;

  /** Did the current hand reach a showdown? Cross-event tracking. */
  hadShowdownRef: React.MutableRefObject<boolean>;
}

export interface UseTableSessionReturn extends SessionRefs {
  /**
   * Reset all counters to their initial values.
   * Call this when the SessionSummary modal is closed so stale data
   * doesn't bleed into the next session.
   */
  resetSession: () => void;
}

export function useTableSession(): UseTableSessionReturn {
  const sessionStartRef = useRef<number>(Date.now());
  const handsPlayedRef = useRef<number>(0);
  const handsWonRef = useRef<number>(0);
  const biggestPotRef = useRef<number>(0);
  const peakStackRef = useRef<number>(0);
  const sessionPLRef = useRef<number>(0);
  const totalBuyInRef = useRef<number>(0);
  const totalRebuysRef = useRef<number>(0);
  const bustPromptFiredRef = useRef<boolean>(false);
  const heroWonCurrentHandRef = useRef<boolean>(false);
  const hadShowdownRef = useRef<boolean>(false);

  const resetSession = () => {
    sessionStartRef.current = Date.now();
    handsPlayedRef.current = 0;
    handsWonRef.current = 0;
    biggestPotRef.current = 0;
    peakStackRef.current = 0;
    sessionPLRef.current = 0;
    totalBuyInRef.current = 0;
    totalRebuysRef.current = 0;
    bustPromptFiredRef.current = false;
    heroWonCurrentHandRef.current = false;
    hadShowdownRef.current = false;
  };

  return {
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
  };
}
