import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../services/supabase/client.js', () => ({ supabase: {} }));
const { reconcileLightningPresence } = await import('./LightningPresenceReconciliation.js');
const C = '00000000-0000-4000-8000-000000000001';
const P = '00000000-0000-4000-8000-000000000002';

describe('boot presence uses the same authority as the matcher', () => {
  it('keeps a connected anchor seat without a room socket, including a stale room disconnect', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const n = await reconcileLightningPresence({
      openSessions: async () => [{ clusterId: C, playerId: P }],
      isConnected: () => false,
      presenceSource: () => [
        { tableId: 'anchor', clusterId: C, players: [{ userId: P, presence: 'connected' }] },
        { tableId: 'room', clusterId: C, players: [{ userId: P, presence: 'disconnected' }] },
      ],
      report,
    } as any);
    expect(n).toBe(0);
    expect(report.disconnected).not.toHaveBeenCalled();
  });
  it('still reports an unknown player and refuses presence from another cluster', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const n = await reconcileLightningPresence({
      openSessions: async () => [{ clusterId: C, playerId: P }],
      isConnected: () => false,
      presenceSource: () => [
        { tableId: 'other', clusterId: 'other', players: [{ userId: P, presence: 'connected' }] },
      ],
      report,
    } as any);
    expect(n).toBe(1);
    expect(report.disconnected).toHaveBeenCalledWith(C, P);
  });
  it('does not turn an unreadable presence source into a disconnect observation', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const warn = vi.fn();
    const n = await reconcileLightningPresence({
      openSessions: async () => [{ clusterId: C, playerId: P }],
      isConnected: () => false,
      presenceSource: () => {
        throw new Error('presence unavailable');
      },
      report,
      logger: { warn },
    } as any);
    expect(n).toBe(0);
    expect(report.disconnected).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
  it('GameServer supplies its complete anchor and room presence source', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const start = source.indexOf('void reconcileLightningPresence({');
    const call = source.slice(start, source.indexOf('});', start));
    expect(call).toContain('presenceSource: () => this.lightningPresenceReports()');
    expect(call).not.toContain('hasClusterSocket');
  });
});
