import { engineChannelClient } from '../services/EngineStateClient';
import { realtimeChannelService } from '../services/RealtimeChannelService';

/** Only the authenticated engine channel wakes a read. Each RPC still gates
 * its own result; a club event carries no private ledger payload. */
export function watchLightningOperator(
  clubId: string | null,
  clusterId: string | null,
  onChange: () => void
): () => void {
  if (!clubId) return () => undefined;
  const unClub = realtimeChannelService.subscribeToClub(
    clubId,
    '',
    { id: '', displayName: '', playerNumber: 0, avatarUrl: '', status: 'online' },
    {
      onEvent: (event) => {
        const e = event as unknown as { type: string; clusterId?: string };
        if (
          e.type === 'lightning_operator_resync' ||
          (e.type === 'lightning_operator_changed' && (!clusterId || e.clusterId === clusterId))
        )
          onChange();
      },
    }
  );
  const unStatus = engineChannelClient.onStatusChange((status) => {
    if (status === 'connected') onChange();
  });
  return () => {
    unClub();
    unStatus();
  };
}
