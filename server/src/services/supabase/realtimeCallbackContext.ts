import { AsyncResource } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The shared Realtime socket can connect or reconnect in any manager's async
 * chain. Its callbacks belong to their registration context, never that socket
 * creator. Bind each handler separately so service dispatch can enter the
 * intended manager while manager handlers retain their immutable authority.
 */
export function bindRealtimeCallbacksToRegistration(client: SupabaseClient): SupabaseClient {
  const createChannel = client.channel;
  const boundChannels = new WeakSet<ReturnType<typeof createChannel>>();
  client.channel = function (this: SupabaseClient, ...args: Parameters<typeof createChannel>) {
    const channel = createChannel.apply(this, args);
    if (boundChannels.has(channel)) return channel;
    boundChannels.add(channel);

    const on = channel.on;
    channel.on = function (this: typeof channel, ...args: Parameters<typeof on>) {
      const [type, filter, callback] = args;
      return on.call(this, type, filter, AsyncResource.bind(callback, 'supabase-realtime-event'));
    } as typeof channel.on;

    const subscribe = channel.subscribe;
    channel.subscribe = function (this: typeof channel, ...args: Parameters<typeof subscribe>) {
      const [callback, timeout] = args;
      return subscribe.call(
        this,
        callback ? AsyncResource.bind(callback, 'supabase-realtime-status') : callback,
        timeout
      );
    };
    return channel;
  };
  return client;
}
