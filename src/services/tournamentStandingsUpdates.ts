import { realtimeChannelService } from './RealtimeChannelService';
import { engineChannelClient } from './EngineStateClient';
import { masterBus } from '../core/MasterBus';

type Listener = () => void;
interface Feed {
  listeners: Set<Listener>;
  timer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}
const feeds = new Map<string, Feed>();

/** One engine subscription per tournament for all standings readers. The hand
 * owner emits only after its exact settlement is proved. Lifecycle events also
 * invalidate registration, elimination and rebuy state. Rejoin and visibility
 * recovery reread committed rows; hot tournament_players stays out of WAL Realtime.
 */
export function subscribeTournamentStandings(tournamentId: string, listener: Listener): () => void {
  let feed = feeds.get(tournamentId);
  if (!feed) {
    feed = { listeners: new Set(), timer: null, stop: () => {} };
    feeds.set(tournamentId, feed);
    const owned = feed;
    const invalidate = () => {
      if (feeds.get(tournamentId) !== owned || owned.timer) return;
      // A fixed trailing flush coalesces hands without starving a busy MTT.
      owned.timer = setTimeout(() => {
        owned.timer = null;
        for (const notify of [...owned.listeners]) notify();
      }, 100);
    };
    let stopEvents = () => {};
    const bind = () => {
      stopEvents();
      stopEvents = realtimeChannelService.subscribeToTournament(
        tournamentId,
        { onEvent: invalidate },
        { presentationSnapshot: true }
      );
    };
    bind();
    const stopIdentity = masterBus.subscribe('AUTH_STATE_CHANGED', ({ payload }) => {
      stopEvents();
      if (payload.isAuthenticated)
        queueMicrotask(() => {
          if (feeds.get(tournamentId) === owned) bind();
        });
    });
    const stopStatus = engineChannelClient.onStatusChange((status) => {
      if (status === 'connected') invalidate();
    });
    const onVisible = () => {
      if (!document.hidden) invalidate();
    };
    document.addEventListener('visibilitychange', onVisible);
    owned.stop = () => {
      stopEvents();
      stopIdentity();
      stopStatus();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }
  const registration = () => listener();
  feed.listeners.add(registration);
  const owned = feed;
  return () => {
    owned.listeners.delete(registration);
    if (owned.listeners.size || feeds.get(tournamentId) !== owned) return;
    if (owned.timer) clearTimeout(owned.timer);
    feeds.delete(tournamentId);
    owned.stop();
  };
}
