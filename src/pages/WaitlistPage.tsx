/**
 *  WAITLIST PAGE — Table Waitlist with Real-Time Updates
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { waitlistService, type WaitlistEntry as ServiceEntry } from '../services/WaitlistService';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { haptic } from '../services/HapticService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import './WaitlistPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import { reportError } from '../utils/errorReporter';
import { cashEntry, formatClock, type LobbyTableRow } from '../components/lobby/lobbyEntries';
import { ArenaGameCard, arenaGameCardDataFromEntry } from '../components/lobby/game-cards';
import type { WaitlistTableRow } from '../services/WaitlistService';
import { SpadeConsole } from '../components/console/SpadeConsole';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MY WAITLISTS - the table's own card (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The page a player lands on after JOIN WAITLIST on a full table, and until
 * today the one surface on that path still drawn in CSS: rounded cards, a
 * gradient progress bar, a ghost Leave button. Dan's rule for it: nothing
 * assembled from parts, nothing copy-pasted, nothing stuck on. So the page
 * draws exactly what the lobby draws for the same table - the approved
 * premium card for its game (NLH, PLO, Short Deck...) - with the queue state
 * printed in the card's own painted pill slot ("#3 In Line", "Next Up",
 * "Seat Held 0:42") and the actions on the card's own painted plates
 * (WATCH TABLE / LEAVE WAITLIST, or SIT NOW when a seat is being held).
 *
 * Two things that were wrong under the old paint are fixed with it:
 *   - every row said "No Limit Hold'em" with an empty stakes string, because
 *     the page hardcoded both; the service now resolves the table's row
 *     (WaitlistService.getUserWaitlists) and the card prints the truth;
 *   - a 'notified' row (position 0, seat offered, sixty-second hold) printed
 *     "#0 In Line". It is now SEAT HELD with the live countdown, and its
 *     blue plate takes the player to the table.
 */

const waitlistCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

interface WaitlistEntry {
  id: string;
  table_id: string;
  table_name: string;
  stakes: string;
  game_type: string;
  position: number;
  joined_at: string;
  estimated_wait: number; // minutes
  /** 'notified' means a seat is being held for the player right now. */
  status: 'waiting' | 'notified';
  /** When the held seat lapses; null unless status is 'notified'. */
  hold_expires_at: string | null;
  /** The table's lobby row, so the page can draw its card. */
  table: WaitlistTableRow | null;
}

