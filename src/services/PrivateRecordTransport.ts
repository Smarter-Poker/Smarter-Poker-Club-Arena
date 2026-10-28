import {
  EngineChannelClient,
  engineChannelClient,
  type PrivateRecordMessage,
} from './EngineStateClient';
import { PrivateRecordFailover } from './PrivateRecordFailover';
import { reportError } from '../utils/errorReporter';

/** A build must explicitly select a separately qualified gateway; unset keeps today's behavior. */
function configuredFallback(): EngineChannelClient | null {
  const configured = import.meta.env.VITE_PRIVATE_RECORD_FALLBACK_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const primary = new URL(import.meta.env.VITE_ENGINE_URL ?? 'https://engine.smarter.poker');
    if (
      url.protocol !== 'https:' ||
      url.origin === primary.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('private record fallback must be an independent HTTPS endpoint');
    return new EngineChannelClient({
      baseUrl: url.href.replace(/\/$/, ''),
      getToken: async () => {
        const { getFreshAccessToken } = await import('../lib/authToken');
        return getFreshAccessToken();
      },
    });
  } catch (error) {
    reportError(error, 'PrivateRecordTransport.configuration');
    return null;
  }
}
const fallback = configuredFallback();
let retained = 0;
let identityGeneration = 0;
const standby = fallback
  ? {
      onPrivateRecord(
        topic: string,
        callback: (message: PrivateRecordMessage) => void
      ): () => void {
        const generation = identityGeneration;
        retained++;
        const remove = fallback.onPrivateRecord(topic, callback);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          remove();
          if (generation === identityGeneration && --retained === 0) fallback.disconnect();
        };
      },
    }
  : null;
const transport = standby
  ? new PrivateRecordFailover(engineChannelClient, standby)
  : engineChannelClient;
export const privateRecordTransport = {
  onPrivateRecord: (topic: string, callback: (message: PrivateRecordMessage) => void) =>
    transport.onPrivateRecord(topic, callback),
  getStatus: () => engineChannelClient.getStatus(),
};
/** Called by the same synchronous identity owner as the primary socket. */
export function resetPrivateRecordFallbackSession(allowReconnect: boolean): void {
  identityGeneration++;
  retained = 0;
  fallback?.resetSession(allowReconnect);
}
