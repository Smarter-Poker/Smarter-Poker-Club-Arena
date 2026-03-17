/**
 *  CLUB ENGINE — Table Card Component
 * Displays a single table in the lobby grid
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { waitlistService } from '../../services/WaitlistService';
import { tableService } from '../../services/TableService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { PlayerAvatar } from '../avatars/PlayerAvatar';
import { haptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';
import styles from './TableCard.module.css';
import type { PokerTable } from '../../types/database.types';
import { useToast } from '../common/Toast';

interface TableCardProps {
  table: PokerTable;
}

const GAME_LABELS: Record<string, string> = {
  nlh: "NL Hold'em",
  flh: "FL Hold'em",
  short_deck: 'Short Deck',
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo_hilo: 'PLO Hi-Lo',
  ofc: 'OFC',
  ofc_pineapple: 'OFC Pineapple',
  double_board: 'Double Board',
  pineapple: 'Pineapple',
  crazy_pineapple: 'Crazy Pineapple',
  mixed: 'Mixed',
};

const GAME_ICONS: Record<string, string> = {
  nlh: '♠',
  flh: '♠',
  short_deck: '6+',
  plo4: '',
  plo5: '',
  plo6: '',
  plo_hilo: 'HL',
  ofc: '',
  ofc_pineapple: '',
  double_board: '',
  pineapple: '',
  crazy_pineapple: '',
  mixed: '',
};

function TableCardInner({ table }: TableCardProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const [isJoiningWaitlist, setIsJoiningWaitlist] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [adminProcessing, setAdminProcessing] = useState(false);
  const refreshRef = useRef<() => void>(undefined);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  // Map PokerTable fields to display values
  const players = table.current_players || 0;
  const seats = table.max_players || 9;
  const seatsAvailable = seats - players;
  const isFull = seatsAvailable === 0;

  // Live waitlist count from DB
  const [waiting, setWaiting] = useState(0);
  const hasWaitlist = waiting > 0;

  // Average pot from recent completed hands
  const [avgPot, setAvgPot] = useState(0);

  // Active player avatars
  const [playerAvatars, setPlayerAvatars] = useState<{ id: string; url?: string; name: string }[]>(
    []
  );

  useEffect(() => {
    let isMounted = true;

    // Fetch waitlist count
    supabase
      .from('table_waitlists')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', table.id)
      .eq('status', 'waiting')
      .then(({ count, error }) => {
        if (error) {
          console.warn('[TableCard] Waitlist count error:', error.message);
          return;
        }
        if (isMounted && count !== null) setWaiting(count);
      });

    // Fetch average pot from last 20 completed hands
    supabase
      .from('hands')
      .select('pot')
      .eq('table_id', table.id)
      .eq('status', 'completed')
      .gt('pot', 0)
      .order('ended_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error) {
          console.warn('[TableCard] Avg pot error:', error.message);
          return;
        }
        if (isMounted && data && data.length > 0) {
          const avg = data.reduce((sum, h) => sum + (h.pot || 0), 0) / data.length;
          setAvgPot(Math.trunc(avg * 100) / 100);
        }
      });

    // Fetch active player avatars
    supabase
      .from('table_seats')
      .select('user_id')
      .eq('table_id', table.id)
      .eq('status', 'active')
      .is('left_at', null)
      .limit(6)
      .then(async ({ data, error }) => {
        if (error) {
          console.warn('[TableCard] Player avatars error:', error.message);
          return;
        }
        if (isMounted && data && data.length > 0) {
          const userIds = data.map((p: any) => p.user_id).filter(Boolean);
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, avatar_url, display_name, username')
            .in('id', userIds);
          const profMap: Record<string, any> = {};
          if (profs)
            profs.forEach((p: any) => {
              profMap[p.id] = p;
            });
          setPlayerAvatars(
            data.map((p: any) => ({
              id: p.user_id,
              url: profMap[p.user_id]?.avatar_url,
              name: profMap[p.user_id]?.display_name || profMap[p.user_id]?.username || '?',
            }))
          );
        }
      });

    // Store refresh function for bus listeners
    refreshRef.current = () => {
      supabase
        .from('table_waitlists')
        .select('id', { count: 'exact', head: true })
        .eq('table_id', table.id)
        .eq('status', 'waiting')
        .then(({ count, error }) => {
          if (error) {
            console.warn('[TableCard] Waitlist refresh error:', error.message);
            return;
          }
          if (isMounted && count !== null) setWaiting(count);
        });
      supabase
        .from('table_seats')
        .select('user_id')
        .eq('table_id', table.id)
        .eq('status', 'active')
        .is('left_at', null)
        .limit(6)
        .then(async ({ data, error }) => {
          if (error) {
            console.warn('[TableCard] Avatars refresh error:', error.message);
            return;
          }
          if (isMounted && data && data.length > 0) {
            const userIds = data.map((p: any) => p.user_id).filter(Boolean);
            const { data: profs } = await supabase
              .from('profiles')
              .select('id, avatar_url, display_name, username')
              .in('id', userIds);
            const profMap: Record<string, any> = {};
            if (profs)
              profs.forEach((p: any) => {
                profMap[p.id] = p;
              });
            setPlayerAvatars(
              data.map((p: any) => ({
                id: p.user_id,
                url: profMap[p.user_id]?.avatar_url,
                name: profMap[p.user_id]?.display_name || profMap[p.user_id]?.username || '?',
              }))
            );
          } else if (isMounted) {
            setPlayerAvatars([]);
          }
        });
    };

    return () => {
      isMounted = false;
    };
  }, [table.id]);

  // Bus listeners for live table updates
  useEffect(() => {
    const refresh = () => refreshRef.current?.();
    const unsubs = [
      masterBus.subscribeDebounced('TABLE_SEATED', refresh, 500),
      masterBus.subscribeDebounced('TABLE_LEFT', refresh, 500),
      masterBus.subscribeDebounced('WAITLIST_POSITION_CHANGED', refresh, 500),
      masterBus.subscribeDebounced('DATA_MUTATED', refresh, 1000),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Check admin role for this table's club
  useEffect(() => {
    if (!user?.id || !table.club_id) return;
    let cancelled = false;
    supabase
      .from('club_members')
      .select('role')
      .eq('club_id', table.club_id)
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data && ['owner', 'admin'].includes(data.role)) {
          setAdminRole(data.role);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, table.club_id]);

  // ── Admin table management handlers ──
  const handleAdminAction = useCallback(
    async (action: 'pause' | 'resume' | 'close' | 'delete') => {
      if (adminProcessing) return;
      setAdminProcessing(true);
      haptic.light();
      try {
        let success = false;
        switch (action) {
          case 'pause':
            success = await tableService.pauseTable(table.id);
            break;
          case 'resume':
            success = await tableService.resumeTable(table.id);
            break;
          case 'close':
            await tableService.closeTable(table.id);
            success = true; // closeTable throws on failure
            break;
          case 'delete':
            if (!table.club_id) break;
            success = await tableService.deleteTable(table.id, table.club_id);
            break;
        }
        if (success) {
          toast.success(`Table ${action}d successfully`);
        } else {
          toast.error(`Failed to ${action} table — may have changed status`);
        }
      } catch (err: any) {
        toast.error(err.message || `Failed to ${action} table`);
      } finally {
        setAdminProcessing(false);
      }
    },
    [adminProcessing, table.id, table.club_id, toast]
  );

  const handleJoin = async () => {
    haptic.medium();
    if (isFull && user?.id) {
      // Join waitlist for full tables using WaitlistService
      setIsJoiningWaitlist(true);
      try {
        const entry = await waitlistService.join(table.id, user.id);
        if (entry) {
          navigate('/waitlist');
        } else {
          toast.error('Failed to join waitlist. You may already be on it.');
        }
      } catch (err) {
        console.error('Error joining waitlist:', err);
        toast.error('Failed to join waitlist.');
      }
      setIsJoiningWaitlist(false);
    } else {
      // Navigate to table if seats available
      navigate(`/table/${table.id}`);
    }
  };

  return (
    <div
      className={styles.card}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      {/* Header with game type */}
      <div className={styles.header}>
        <div className={styles.gameType}>
          <span className={styles.gameIcon}>{GAME_ICONS[table.game_variant] || '♠'}</span>
          <span className={styles.gameLabel}>
            {GAME_LABELS[table.game_variant] || table.game_variant}
          </span>
        </div>
        <div className={styles.stakes}>{table.stakes}</div>
      </div>

      {/* Table Name */}
      <h3 className={styles.tableName}>{table.name}</h3>

      {/* Stats Row */}
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Players</span>
          <span className={styles.statValue}>
            {players}/{seats}
          </span>
        </div>
        {avgPot > 0 && (
          <div className={styles.stat}>
            <span className={styles.statLabel}>Avg Pot</span>
            <span className={styles.statValue}>
              {avgPot.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        )}
        {hasWaitlist && (
          <div className={`${styles.stat} ${styles.waitlist}`}>
            <span className={styles.statLabel}>Waiting</span>
            <span className={styles.statValue}>{waiting}</span>
          </div>
        )}
      </div>

      {/* Seats Visualization */}
      <div className={styles.seatsBar}>
        <div className={styles.seatsFilled} style={{ width: `${(players / seats) * 100}%` }} />
      </div>

      {/* Active Player Avatars */}
      {playerAvatars.length > 0 && (
        <div className={styles.playerAvatars}>
          {playerAvatars.slice(0, 5).map((p, idx) => (
            <div
              key={p.id}
              className={styles.miniAvatar}
              style={{ zIndex: 5 - idx, marginLeft: idx > 0 ? '-8px' : 0 }}
            >
              <PlayerAvatar
                src={p.url}
                name={p.name}
                size="xs"
                showPresence={false}
                showLevelBadge={false}
                showXpRing={false}
                showVipRing={false}
              />
            </div>
          ))}
          {playerAvatars.length > 5 && (
            <span className={styles.moreCount}>+{playerAvatars.length - 5}</span>
          )}
        </div>
      )}

      {/* Action Button */}
      <button
        className={`${styles.joinButton} ${isFull ? styles.waitlistButton : ''}`}
        onClick={handleJoin}
        disabled={isJoiningWaitlist}
      >
        {isJoiningWaitlist ? 'Joining...' : isFull ? 'Join Waitlist' : 'Join Table'}
      </button>

      {/* Admin Controls — visible to owner/admin only */}
      {adminRole && (
        <div className={styles.adminControls}>
          {table.status === 'running' || table.status === 'active' || table.status === 'waiting' ? (
            <button
              className={styles.adminBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleAdminAction('pause');
              }}
              disabled={adminProcessing}
              title="Pause table"
            >
              ⏸ Pause
            </button>
          ) : table.status === 'paused' ? (
            <button
              className={styles.adminBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleAdminAction('resume');
              }}
              disabled={adminProcessing}
              title="Resume table"
            >
              ▶ Resume
            </button>
          ) : null}
          {table.status !== 'closed' && table.status !== 'deleted' && (
            <button
              className={`${styles.adminBtn} ${styles.adminBtnDanger}`}
              onClick={(e) => {
                e.stopPropagation();
                handleAdminAction('close');
              }}
              disabled={adminProcessing}
              title="Close table"
            >
              ✕ Close
            </button>
          )}
          {(table.status === 'closed' ||
            table.status === 'paused' ||
            table.status === 'waiting') && (
            <button
              className={`${styles.adminBtn} ${styles.adminBtnDanger}`}
              onClick={(e) => {
                e.stopPropagation();
                handleAdminAction('delete');
              }}
              disabled={adminProcessing}
              title="Delete table permanently"
            >
              🗑 Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export default memo(TableCardInner);
