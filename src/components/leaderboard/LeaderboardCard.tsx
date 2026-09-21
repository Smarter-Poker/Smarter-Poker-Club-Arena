import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { promotionService, LeaderboardEntry } from '../../services/PromotionService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import styles from './LeaderboardCard.module.css';

interface LeaderboardCardProps {
  promotionId: string;
  title?: string;
  limit?: number;
  showCurrentUser?: boolean;
  /** Already inside a console: print on its glass without a nested frame. */
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
  const [error, setError] = useState(false);
  const [userRank, setUserRank] = useState<LeaderboardEntry | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const requestId = useRef(0);
  const animTimers = useRef<number[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLeaderboard = useCallback(async () => {
    if (!isMounted.current) return;
    const generation = ++requestId.current;
    const isCurrent = () => isMounted.current && requestId.current === generation;
    setLoading(true);
    setError(false);
    setUserRank(null);
    try {
      const data = await promotionService.getLeaderboard(promotionId, limit);
      if (!isCurrent()) return;
      setEntries(data);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
      setVisibleItems(new Set());
      data.forEach((_, i) => {
        const timer = window.setTimeout(
          () => {
            if (isCurrent()) setVisibleItems((prev) => new Set(prev).add(i));
          },
          Math.min(i, 12) * 60
        );
        animTimers.current.push(timer);
      });
      if (showCurrentUser && user?.id && !data.some((entry) => entry.userId === user.id)) {
        const allData = await promotionService.getLeaderboard(promotionId, 1000);
        if (!isCurrent()) return;
        setUserRank(allData.find((entry) => entry.userId === user.id) ?? null);
      }
    } catch (loadError) {
      if (!isCurrent()) return;
      reportError(loadError, 'LeaderboardCard.Failed_to_load_leaderboard');
      setError(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [promotionId, limit, showCurrentUser, user?.id, isMounted]);

  useEffect(() => {
    setEntries([]);
    void loadLeaderboard();
    return () => {
      requestId.current += 1;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [loadLeaderboard]);

  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (!isMounted.current) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (isMounted.current) void loadLeaderboard();
    }, 2000);
  });

  const renderEntry = (entry: LeaderboardEntry, index?: number) => (
    <div
      key={entry.userId}
      className={`${styles.row} ${user?.id === entry.userId ? styles.currentUser : ''}`}
      style={
        index == null
          ? undefined
          : {
              opacity: visibleItems.has(index) ? 1 : 0,
              transform: visibleItems.has(index) ? 'translateY(0)' : 'translateY(8px)',
            }
      }
    >
      <span className={styles.rank}>
        {entry.rank <= 3 ? ['1st', '2nd', '3rd'][entry.rank - 1] : `#${entry.rank}`}
      </span>
      <div className={styles.player}>
        <div className={styles.avatar}>
          {entry.avatarUrl ? (
            <img
              loading="lazy"
              decoding="async"
              src={entry.avatarUrl}
              alt=""
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = generateDefaultAvatar();
              }}
            />
          ) : (
            <span>{(entry.displayName || entry.username || '?')[0]?.toUpperCase()}</span>
          )}
        </div>
        <span className={styles.name}>
          {entry.displayName || entry.username}
          {user?.id === entry.userId && <span className={styles.you}> (You)</span>}
        </span>
      </div>
      <div className={styles.scores}>
        <span className={styles.score}>{compactChips(entry.score)}</span>
        {entry.prize != null && entry.prize > 0 && (
          <span className={styles.prize}>Prize {compactChips(entry.prize)}</span>
        )}
      </div>
    </div>
  );

  const content = (
    <div className={styles.glass} aria-busy={loading}>
      {loading ? (
        <p className={styles.message} role="status">
          Loading Rankings...
        </p>
      ) : (
        <>
          {error && (
            <div className={styles.error} role="alert">
              <p>Rankings Could Not Be Updated.</p>
              <button type="button" onClick={() => void loadLeaderboard()}>
                Retry Rankings
              </button>
            </div>
          )}
          {!error && entries.length === 0 && <p className={styles.message}>No Entries Yet</p>}
          <div className={styles.list}>
            {entries.map((entry, index) => renderEntry(entry, index))}
          </div>
          {userRank && !entries.some((entry) => entry.userId === user?.id) && (
            <>
              <p className={styles.position}>Your Position</p>
              {renderEntry(userRank)}
            </>
          )}
        </>
      )}
    </div>
  );
  return variant === 'glass' ? (
    content
  ) : (
    <SpadeConsole
      className={styles.console}
      crest="flat"
      eyebrow="Promotion Rankings"
      title={title}
      pill="Standings"
    >
      {content}
    </SpadeConsole>
  );
}

export default memo(LeaderboardCardInner);
