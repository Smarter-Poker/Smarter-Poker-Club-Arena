import { useCashGameLobby } from './useCashGameLobby';
import { CASH_CLUSTER_HUD_POLL_MS } from './CashClusterHUD';
import { WaitlistCallToAction } from './WaitlistCallToAction';

/** The game lobby owns a cluster's entry queue, never table_waitlist. */
export function ClusterWaitlistCallToAction({
  gameId,
  onClick,
  refreshKey = 0,
  enabled = true,
}: {
  gameId: string;
  onClick: () => void;
  refreshKey?: number;
  enabled?: boolean;
}) {
  const { lobby, error } = useCashGameLobby(gameId, enabled, CASH_CLUSTER_HUD_POLL_MS, refreshKey);
  const waiting = lobby?.waitlist?.waiting;
  const countKnown = typeof waiting === 'number' && Number.isSafeInteger(waiting) && waiting >= 0;
  const mine = lobby?.me?.seated ? null : lobby?.me?.waitlist;
  return (
    <WaitlistCallToAction
      onClick={onClick}
      waitingCount={countKnown ? waiting : 0}
      position={mine?.on_list ? mine.position : null}
      onList={mine?.on_list === true}
      queueState={countKnown ? undefined : error ? 'unavailable' : 'loading'}
    />
  );
}
