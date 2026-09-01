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
import { EmptyState, ErrorState } from '../components/common/EmptyState';
import { reportError } from '../utils/errorReporter';

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
          stakes: '',
          game_type: 'NLH',
          position: e.position,
          joined_at: e.joinedAt,
          estimated_wait: Math.min(120, Math.ceil(e.position * 3 + Math.log2(e.position + 1) * 2)),
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

  // FIX 116: Updated to 9 approved variants — removed dead 'plo'
  const getGameTypeLabel = (type: string): string => {
    switch (type.toLowerCase()) {
      case 'nlh':
        return "No Limit Hold'em";
      case 'plo4':
        return 'PLO 4-Card';
      case 'plo5':
        return 'PLO 5-Card';
      case 'plo6':
        return 'PLO 6-Card';
      case 'plo8':
        return 'PLO Hi-Lo';
      case 'pineapple':
        return 'Crazy Pineapple';
      case 'short_deck':
        return 'Short Deck 6+';
      default:
        return type.toUpperCase();
    }
  };

  const formatWaitTime = (minutes: number): string => {
    if (minutes < 1) return 'Next up!';
    if (minutes >= 60) return `~${Math.round(minutes / 60)}h`;
    return `~${minutes} min`;
  };

  return (
    <div className="waitlist-page">
      {/* Real-time indicator */}
      {entries.length > 0 && (
        <div className="realtime-indicator" role="status">
          <span className="live-dot"></span>
          <span>Live Updates Enabled</span>
        </div>
      )}

      <div className="waitlist-content">
        {loading ? (
          <PageSkeleton variant="list" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void loadWaitlist()} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon="QUEUE"
            eyebrow="Table Queue"
            title="No Active Waitlists"
            description="Join A Full Table's Waitlist And Its Live Position Will Appear Here."
            action={{ label: 'Browse Tables', onClick: () => navigate('/') }}
          />
        ) : (
          <div className="waitlist-entries">
            {entries.map((entry, idx) => (
              <div
                key={entry.id}
                style={waitlistCardAnimationStyle(idx)}
                className={`waitlist-card ${entry.position === 1 ? 'next-up' : ''}`}
              >
                {entry.position === 1 && <div className="next-up-celebration">You're Next!</div>}
                <div className="waitlist-info">
                  <h4 className="table-name">{entry.table_name}</h4>
                  <span className="table-details">
                    {getGameTypeLabel(entry.game_type)} • {entry.stakes}
                  </span>
                </div>
                <div className="waitlist-position">
                  <span className={`position-number ${entry.position === 1 ? 'highlight' : ''}`}>
                    #{positionCounts[entry.id] || entry.position}
                  </span>
                  <span className="position-label">
                    {entry.position === 1 ? 'Next Up!' : 'In Line'}
                  </span>
                </div>
                <div className="waitlist-actions">
                  <span className="wait-time">{formatWaitTime(entry.estimated_wait)}</span>
                  <button
                    type="button"
                    className={`btn btn-ghost btn-sm leave-btn ${leavingId === entry.id ? 'loading' : ''}`}
                    onClick={() => {
                      haptic.medium();
                      leaveWaitlist(entry.table_id, entry.id);
                    }}
                    disabled={leavingId === entry.id}
                  >
                    {leavingId === entry.id ? 'Leaving...' : 'Leave'}
                  </button>
                </div>

                {/* Queue Progress Bar — replaces dot visual */}
                <div className="queue-progress-bar">
                  <div
                    className="queue-progress-fill"
                    style={{ width: `${Math.max(10, 100 - (entry.position - 1) * 15)}%` }}
                  />
                  <span className="queue-progress-label">
                    Position #{positionCounts[entry.id] || entry.position}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
