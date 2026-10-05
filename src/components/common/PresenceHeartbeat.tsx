/**
 * The presence heartbeat's one mount point (App.tsx). Renders nothing.
 * Lazy-loaded so the heartbeat never enters the entry chunk every player
 * downloads before first paint. See src/lib/presenceHeartbeat.ts.
 */
import { usePresenceHeartbeat } from '../../hooks/usePresenceHeartbeat';
import { useUserStore } from '../../stores/useUserStore';

export default function PresenceHeartbeat(): null {
  const userId = useUserStore((state) => state.user?.id);
  usePresenceHeartbeat(userId);
  return null;
}
