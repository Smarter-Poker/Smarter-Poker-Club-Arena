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

  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setInventory(null);
    setAwards(EMPTY_AWARDS);
    setAwardsTotal(0);
    setLeaderboard(EMPTY_LEADERBOARD);
    setPendingReveals(0);
    setIsLoading(Boolean(tournamentId && enabled));
    if (!tournamentId || !enabled) return;

    // Requests, queued refreshes and channel callbacks belong to this effect's
    // event. A new event starts independently of any old transport response.
    let active = true;
    let inFlight = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      if (!active) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const [inv, aw, lb] = await Promise.all([
          MysteryBountyService.getInventory(tournamentId),
          MysteryBountyService.getAllAwards(tournamentId),
          MysteryBountyService.getLeaderboard(tournamentId),
        ]);
        if (!active) return;
        setInventory(inv);
        setAwards(aw.rows);
        setAwardsTotal(aw.total);
        setLeaderboard(lb);
        setPendingReveals(0);
      } catch (err) {
        if (active) reportError(err, 'useMysteryBounty.load');
      } finally {
        inFlight = false;
        if (active) {
          setIsLoading(false);
          if (queued) {
            queued = false;
            void load();
          }
        }
      }
    };
    const scheduleRefresh = () => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 350);
    };
    refreshRef.current = () => void load();

    const key = `t-break-${tournamentId}`;
    const preExisting = masterBus.hasChannel(key);
    const channel = masterBus.getOrCreateChannel(key);
    const onEvent = (message: { payload?: { type?: string } }) => {
      // A table may still hold this shared channel after the lobby has moved.
      if (!active) return;
      const type = message?.payload?.type;
      if (
        type === 'mystery_bounty_activated' ||
        type === 'mystery_bounty_revealed' ||
        type === 'mystery_bounty_complete'
      ) {
        if (type === 'mystery_bounty_revealed') {
          setPendingReveals((n) => n + 1);
        }
        scheduleRefresh();
      }
    };

    channel.on('broadcast', { event: 'tournament_event' }, onEvent);
    if (!preExisting) {
      channel.subscribe((status: string, err?: Error) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') scheduleRefresh();
        if (status === 'CHANNEL_ERROR' && err) {
          reportError(err.message || err, 'useMysteryBounty.channel_error');
        }
      });
    }
    void load();

    return () => {
      active = false;
      queued = false;
      if (timer) clearTimeout(timer);
      refreshRef.current = () => {};
      // Release this consumer only; the table may own another reference.
      masterBus.removeRegisteredChannel(key);
    };
  }, [tournamentId, enabled]);

  const refresh = useCallback(() => refreshRef.current(), []);

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
