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
  it('reports a player its own anchor sees absent, and refuses presence from another cluster', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const n = await reconcileLightningPresence({
      openSessions: async () => [{ clusterId: C, playerId: P }],
      isConnected: () => false,
      presenceSource: () => [
        { tableId: 'other', clusterId: 'other', players: [{ userId: P, presence: 'connected' }] },
        { tableId: 'anchor', clusterId: C, players: [{ userId: P, presence: 'disconnected' }] },
      ],
      report,
    } as any);
    expect(n).toBe(1);
    expect(report.disconnected).toHaveBeenCalledWith(C, P);
  });
  it('never stamps a player no anchor here has reported on yet (the 13:56 pilot expulsion)', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const horses = Array.from({ length: 54 }, (_, i) => ({
      clusterId: C,
      playerId: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
    }));
    for (const reports of [
      [],
      [
        {
          tableId: 'other',
          clusterId: 'other',
          players: [{ userId: horses[0].playerId, presence: 'connected' }],
        },
      ],
      [
        {
          tableId: 'anchor',
          clusterId: C,
          players: [{ userId: horses[1].playerId, presence: 'unknown' }],
        },
      ],
    ]) {
      const n = await reconcileLightningPresence({
        openSessions: async () => horses,
        presenceSource: () => reports,
        report,
      } as any);
      expect(n).toBe(0);
    }
    expect(report.disconnected).not.toHaveBeenCalled();
  });
  it('GameServer waits out the maintenance freeze before the boot pass judges anyone', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const scheduleLightningPresenceReconcile');
    const body = source.slice(start, start + 1200);
    expect(start).toBeGreaterThan(0);
    expect(body.indexOf('isMaintenanceFrozen()')).toBeGreaterThan(0);
    expect(body.indexOf('isMaintenanceFrozen()')).toBeLessThan(
      body.indexOf('reconcileLightningPresence(')
    );
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
