/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useMysteryBounty — the lobby's live view of a mystery bounty event
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Section 68: when a chest is opened anywhere in the event, the lobby must move
 * without anybody pressing refresh. Section 69: on RELOAD, every one of those
 * numbers has to come back from server state, not from a tally the page has been
 * keeping in a ref.
 *
 * Both are satisfied the same way and it is worth being explicit about it,
 * because the tempting shortcut fails the second requirement: a broadcast is a
 * TRIGGER, never a source. `mystery_bounty_revealed` tells this hook that the
 * inventory, the award list and the leaderboard have all changed; it then asks
 * the three RPCs what they now say. A reload runs exactly the same fetch with no
 * broadcast at all, so the two paths cannot drift.
 *
 * The one concession to responsiveness is `pendingReveals`: the count of
 * broadcasts seen since the last completed refetch. It drives a "Live" pulse and
 * nothing numeric. No total anywhere in the UI is derived from it.
 *
 * CHANNEL OWNERSHIP. The engine broadcasts on `t-break-<tournamentId>`, which
 * TablePage also uses (MultiTablePage can have this lobby mounted beside a live
 * table). Whoever gets there first owns the subscribe and the teardown; the
 * second arrival only adds its own broadcast binding. Calling `subscribe()`
 * twice on one channel instance throws, and removing a channel another mounted
 * component is still reading would silently kill its events.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import {
  MysteryBountyService,
  type MysteryBountyAward,
  type MysteryBountyInventory,
  type MysteryBountyLeaderboardRow,
} from '../services/MysteryBountyService';

export interface UseMysteryBountyResult {
  inventory: MysteryBountyInventory | null;
  awards: MysteryBountyAward[];
  awardsTotal: number;
  leaderboard: MysteryBountyLeaderboardRow[];
  isLoading: boolean;
  /** Reveals broadcast since the last completed refetch. Presentation only. */
  pendingReveals: number;
  refresh: () => void;
}

const EMPTY_AWARDS: MysteryBountyAward[] = [];
const EMPTY_LEADERBOARD: MysteryBountyLeaderboardRow[] = [];

/**
 * @param tournamentId  the event, or null/undefined to stay idle
 * @param enabled       false for a tournament that is not a mystery bounty, so
 *                      an ordinary freezeout costs nothing at all
 */
export function useMysteryBounty(
  tournamentId: string | null | undefined,
  enabled: boolean
): UseMysteryBountyResult {
  const [inventory, setInventory] = useState<MysteryBountyInventory | null>(null);
  const [awards, setAwards] = useState<MysteryBountyAward[]>(EMPTY_AWARDS);
  const [awardsTotal, setAwardsTotal] = useState(0);
  const [leaderboard, setLeaderboard] = useState<MysteryBountyLeaderboardRow[]>(EMPTY_LEADERBOARD);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingReveals, setPendingReveals] = useState(0);

  const mountedRef = useRef(true);
  /**
   * Refetches are collapsed: a five-way split knockout broadcasts once, but a
   * final table busting three players in a minute would otherwise fire three
   * full triples of RPC calls that all answer the same question.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const load = useCallback(async () => {
    if (!tournamentId || !enabled) return;
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      const [inv, aw, lb] = await Promise.all([
        MysteryBountyService.getInventory(tournamentId),
        MysteryBountyService.getAllAwards(tournamentId),
        MysteryBountyService.getLeaderboard(tournamentId),
      ]);
      if (!mountedRef.current) return;
      setInventory(inv);
      setAwards(aw.rows);
      setAwardsTotal(aw.total);
      setLeaderboard(lb);
      setPendingReveals(0);
    } catch (err) {
      reportError(err, 'useMysteryBounty.load');
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setIsLoading(false);
      if (queuedRef.current && mountedRef.current) {
        queuedRef.current = false;
        void load();
      }
    }
  }, [tournamentId, enabled]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void load();
    }, 350);
  }, [load]);

  // ── First load, and any time the event changes. ──
  useEffect(() => {
    if (!tournamentId || !enabled) {
      setInventory(null);
      setAwards(EMPTY_AWARDS);
      setAwardsTotal(0);
      setLeaderboard(EMPTY_LEADERBOARD);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load();
  }, [tournamentId, enabled, load]);

  // ── Live updates. ──
  useEffect(() => {
    if (!tournamentId || !enabled) return;
    const key = `t-break-${tournamentId}`;
    const preExisting = masterBus.hasChannel(key);
    const channel = masterBus.getOrCreateChannel(key);

    const onEvent = (message: { payload?: { type?: string } }) => {
      const type = message?.payload?.type;
      if (
        type === 'mystery_bounty_activated' ||
        type === 'mystery_bounty_revealed' ||
        type === 'mystery_bounty_complete'
      ) {
        if (type === 'mystery_bounty_revealed' && mountedRef.current) {
          setPendingReveals((n) => n + 1);
        }
        scheduleRefresh();
      }
    };

    channel.on('broadcast', { event: 'tournament_event' }, onEvent);

    if (!preExisting) {
      channel.subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR' && err) {
          reportError(err.message || err, 'useMysteryBounty.channel_error');
        }
      });
    }

    return () => {
      /* REFCOUNTED 2026-08-28: `removeRegisteredChannel` now releases ONE
         reference and tears the channel down only when the last consumer lets
         go, so every consumer must release exactly once — including this one.
         The old `if (!preExisting)` guard was an attempt at the same
         protection from the wrong side ("I created it" is not "nobody else is
         reading it"), and with a real refcount underneath it would now LEAK:
         a non-creator took a reference at getOrCreateChannel and never gave
         it back, so the channel could never reach zero. */
      masterBus.removeRegisteredChannel(key);
    };
  }, [tournamentId, enabled, scheduleRefresh]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return {
    inventory,
    awards,
    awardsTotal,
    leaderboard,
    isLoading,
    pendingReveals,
    refresh,
  };
}

export default useMysteryBounty;
