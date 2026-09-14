/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD CARD — Promotion Leaderboard Display
 * Shows top players with ranking, scores, and prizes
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { promotionService, LeaderboardEntry } from '../../services/PromotionService';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './LeaderboardCard.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';

interface LeaderboardCardProps {
  promotionId: string;
  title?: string;
  limit?: number;
  showCurrentUser?: boolean;
  /** `glass`: no box of its own, printed on a console's glass (#ClubArenaConsole). */
  variant?: 'card' | 'glass';
}

function LeaderboardCardInner({
  promotionId,
  title = 'Leaderboard',
  limit = 10,
  variant = 'card',
  showCurrentUser = true,
}: LeaderboardCardProps) {
  const { user } = useAuthUser();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRank, setUserRank] = useState<LeaderboardEntry | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const animTimers = useRef<number[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLeaderboard = useCallback(async () => {
    if (!isMounted.current) return;
    setLoading(true);
    try {
      const data = await promotionService.getLeaderboard(promotionId, limit);
      if (!isMounted.current) return;
      setEntries(data);
      // Track animation timers for cleanup
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
      setVisibleItems(new Set());
      data.forEach((_, i) => {
        const t = window.setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        animTimers.current.push(t);
      });

      // Find current user if not in top N
      if (showCurrentUser && user?.id) {
        const currentUserEntry = data.find((e) => e.userId === user.id);
        if (!currentUserEntry) {
          const allData = await promotionService.getLeaderboard(promotionId, 1000);
          if (!isMounted.current) return;
          const userEntry = allData.find((e) => e.userId === user.id);
          if (userEntry) setUserRank(userEntry);
        }
      }
    } catch (error) {
      reportError(error, 'LeaderboardCard.Failed_to_load_leaderboard');
    }
    if (isMounted.current) setLoading(false);
  }, [promotionId, limit, showCurrentUser, user?.id]);

  useEffect(() => {
    loadLeaderboard();

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [loadLeaderboard]);

  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (!isMounted.current) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (isMounted.current) loadLeaderboard();
    }, 2000);
  });

  const getMedalIcon = (rank: number): string => {
    switch (rank) {
      case 1:
        return '1st';
      case 2:
        return '2nd';
      case 3:
        return '3rd';
      default:
        return `#${rank}`;
    }
  };

  /* NEVER A DECIMAL POINT ON A FORWARD-FACING PAGE (#ClubArenaConsole): a
     race score prints compact, 1.2K not 1,200.00, and a prize the same. */
  const formatScore = (score: number): string => compactChips(score);

  const glass = variant === 'glass';
  const avatarOf = (entry: LeaderboardEntry) => (
    <div className={styles.avatar}>
      {entry.avatarUrl ? (
        <img
          loading="lazy"
          decoding="async"
          src={entry.avatarUrl}
          alt=""
          onError={(e) => {
            (e.target as HTMLImageElement).src = generateDefaultAvatar();
          }}
        />
      ) : (
        <span className={`${styles.avatarInitial} sc-ink--silver`} aria-hidden="true">
          {(entry.displayName || entry.username || '?').slice(0, 1).toUpperCase()}
        </span>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className={`${styles.card} ${glass ? styles.glass : ''}`}>
        <div className={`${styles.loading} sc-ink--muted`} role="status">
          Reading The Standings
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.card} ${glass ? styles.glass : ''}`}>
      {/* On a console's glass the row above already names the race, and a
          glyph is never printed on the master (#ClubArenaConsole). */}
      {!glass && (
        <div className={styles.header}>
          <h3 className={`${styles.title} sc-label sc-ink--blue`}>{title}</h3>
        </div>
      )}

      {entries.length === 0 ? (
        <div className={`${styles.empty} sc-ink--muted`}>
          <p>No Entries Yet</p>
        </div>
      ) : (
        <div className={styles.list}>
          {entries.map((entry, i) => {
            const isCurrentUser = user?.id === entry.userId;
            return (
              <div
                key={entry.userId}
                className={`${styles.row} ${entry.rank <= 3 ? styles.topThree : ''} ${isCurrentUser ? styles.currentUser : ''}`}
                style={{
                  opacity: visibleItems.has(i) ? 1 : 0,
                  transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className={styles.rankCol}>
                  {entry.rank <= 3 ? (
                    <span className={`${styles.medal} sc-ink--gold`}>
                      {getMedalIcon(entry.rank)}
                    </span>
                  ) : (
                    <span className={`${styles.rankNumber} sc-ink--blue`}>{entry.rank}</span>
                  )}
                </div>

                <div className={styles.playerCol}>
                  {avatarOf(entry)}
                  <span className={`${styles.name} sc-ink--silver`}>
                    <span className={styles.nameText}>{entry.displayName || entry.username}</span>
                    {isCurrentUser && (
                      <span className={`${styles.youBadge} sc-ink--blue`}>YOU</span>
                    )}
                  </span>
                </div>

                <div className={styles.scoreCol}>
                  <span className={`${styles.score} sc-ink--silver`}>
                    {formatScore(entry.score)}
                  </span>
                  {/* `prize && ...` printed a bare 0 for a place with no prize. */}
                  {entry.prize ? (
                    <span className={`${styles.prize} sc-ink--green`}>
                      {compactChips(entry.prize)}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Current user not in top N */}
      {userRank && !entries.find((e) => e.userId === user?.id) && (
        <>
          <div className={`${styles.separator} sc-ink--muted`} aria-hidden="true">
            Your Place
          </div>
          <div className={`${styles.row} ${styles.currentUser}`}>
            <div className={styles.rankCol}>
              <span className={`${styles.rankNumber} sc-ink--blue`}>{userRank.rank}</span>
            </div>
            <div className={styles.playerCol}>
              {avatarOf(userRank)}
              <span className={`${styles.name} sc-ink--silver`}>
                <span className={styles.nameText}>{userRank.displayName || userRank.username}</span>
                <span className={`${styles.youBadge} sc-ink--blue`}>YOU</span>
              </span>
            </div>
            <div className={styles.scoreCol}>
              <span className={`${styles.score} sc-ink--silver`}>
                {formatScore(userRank.score)}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
export default memo(LeaderboardCardInner);
