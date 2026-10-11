/**
 * LIGHTNING PHASE 13: THE ROOM WHILE ITS CLUSTER DRAINS BACK TO MUST MOVE.
 *
 * An operator's drain (or the pool thinning out) stops new Lightning hands;
 * every hand already in the air finishes and settles, and the player's seat
 * is kept. The engine tells the room so ('lightning_cluster_status' ending),
 * and this line says it in plain words until the room closes and the
 * ended notice offers VIEW GAME. A paused Cluster says nothing at all here:
 * the felt's own "Next Hand..." covers the wait.
 *
 * Words only. Nothing here navigates, ever (CLAUDE.md 10.6): the player moves
 * themselves, by the VIEW GAME button the ended notice offers.
 */
import { useSyncExternalStore } from 'react';
import {
  lightningClusterStatus,
  subscribeLightningClusterStatus,
} from '../../lightning/lightningDecisionQueue';
import { LIGHTNING_ENDING_TEXT } from '../../lightning/lightningHand';
import './LightningFoldBar.css';

/** What the engine last said about this Cluster's hold. */
export function useLightningClusterStatus(clusterId: string | null): 'ending' | 'paused' | null {
  return useSyncExternalStore(
    subscribeLightningClusterStatus,
    () => lightningClusterStatus(clusterId),
    () => null
  );
}

export default function LightningEndingNotice({ clusterId }: { clusterId: string | null }) {
  const status = useLightningClusterStatus(clusterId);
  if (status !== 'ending') return null;
  return (
    <p className="lightning-next-hand" data-testid="lightning-ending" role="status">
      {LIGHTNING_ENDING_TEXT}
    </p>
  );
}
