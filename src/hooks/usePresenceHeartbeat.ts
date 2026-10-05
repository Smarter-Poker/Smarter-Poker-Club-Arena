/**
 * The signed-in player's presence heartbeat (src/lib/presenceHeartbeat.ts):
 * one beat on load, one every PRESENCE_HEARTBEAT_MS while the tab is
 * visible, one immediately when it becomes visible again, none while hidden.
 * Mounted ONCE, at the app root, as <PresenceHeartbeat /> (App.tsx).
 */
import { useEffect } from 'react';
import { PRESENCE_HEARTBEAT_MS, sendPresence } from '../lib/presenceHeartbeat';
import { useUserStore } from '../stores/useUserStore';
import { reportError } from '../utils/errorReporter';

const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function usePresenceHeartbeat(userId: string | null | undefined): void {
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    // One report per run of failures, not one every two minutes while offline.
    let failing = false;

    const beat = () => {
      if (stopped || tabHidden()) return;
      sendPresence(userId, true).then(
        () => {
          failing = false;
        },
        (e) => {
          if (!failing) reportError(e, 'presenceHeartbeat.beat');
          failing = true;
        }
      );
    };
    const onVisibility = () => {
      if (!tabHidden()) beat();
    };

    beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId]);
}

/** The heartbeat's one mount point. Renders nothing. */
export function PresenceHeartbeat(): null {
  const userId = useUserStore((state) => state.user?.id);
  usePresenceHeartbeat(userId);
  return null;
}
