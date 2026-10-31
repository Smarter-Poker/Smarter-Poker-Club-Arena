import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openState } from './state.mjs';
import { createIntake, CODEX, TOPIC } from './core.mjs';
const execute = promisify(execFile);
export default {
  id: 'production-alerts-native-wakeup',
  name: 'Production Alerts Native Wakeup',
  register(api) {
    let intake;
    let channelStatus = 'not_started';
    api.registerGatewayMethod('production-alerts-native-wakeup.status', ({ respond }) => {
      respond(true, { channelStatus, ...(intake?.status() ?? { state: 'not_started' }) });
    });
    api.registerService({
      id: 'production-alerts-native-wakeup',
      async start() {
        if (this.starting || this.store) throw new Error('native intake service already started');
        this.starting = true;
        try {
          const { publishableKey, stateDirectory } = api.pluginConfig ?? {};
          const directory = resolve(stateDirectory ?? '');
          if (
            !directory.startsWith('/Volumes/SmarterWork/agent-work/') ||
            typeof publishableKey !== 'string' ||
            (!publishableKey.startsWith('sb_publishable_') && !publishableKey.startsWith('eyJ'))
          )
            throw new Error('native wake configuration invalid');
          // Keys must be public client keys. Never accept privileged JWTs.
          if (publishableKey.startsWith('eyJ')) {
            let claims;
            try {
              claims = JSON.parse(
                Buffer.from(publishableKey.split('.')[1], 'base64url').toString()
              );
            } catch {
              throw new Error('invalid public key');
            }
            if (claims.role !== 'anon')
              throw new Error('only receive-only public client keys are supported');
          }
          if ((await stat('/Volumes/SmarterWork')).dev === (await stat('/')).dev)
            throw new Error('external work volume is not mounted');
          const { stdout: capabilityOutput } = await execute(
            '/usr/bin/security',
            [
              'find-generic-password',
              '-s',
              'Smarter.Poker Production Alerts Receive v1',
              '-a',
              'production-alerts-native-wakeup',
              '-w',
            ],
            { timeout: 5_000, maxBuffer: 4096, encoding: 'utf8', shell: false }
          );
          const capability = capabilityOutput.trim();
          if (!/^[0-9a-f]{64}$/.test(capability))
            throw new Error('native receive credential unavailable');
          const channelName = TOPIC + ':' + capability;
          const client = createClient('https://kuklfnapbkmacvwxktbh.supabase.co', publishableKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: {
              fetch: (url, options) =>
                fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }),
            },
          });
          this.client = client;
          const store = await openState(directory);
          this.store = store;
          intake = createIntake({
            load: store.load,
            save: store.save,
            async pending(ids) {
              const { data, error } = await client.rpc('fn_ca_native_alert_pending', {
                p_active: ids,
                p_channel: channelName,
              });
              if (error) throw new Error('opaque pending read unavailable');
              return data;
            },
            async queue(args) {
              const { stdout } = await execute(CODEX, args, {
                timeout: 30_000,
                maxBuffer: 16_384,
                encoding: 'utf8',
                shell: false,
              });
              return stdout;
            },
            async wake(args) {
              await execute('/usr/bin/open', args, {
                timeout: 10_000,
                maxBuffer: 4096,
                encoding: 'utf8',
                shell: false,
              });
            },
          });
          const onEvent = () => {
            void intake
              .event()
              .catch(() =>
                api.logger.error(
                  'Production Alerts intake unavailable; retained state requires inspection'
                )
              );
          };
          this.channel = client
            .channel(channelName, { config: { private: true } })
            .on('broadcast', { event: 'inbox_committed' }, onEvent)
            .on('broadcast', { event: 'intake_acknowledged' }, onEvent)
            .subscribe((status) => {
              channelStatus = status;
              if (status === 'SUBSCRIBED') onEvent();
              else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status))
                api.logger.error(`Production Alerts event channel ${status}`);
            });
        } catch (error) {
          await this.client?.removeAllChannels();
          this.store?.close();
          this.store = null;
          throw error;
        } finally {
          this.starting = false;
        }
      },
      async stop() {
        if (this.client && this.channel) await this.client.removeChannel(this.channel);
        await intake?.settled();
        this.store?.close();
        this.store = null;
      },
    });
  },
};
