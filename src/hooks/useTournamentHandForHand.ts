import { useEffect, useMemo, useState } from 'react';
import { engineChannelClient } from '../services/EngineStateClient';
import { realtimeChannelService } from '../services/RealtimeChannelService';

/** Display-only manager state. Unknown never means play has resumed. */
export function useTournamentHandForHand(
  tournamentId: string | undefined,
  userId: string | undefined,
  enabled = true
): boolean | null {
  const scope = useMemo(() => ({ tournamentId, userId, enabled }), [tournamentId, userId, enabled]);
  const [observed, setObserved] = useState<{
    scope: typeof scope;
    active: boolean | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !tournamentId || !userId) return;
    let current = true;
    const update = (active: boolean | null) => {
      if (current) setObserved({ scope, active });
    };
    update(null);
    const stopStatus = engineChannelClient.onStatusChange((status) => {
      if (status !== 'connected') update(null);
      // The existing channel client replays JOINs on reconnect. Only the
      // server's subsequent snapshot may make the banner active again.
    });
    const stopEvents = realtimeChannelService.subscribeToTournament(
      tournamentId,
      {
        onEvent: (event) => {
          if (event.type !== 'tournament_presentation') return;
          const payload = event.payload as { handForHand?: unknown } | null;
          update(typeof payload?.handForHand === 'boolean' ? payload.handForHand : null);
        },
      },
      { presentationSnapshot: true }
    );
    return () => {
      current = false;
      stopEvents();
      stopStatus();
    };
  }, [scope, tournamentId, userId, enabled]);
  return enabled && observed?.scope === scope ? observed.active : null;
}
