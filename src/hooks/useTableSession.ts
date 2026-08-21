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

import { useEffect, useRef } from 'react';
import { masterBus } from '../core/MasterBus';

export interface SessionRefs {
  /** Wall-clock timestamp when the player first sat down. */
  sessionStartRef: React.MutableRefObject<number>;

  /** Total hands dealt while the hero was seated. */
  handsPlayedRef: React.MutableRefObject<number>;

  /** Hands the hero won (any share of the pot). */
  handsWonRef: React.MutableRefObject<number>;

  /** Largest completed pot at the table during the session (chips). */
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

  // LIVE E2E FIX 2026-08-15: biggestPotRef was declared but NEVER written —
  // the Session Complete modal showed "BIGGEST POT 0" every session, and
  // peakStackRef only moved on buy-ins/rebuys (a session that peaked at 203
  // reported 200). The engine's pot_distributed event (relayed onto the
  // MasterBus by TablePage as POT_DISTRIBUTED) carries the authoritative
  // total_pot for every completed hand — track the session maximum here,
  // next to the ref it feeds. CHIPS_ADDED carries the post-top-up stack and
  // keeps raising the peak. Exact tick-by-tick stack peaks need the WS merge
  // inside TablePage (transport-blocked at 307KB); this covers every pot and
  // every chip-add without touching it.
  useEffect(() => {
    const unsubPot = masterBus.subscribe('POT_DISTRIBUTED', (event) => {
      const p = event.payload as { total_pot?: number };
      const totalPot = typeof p?.total_pot === 'number' ? p.total_pot : 0;
      if (totalPot > biggestPotRef.current) biggestPotRef.current = totalPot;
    });
    const unsubChips = masterBus.subscribe('CHIPS_ADDED', (event) => {
      const p = event.payload as { newStack?: number };
      const stack = typeof p?.newStack === 'number' ? p.newStack : 0;
      if (stack > peakStackRef.current) peakStackRef.current = stack;
    });

    /**
     * SESSION DATA FIX 2026-08-20 (Dan: "there is a bug inside the Session
     * Complete, it's not using any real or accurate data").
     *
     * handsPlayedRef and handsWonRef were declared in this hook, exported in
     * its return, read by publishSessionSummary in TablePage — and WRITTEN BY
     * NOTHING. Not here, not in TablePage, not anywhere in the repo. So three
     * of the six tiles on the Session Complete card were structurally pinned
     * to zero for every session that has ever been played:
     *
     *   Hands Played  = handsPlayedRef                     -> always 0
     *   Hands/Hour    = handsPlayed / duration * 3600       -> always 0
     *   Win Rate      = handsWon / handsPlayed              -> always 0%
     *
     * This is the identical defect the 2026-08-15 comment above describes for
     * biggestPotRef; that pass fixed the pot and the stack and left these two
     * behind, which is why a card can show a real 40-chip biggest pot and a
     * real +300 profit next to "0 hands played". The numbers that WERE wired
     * looked right, so the ones that were not read as a quiet session rather
     * than as broken.
     *
     * HAND_COMPLETED is the correct source: TablePage emits it exactly once
     * per hand, inside a guard that requires `outcome.dealtIn`, so it counts
     * hands the hero was actually IN — not every pot that happened at the
     * table while they sat out or waited for the big blind.
     */
    const unsubHand = masterBus.subscribe('HAND_COMPLETED', (event) => {
      const p = event.payload as { won?: boolean; heroStack?: number };
      handsPlayedRef.current += 1;
      if (p?.won === true) handsWonRef.current += 1;

      // Peak stack, properly. CHIPS_ADDED above only fires on a top-up, so a
      // player who never rebought reported a peak of 0 while holding chips the
      // whole session. Sampling at end-of-hand catches the real high-water mark
      // for anyone who ever won a pot.
      const stack = typeof p?.heroStack === 'number' ? p.heroStack : 0;
      if (stack > peakStackRef.current) peakStackRef.current = stack;
    });

    return () => {
      unsubPot();
      unsubChips();
      unsubHand();
    };
    // Refs are stable for the hook's lifetime — subscribe exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
