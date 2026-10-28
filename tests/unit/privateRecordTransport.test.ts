import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ clients: [] as any[], errors: [] as unknown[] }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (error: unknown) => state.errors.push(error),
}));
vi.mock('../../src/services/EngineStateClient', () => {
  class Client {
    callbacks = new Map<string, Set<(message: any) => void>>();
    closes = 0;
    constructor() {
      state.clients.push(this);
    }
    getStatus() {
      return 'connecting';
    }
    disconnect() {
      this.closes++;
    }
    resetSession() {
      this.callbacks.clear();
      this.disconnect();
    }
    onPrivateRecord(topic: string, callback: (message: any) => void) {
      const callbacks = this.callbacks.get(topic) ?? new Set();
      this.callbacks.set(topic, callbacks);
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    }
    emit(topic: string, ready: boolean) {
      for (const cb of this.callbacks.get(topic) ?? [])
        cb({ type: 'PRIVATE_RECORD_STATUS', topic, ready });
    }
  }
  return { EngineChannelClient: Client, engineChannelClient: new Client() };
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
async function load(url: string) {
  vi.resetModules();
  state.clients.splice(1);
  state.clients[0]?.callbacks.clear();
  state.errors.length = 0;
  vi.stubEnv('VITE_PRIVATE_RECORD_FALLBACK_URL', url);
  return import('../../src/services/PrivateRecordTransport');
}
describe('configured private record fallback lifecycle', () => {
  it('keeps existing behavior when unconfigured or pointed back at the same engine', async () => {
    const ordinary = await load('');
    ordinary.privateRecordTransport.onPrivateRecord(topic, () => {});
    expect(state.clients).toHaveLength(1);
    const invalid = await load('https://engine.smarter.poker/another-path');
    invalid.privateRecordTransport.onPrivateRecord(topic, () => {});
    expect(state.clients).toHaveLength(1);
    expect(state.errors).toHaveLength(1);
  });
  it('closes the standby only after its final consumer and fences old identity releases', async () => {
    const module = await load('https://records.invalid');
    const ready: unknown[] = [];
    const old = module.privateRecordTransport.onPrivateRecord(topic, (message) =>
      ready.push(message)
    );
    const standby = state.clients[1];
    module.resetPrivateRecordFallbackSession(true);
    const next = module.privateRecordTransport.onPrivateRecord(topic, (message) =>
      ready.push(message)
    );
    const before = standby.closes;
    old();
    expect(standby.closes).toBe(before);
    standby.emit(topic, true);
    expect(ready).toHaveLength(1);
    next();
    expect(standby.closes).toBe(before + 1);
  });
});
