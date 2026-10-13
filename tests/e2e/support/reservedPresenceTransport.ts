import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type {
  CustomizationCertificationEnvironment,
  TemporaryCustomizationAccount,
} from './temporaryCustomizationAccount';

/** Real provider transport only; this does not claim a mounted owner-page test. */
export async function createReservedPresenceTransport(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount,
  topic: string
) {
  if (
    !account.email.startsWith('ca-customization-cert-') ||
    !account.email.endsWith('@example.invalid')
  )
    throw new Error('Presence certification requires a reserved identity.');
  if (!/^cert-presence:[0-9a-f-]{36}$/.test(topic))
    throw new Error('Presence certification requires a reserved topic.');
  const state = {
    tracks: 0,
    subscriptions: [] as string[],
    trackResults: [] as string[],
    joins: 0,
    leaves: 0,
    heartbeatReplies: 0,
    peers: [] as string[],
    errors: [] as string[],
  };
  const client = createClient(environment.supabaseUrl, environment.publishableKey, {
    auth: {
      storageKey: `cert-presence:${account.id}`,
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      // Hosted Node20 has no native WebSocket. This is the SDK's supported
      // transport option; no socket interception or fabricated frames.
      transport: WebSocket,
      logger: (kind, message, payload) => {
        // Count only named Presence pushes; never retain or print auth frames.
        if (
          kind === 'push' &&
          message.startsWith(`realtime:${topic} presence `) &&
          payload?.event === 'track'
        )
          state.tracks++;
      },
      heartbeatCallback: (status) => {
        if (status === 'ok') state.heartbeatReplies++;
      },
    },
  });
  let channel: RealtimeChannel | undefined;
  const join = () =>
    new Promise<void>((resolve, reject) => {
      const current = client.channel(topic, { config: { presence: { key: account.id } } });
      channel = current;
      current
        .on('presence', { event: 'sync' }, () => {
          state.peers = Object.keys(current.presenceState()).sort();
        })
        .on('presence', { event: 'join' }, () => {
          state.joins++;
        })
        .on('presence', { event: 'leave' }, () => {
          state.leaves++;
        })
        .subscribe((status) => {
          state.subscriptions.push(status);
          if (channel !== current) return;
          if (status === 'SUBSCRIBED') {
            void current
              .track({ userId: account.id, status: 'online' })
              .then((result) => {
                if (channel !== current) return;
                state.trackResults.push(result);
                if (result !== 'ok') {
                  const failure = `track:${result}`;
                  state.errors.push(failure);
                  reject(new Error(`Reserved Presence admission failed: ${failure}`));
                } else resolve();
              })
              .catch(() => {
                if (channel !== current) return;
                state.errors.push('track:rejected');
                reject(new Error('Reserved Presence admission failed: track:rejected'));
              });
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            state.errors.push(status);
            reject(new Error(`Reserved Presence admission failed: ${status}`));
          }
        });
    });
  const leave = async () => {
    const current = channel;
    channel = undefined;
    if (current) {
      const result = await client.removeChannel(current);
      if (result !== 'ok') throw new Error(`Reserved Presence leave failed: ${result}`);
    }
  };
  try {
    const result = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });
    if (result.error || result.data.user?.id !== account.id)
      throw new Error('Reserved Presence transport authenticated as the wrong identity.');
    if (!result.data.session?.access_token)
      throw new Error('Reserved Presence transport did not receive an authenticated session.');
    // The Auth callback starts asynchronous token propagation. Admission must
    // wait for the exact reserved session before joining, then for track's ack.
    await client.realtime.setAuth(result.data.session.access_token);
    await join();
  } catch (error) {
    await client.removeAllChannels();
    client.realtime.disconnect();
    await client.auth.signOut({ scope: 'local' });
    throw error;
  }
  return {
    state,
    leave,
    reconnect: async () => {
      await leave();
      // Recreate a channel after a supported disconnect. This is a fresh
      // transport join, not evidence of the application's automatic recovery.
      client.realtime.disconnect();
      const deadline = Date.now() + 2_000;
      while (client.realtime.isDisconnecting()) {
        if (Date.now() >= deadline) throw new Error('Reserved Presence disconnect did not finish.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await join();
    },
    close: async () => {
      const failures: unknown[] = [];
      try {
        await leave();
      } catch (error) {
        failures.push(error);
      } finally {
        client.realtime.disconnect();
      }
      try {
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error) throw result.error;
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, 'Reserved Presence teardown failed.');
    },
  };
}
