import { useEffect, useRef } from 'react';
import { reportError } from '../utils/errorReporter';
import { stopLightningPlaying } from './lightningSessionApi';
import type { LightningPoolEntry } from './lightningSession';

/** Every Lightning leave door shares one durable stop before awaiting the anchor. */
export function useLightningLeaveStop(
  room: LightningPoolEntry | null,
  userId: string | null | undefined
) {
  const key = room && userId && userId !== 'guest' ? `${room.poolSessionId}/${userId}` : null;
  const current = useRef(key);
  current.current = key;
  const request = useRef<{ key: string; result: Promise<boolean> } | null>(null);
  useEffect(() => {
    current.current = key;
    return () => {
      current.current = null;
    };
  }, [key]);
  return async (): Promise<boolean> => {
    if (!room || !userId || userId === 'guest') return true;
    if (!key || current.current !== key) return false;
    if (request.current?.key === key) return request.current.result;
    const result = stopLightningPlaying(room.clusterId).then(
      (out) => out?.ok === true && current.current === key,
      (error) => {
        reportError(error, 'LightningLeaveStop.stop');
        return false;
      }
    );
    request.current = { key, result };
    const ok = await result;
    if (!ok && request.current?.result === result) request.current = null;
    return ok;
  };
}
