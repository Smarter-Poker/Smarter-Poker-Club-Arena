import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
const f = vi.hoisted(() => ({ options: null as any }));
vi.mock('../../src/lib/authToken', () => ({ getFreshAccessToken: vi.fn() }));
vi.mock('../../src/services/EngineStateClient', () => ({
  default: class {
    constructor(options: any) {
      f.options = options;
    }
    connect = vi.fn();
    disconnect = vi.fn();
    noteScheduledRestart = vi.fn();
  },
}));
import { useEngineTableState } from '../../src/hooks/useEngineTableState';
beforeEach(() => {
  f.options = null;
});
describe('Lightning original-intent mixed engine compatibility', () => {
  it('requires the current authenticated room snapshot and forgets capability at disconnect', () => {
    const h = renderHook(({ room }) => useEngineTableState(room), {
      initialProps: { room: 'pool-a' },
    });
    const send = (state: object) => act(() => f.options.onSnapshot(state, 1));
    act(() => f.options.onStatus('connected'));
    send({ table_id: 'pool-a', lightning: {} }); // serving old engine
    expect(h.result.current.lightningOriginalTopUpReady).toBe(false);
    send({ table_id: 'pool-b', lightning_original_top_up: true });
    expect(h.result.current.lightningOriginalTopUpReady).toBe(false);
    send({ table_id: 'pool-a', lightning_original_top_up: true });
    expect(h.result.current.lightningOriginalTopUpReady).toBe(true);
    act(() => f.options.onStatus('reconnecting'));
    expect(h.result.current.lightningOriginalTopUpReady).toBe(false);
    act(() => f.options.onStatus('connected'));
    expect(h.result.current.lightningOriginalTopUpReady).toBe(false); // stale snapshot cannot authorize
    send({ table_id: 'pool-a', lightning_original_top_up: true });
    expect(h.result.current.lightningOriginalTopUpReady).toBe(true);
    h.rerender({ room: 'pool-b' });
    expect(h.result.current.lightningOriginalTopUpReady).toBe(false);
  });
  it('the active and waiting producer and actual automatic caller share the explicit contract', () => {
    const host = readFileSync('server/src/lightning/LightningHandHost.ts', 'utf8');
    expect(host.match(/lightning_original_top_up: true/g)).toHaveLength(2);
    expect(readFileSync('src/pages/TablePage.tsx', 'utf8')).toContain(
      'originalIntentReady: lightningOriginalTopUpReady'
    );
  });
});
