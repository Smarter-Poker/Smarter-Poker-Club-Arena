import { useEffect, useState } from 'react';
import type { HandRecord } from '../components/table/HandHistoryPanel';
import { readLocalSession } from '../lib/authUtils';
import { reportError } from '../utils/errorReporter';

/** A selected hand can precede its private fact projection. Opening that exact
 * hand resolves missing details afresh instead of caching absence for five minutes.
 * No polling: another read requires an open, selection or explicit refresh. */
export function useHandReviewDetails(
  base: HandRecord | undefined,
  heroId: string,
  isOpen: boolean
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    id: string;
    viewer: string;
    state: 'loading' | 'ready' | 'failed';
    hand?: HandRecord;
  } | null>(null);
  const me = base?.replay.players.find((p) => p.userId === heroId);
  const missing = !!me && !me.hole?.length && !me.privateHole?.length;
  const id = base?.id;

  useEffect(() => {
    setResult(null);
    if (!isOpen || !id || !missing || readLocalSession()?.userId !== heroId) return;
    let cancelled = false;
    const current = () => !cancelled && readLocalSession()?.userId === heroId;
    setResult({ id, viewer: heroId, state: 'loading' });
    void (async () => {
      try {
        const [{ handHistoryService }, { adaptServiceHandToPanel }] = await Promise.all([
          import('../services/HandHistoryService'),
          import('../lib/handHistoryAdapter'),
        ]);
        if (!current()) return;
        const fresh = await handHistoryService.getHand(id, { throwOnPrivateError: true });
        if (!current()) return;
        if (!fresh || fresh.id !== id) throw new Error('Hand Details Unavailable');
        setResult({
          id,
          viewer: heroId,
          state: 'ready',
          hand: adaptServiceHandToPanel(fresh, heroId),
        });
      } catch (error) {
        if (!current()) return;
        reportError(error, 'HandReview.loadPrivateDetails');
        setResult({ id, viewer: heroId, state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, id, heroId, missing, attempt]);

  const selected = result && result.id === id && result.viewer === heroId ? result : null;
  return {
    hand: selected?.hand ?? base,
    privateState: selected?.state ?? 'ready',
    refresh: () => setAttempt((value) => value + 1),
  };
}