export default function WaitlistPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [positionCounts, setPositionCounts] = useState<Record<string, number>>({});
  const positionCountsRef = useRef<Record<string, number>>({});
  const loadWaitlistRef = useRef<() => void>(() => {});
  const animFrameIdsRef = useRef<number[]>([]);

  useEffect(() => {
    if (user?.id) {
      let isMounted = true;
      loadWaitlist(() => isMounted);

      const channelKey = 'user-waitlist';

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'table_waitlist',
            /* DB LOAD PASS 2026-08-24: unfiltered, every waitlist write on the
               platform reloaded this page's list — a list that only ever shows
               THIS user's own queue entries (loadWaitlist filters by user_id).
               Scoped server-side to the same key. Do not widen this. */
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            loadWaitlistRef.current();
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'WaitlistPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[WaitlistPage] Realtime channel timed out');
          }
        });

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
      };
    }
  }, [user?.id]);

  // Keep loadWaitlistRef pointing to the latest loadWaitlist
  useEffect(() => {
    loadWaitlistRef.current = loadWaitlist;
  });

  // ── Bus Listeners: cross-page waitlist event reactivity (debounced) ──
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced(
        'WAITLIST_POSITION_CHANGED',
        () => {
          loadWaitlistRef.current();
          haptic.light();
        },
        300
      ),
      masterBus.subscribeDebounced('TABLE_SEATED', () => loadWaitlistRef.current(), 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [user?.id, navigate, toast]);

  useVisibilityRefresh(() => loadWaitlistRef.current());

  const loadingRef = useRef(false);

  const loadWaitlist = async (getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!getIsMounted || getIsMounted()) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const waitlists = await waitlistService.getUserWaitlists(user.id);
      if (getIsMounted && !getIsMounted()) return;
      setEntries(
        waitlists.map((e) => ({
          id: e.id,
          table_id: e.tableId,
          table_name: e.tableName,
          stakes: e.tableStakes,
          game_type: e.tableVariant || 'nlh',
          position: e.position,
          joined_at: e.joinedAt,
          estimated_wait: Math.min(120, Math.ceil(e.position * 3 + Math.log2(e.position + 1) * 2)),
          status: e.status === 'notified' ? 'notified' : 'waiting',
          hold_expires_at: e.holdExpiresAt,
          table: e.table,
        }))
      );
    } catch (error) {
      reportError(error, 'WaitlistPage.Failed_to_load_waitlist');
      if (!getIsMounted || getIsMounted()) {
        setLoadError(
          'Your table waitlists could not be loaded. Check your connection and try again.'
        );
      }
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const leaveWaitlist = async (tableId: string, entryId: string) => {
    if (!user?.id) return;
    setLeavingId(entryId);
    try {
      const success = await waitlistService.leave(tableId, user.id);
      if (success) {
        setEntries((prev) => prev.filter((e) => e.id !== entryId));
      }
    } catch (error) {
      reportError(error, 'WaitlistPage.Failed_to_leave_waitlist');
    }
    setLeavingId(null);
  };

  // Animate position number changes
  useEffect(() => {
    // Cancel any running animation frames from previous render
    animFrameIdsRef.current.forEach((id) => cancelAnimationFrame(id));
    animFrameIdsRef.current = [];

    entries.forEach((entry) => {
      const current = positionCountsRef.current[entry.id] ?? entry.position;
      if (current !== entry.position) {
        const start = current;
        const target = entry.position;
        const duration = 500;
        const startTime = performance.now();

        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const animatedPos = Math.ceil(start + (target - start) * progress);
          positionCountsRef.current[entry.id] = animatedPos;
          setPositionCounts((prev) => ({ ...prev, [entry.id]: animatedPos }));

          if (progress < 1) {
            const frameId = requestAnimationFrame(animate);
            animFrameIdsRef.current.push(frameId);
          }
        };

        const frameId = requestAnimationFrame(animate);
        animFrameIdsRef.current.push(frameId);
      } else {
        positionCountsRef.current[entry.id] = entry.position;
        setPositionCounts((prev) => ({ ...prev, [entry.id]: entry.position }));
      }
    });

    return () => {
      animFrameIdsRef.current.forEach((id) => cancelAnimationFrame(id));
      animFrameIdsRef.current = [];
    };
  }, [entries]);

  /* The hold countdown ticks once a second while any seat is held. */
  const [now, setNow] = useState(() => Date.now());
  const anyHeld = entries.some((e) => e.status === 'notified' && e.hold_expires_at);
  useEffect(() => {
    if (!anyHeld) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyHeld]);

  const heldFor = (entry: WaitlistEntry): string | null => {
    if (entry.status !== 'notified' || !entry.hold_expires_at) return null;
    const left = new Date(entry.hold_expires_at).getTime() - now;
    return formatClock(Math.max(0, left));
  };

  const shown = (entry: WaitlistEntry) => positionCounts[entry.id] || entry.position;

  /* The card is the lobby's card for this table, with the queue state in its
     pill slot. A row whose table could not be resolved still gets a card,
     built from what the queue knows. */
  const cardFor = (entry: WaitlistEntry) => {
    const row: LobbyTableRow = (entry.table as LobbyTableRow | null) ?? {
      id: entry.table_id,
      name: entry.table_name,
      game_variant: entry.game_type,
      small_blind: 0,
      big_blind: 0,
      min_buy_in: 0,
      max_buy_in: 0,
      current_players: 0,
      max_players: 0,
      status: 'full',
    };
    const data = arenaGameCardDataFromEntry(cashEntry(row));
    const held = heldFor(entry);
    const next = entry.status === 'waiting' && entry.position === 1;
    const label = held ? `Seat Held ${held}` : next ? 'Next Up' : `#${shown(entry)} In Line`;
    return {
      ...data,
      status: 'waitlist' as const,
      statusLabel: label,
      statusTone: held ? ('gold' as const) : next ? ('green' as const) : ('blue' as const),
    };
  };

  return (
    <div className="waitlist-page">
      {entries.length > 0 && (
        <span className="sr-only" role="status">
          Live Updates Enabled
        </span>
      )}

      {loading ? (
        <PageSkeleton variant="list" />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadWaitlist()} />
      ) : entries.length === 0 ? (
        <SpadeConsole
          className="waitlist-empty"
          eyebrow="Table Queue"
          title="My Waitlists"
          pill="Empty"
          pillInk="muted"
          plates={{
            secondary: {
              label: 'Refresh',
              onClick: () => void loadWaitlist(),
            },
            primary: {
              label: 'Browse Tables',
              ink: 'white',
              onClick: () => navigate('/'),
            },
          }}
        >
          <p className="sc-copy sc-copy--center">
            {"Join A Full Table's Waitlist And Its Live Position Will Appear Here."}
          </p>
        </SpadeConsole>
      ) : (
        <ul className="waitlist-entries">
          {entries.map((entry, idx) => {
            const held = heldFor(entry);
            const leaving = leavingId === entry.id;
            return (
              <li
                key={entry.id}
                style={waitlistCardAnimationStyle(idx)}
                className={`waitlist-card ${entry.position === 1 ? 'next-up' : ''} ${held ? 'seat-held' : ''}`}
                aria-label={`${entry.table_name}, ${held ? 'Seat Held' : `Position ${shown(entry)}`}`}
              >
                <ArenaGameCard
                  data={cardFor(entry)}
                  presentation="mobile"
                  actions={{
                    primaryLabel: held ? 'Sit Now' : leaving ? 'Leaving' : 'Leave Waitlist',
                    primaryTone: held ? 'green' : 'red',
                    primaryDisabled: leaving,
                    busy: leaving,
                    onPrimary: () => {
                      haptic.medium();
                      if (held) navigate(`/table/${entry.table_id}`);
                      else leaveWaitlist(entry.table_id, entry.id);
                    },
                    secondaryLabel: held ? 'Leave' : 'Watch Table',
                    onSecondary: () => {
                      haptic.light();
                      if (held) leaveWaitlist(entry.table_id, entry.id);
                      else navigate(`/table/${entry.table_id}`);
                    },
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
