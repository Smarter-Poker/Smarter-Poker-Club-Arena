/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRESENCE INDICATOR — Online/Offline Status Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows user's real-time presence status with optional pulse animation
 */

import { useIsProfileOnline } from '../../hooks/useProfilePresence';
import styles from './PresenceIndicator.module.css';

interface PresenceIndicatorProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
  className?: string;
}

type PresenceStatus = 'online' | 'away' | 'offline';

/* AUDIT 2026-08-20: this read `user_presence`, a table that does not exist,
   and its profiles fallback sat in a catch the client never reaches, so the
   dot read "offline" for every player. 2026-10-01 (ruling 25): online-now
   comes from the presence door, never the heartbeat itself.

   2026-10-05, ONE DEFINITION: the dot also subscribed to postgres_changes on
   `profiles` and set itself from the payload's raw is_online - the flag that
   was stale-true on 768 of 927 human rows. A row change cannot say a heartbeat
   is fresh, and nothing changes a row when a heartbeat simply goes stale. So
   the dot now asks fn_profile_presence through the shared watcher, which
   re-asks every minute in one batched call for every dot on screen
   (src/lib/profilePresence.ts). `profiles` is not in the realtime publication
   anyway, so the subscription never delivered anything. */
export default function PresenceIndicator({
  userId,
  size = 'medium',
  showLabel = false,
  className = '',
}: PresenceIndicatorProps) {
  const status = usePresence(userId);

  const getStatusLabel = (): string => {
    if (status === 'online') return 'Online';
    if (status === 'away') return 'Away';
    return 'Offline';
  };

  return (
    <div className={`${styles.container} ${styles[size]} ${className}`}>
      <span className={`${styles.dot} ${styles[status]}`} />
      {showLabel && <span className={styles.label}>{getStatusLabel()}</span>}
    </div>
  );
}

// Utility function for external use: the same answer as the dot.
export function usePresence(userId: string): PresenceStatus {
  return useIsProfileOnline(userId) ? 'online' : 'offline';
}
