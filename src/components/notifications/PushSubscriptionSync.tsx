/**
 * PushSubscriptionSync — silent, invisible subscription repair. Renders nothing.
 *
 * THE INCIDENT THIS PREVENTS
 * ────────────────────────────────────────────────────────────────────────
 * A player enables push once. Weeks later the browser silently rotates the
 * subscription (OS update, storage eviction, PWA reinstall). The old endpoint
 * is dead but the server never learns, so every send is "accepted" by FCM and
 * the phone stays silent forever. The first-run prompt has already been marked
 * done in localStorage, so nothing ever asks again. The player concludes push
 * is broken; the dashboard says everything is fine.
 *
 * WHAT THIS DOES
 * On every app boot, and whenever a backgrounded PWA returns to the
 * foreground, if permission is ALREADY granted and somebody is signed in, it
 * silently re-runs enablePush() to refresh and re-register the subscription.
 *
 * It NEVER prompts. It bails immediately unless permission is already
 * 'granted', so it cannot steal the permission dialog from the first-run flow.
 * Throttled to once per hour per device. Errors are never surfaced.
 *
 * The throttle key is shared with the World Hub's copy of this component on
 * purpose. Both repair the SAME root-scope subscription (see lib/pushClient.ts
 * on why Club Arena enrols against /sw.js), so a player who has both surfaces
 * open should get one repair per hour, not two.
 */
import { useEffect, useRef } from 'react';
import {
  enablePush,
  isOptedOut,
  isWebPushSupported,
  notificationPermission,
} from '../../lib/pushClient';
import { readLocalSession } from '../../lib/authUtils';

const SYNC_KEY = 'sp_push_sync_at';
const THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const BOOT_DELAY_MS = 4000; // background maintenance, not startup work

export default function PushSubscriptionSync() {
  const running = useRef(false);
  /**
   * In-memory mirror of the throttle. localStorage reads THROW when storage is
   * blocked (Safari private mode). The hub's first version caught that, left
   * `last` at 0, and the `if (last && ...)` guard short-circuited to false, so
   * the throttle silently vanished and a full enablePush() ran on EVERY
   * visibilitychange, i.e. every tab switch. Keep the ref.
   */
  const lastRunRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const maybeSync = async () => {
      if (running.current) return;
      if (!isWebPushSupported()) return;
      if (notificationPermission() !== 'granted') return; // never prompt
      // Respect an explicit "turn push off on this device". Without this the
      // repair loop re-subscribes what the player just switched off.
      if (isOptedOut()) return;
      if (!readLocalSession()?.userId) return;

      let last = lastRunRef.current;
      try {
        last = Math.max(last, Number(localStorage.getItem(SYNC_KEY) || 0));
      } catch {
        /* private mode */
      }
      if (Date.now() - last < THROTTLE_MS) return;

      running.current = true;
      lastRunRef.current = Date.now();
      try {
        await enablePush();
        try {
          localStorage.setItem(SYNC_KEY, String(Date.now()));
        } catch {
          /* private mode */
        }
      } catch {
        // Silent by design. A failed repair must never interrupt the player.
      } finally {
        running.current = false;
      }
    };

    const boot = setTimeout(maybeSync, BOOT_DELAY_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void maybeSync();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearTimeout(boot);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
