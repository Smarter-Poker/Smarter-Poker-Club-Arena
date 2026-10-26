/**
 * THE CONVERSION NOTICE ARRIVES LIVE (2026-10-24).
 *
 * A player seated at a Lightning anchor table whose game converts is offered
 * View Game when fn_lightning_my_session names their pool session. The hook
 * first waited on a postgres_changes UPDATE of `cash_games`, which is not in
 * the supabase_realtime publication and never fired. Then it re-read on a
 * 30 s clock. Now the transaction that opens the pool session sends one
 * private signal on the player's own `profile-account:<user>` topic, and
 * ProfileAccountSync relays it as LIGHTNING_ROOM_OPENED. These tests pin the
 * subscription target end to end: the hook listens to that bus event and
 * nothing else, the relay produces it, and the migration sends it from both
 * writers of the pool session.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUSTER = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const POOL = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const OTHER_USER = '66666666-6666-4666-8666-666666666666';

const rpc = vi.fn();
const channel = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    channel: (...a: unknown[]) => channel(...a),
    removeChannel: vi.fn(),
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
/* tests/setup.ts mocks MasterBus with no-ops; these tests need its delivery. */
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    masterBus: {
      subscribe: (type: string, handler: (event: { payload: unknown }) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(handler);
        return () => handlers.get(type)?.delete(handler);
      },
      emit: (type: string, payload: unknown) => {
        handlers.get(type)?.forEach((handler) => handler({ payload }));
      },
      reset: () => handlers.clear(),
    },
  };
});
vi.mock('../../src/core/MasterBus', () => ({ masterBus: bus.masterBus }));

import { masterBus } from '../../src/core/MasterBus';
import {
  LIGHTNING_ROOM_OPENED_EVENT,
  useLightningAnchorHandoff,
} from '../../src/lightning/useLightningAnchorHandoff';
import { resetLightningRegistryForTests } from '../../src/lightning/lightningSession';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const READY = {
  pool_session_id: POOL,
  state: 'active',
  cluster_mode: 'lightning',
  stack: 200,
  in_hand: false,
  anchor_table_id: ANCHOR,
  seat_number: 3,
  occupancy_id: null,
};
const NOT_YET = { pool_session_id: null, cluster_mode: 'pending_on' };

function mountSeated(clusterId: string | null = CLUSTER, userId = USER) {
  return renderHook(() =>
    useLightningAnchorHandoff({
      tableId: ANCHOR,
      clusterId,
      userId,
      isPoolSession: false,
      heroBoughtIn: true,
      follow: vi.fn(),
    })
  );
}

/** Emit the relayed signal and let the read it starts settle. */
async function signal(payload: { userId: string; clusterId?: string }) {
  await act(async () => {
    masterBus.emit(LIGHTNING_ROOM_OPENED_EVENT, payload);
    await vi.advanceTimersByTimeAsync(1000);
  });
}

const sessionReads = () =>
  rpc.mock.calls.filter((call) => call[0] === 'fn_lightning_my_session').length;

beforeEach(() => {
  masterBus.reset();
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  resetLightningRegistryForTests();
  rpc.mockReset().mockResolvedValue({ data: NOT_YET, error: null });
  channel.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the seated conversion notice listens to the room signal, not a table or a clock', () => {
  it('subscribes to LIGHTNING_ROOM_OPENED, opens no realtime channel and arms no timer', async () => {
    const subscribe = vi.spyOn(masterBus, 'subscribe');
    const { unmount } = mountSeated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(subscribe.mock.calls.map((call) => call[0])).toContain(LIGHTNING_ROOM_OPENED_EVENT);
    expect(LIGHTNING_ROOM_OPENED_EVENT).toBe('LIGHTNING_ROOM_OPENED');
    expect(channel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionReads()).toBe(1);
    // An hour of silence costs nothing: no read happens without a signal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(sessionReads()).toBe(1);
    unmount();
    subscribe.mockRestore();
  });

  it('offers the room the moment its own Cluster is signalled', async () => {
    const { result } = mountSeated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.readyPoolSessionId).toBeNull();
    rpc.mockResolvedValue({ data: READY, error: null });
    await signal({ userId: USER, clusterId: CLUSTER });
    expect(result.current.readyPoolSessionId).toBe(POOL);
    expect(rpc).toHaveBeenLastCalledWith('fn_lightning_my_session', { p_cluster_id: CLUSTER });
  });

  it('ignores a signal for another Cluster or another account', async () => {
    mountSeated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await signal({ userId: USER, clusterId: OTHER_CLUSTER });
    await signal({ userId: OTHER_USER, clusterId: CLUSTER });
    await signal({ userId: OTHER_USER });
    expect(sessionReads()).toBe(1);
  });

  it('re-reads once when the carrier rejoined (a signal may have been missed)', async () => {
    const { result } = mountSeated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rpc.mockResolvedValue({ data: READY, error: null });
    await signal({ userId: USER });
    expect(sessionReads()).toBe(2);
    expect(result.current.readyPoolSessionId).toBe(POOL);
  });

  it('stops listening on unmount', async () => {
    const { unmount } = mountSeated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await signal({ userId: USER, clusterId: CLUSTER });
    expect(sessionReads()).toBe(1);
  });

  it('a Classic game is never watched', async () => {
    const subscribe = vi.spyOn(masterBus, 'subscribe');
    mountSeated(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(subscribe.mock.calls.map((call) => call[0])).not.toContain(LIGHTNING_ROOM_OPENED_EVENT);
    await signal({ userId: USER, clusterId: CLUSTER });
    expect(rpc).not.toHaveBeenCalled();
    subscribe.mockRestore();
  });

  it('the hook source carries no interval, no row subscription and no cash_games reference', () => {
    const src = read('src/lightning/useLightningAnchorHandoff.ts').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      ''
    );
    expect(src).not.toMatch(
      /setInterval|postgres_changes|supabase\.channel|LIGHTNING_LOBBY_REFRESH_MS/
    );
    expect(src).not.toContain("'cash_games'");
    expect(src).toContain('masterBus.subscribe(LIGHTNING_ROOM_OPENED_EVENT');
  });
});

describe('the relay and the database send the same signal', () => {
  const RELAY = read('src/hooks/useProfileAccountSync.ts');
  const FILE =
    'supabase/migrations/20261025025154_a_lightning_pool_session_tells_its_player_the_moment_it_open.sql';
  const SQL = read(FILE);
  const code = SQL.replace(/--[^\n]*/g, '');

  it('ProfileAccountSync relays lightning_room_opened from the owner topic', () => {
    expect(RELAY).toContain("payload.reason === 'lightning_room_opened'");
    expect(RELAY).toContain(
      "masterBus.emit('LIGHTNING_ROOM_OPENED', { userId, clusterId: payload.cluster_id })"
    );
    expect(RELAY).toContain("masterBus.emit('LIGHTNING_ROOM_OPENED', { userId })");
  });

  it('both writers of the pool session send it, on the existing owner topic and event', () => {
    for (const sig of [
      'public.fn_cash_cluster_commit_lightning(uuid,uuid)',
      'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
    ])
      expect(code).toContain(`('${sig}', '`);
    expect(code.match(/PERFORM realtime\.send\(/g)).toHaveLength(2);
    expect(code.match(/'account_changed', 'profile-account:' \|\| /g)).toHaveLength(2);
    expect(
      code.match(/'reason', 'lightning_room_opened', 'domains', '\[\]'::jsonb\)/g)
    ).toHaveLength(2);
    expect(code).toContain('ps.cluster_epoch = v_epoch AND ps.exited_at IS NULL');
  });

  it('is guarded by the live pre-images, keeps every attribute, and widens nothing', () => {
    expect(code).toContain("'35cf4a34f4e2cce1cc2a77b8e5576de4'");
    expect(code).toContain("'634a4efa3919619a00347a1758eda79e'");
    expect(code).toContain('LIGHTNING_ROOM_SIGNAL_SOURCE_CHANGED');
    expect(code).toContain('LIGHTNING_ROOM_SIGNAL_ATTRIBUTES');
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(code).not.toMatch(
      /ALTER PUBLICATION|CREATE POLICY|ALTER POLICY|\bGRANT\b|\bREVOKE\b|is_horse|SECURITY INVOKER/i
    );
    // Payload is identity only: no stack, seat or row image.
    expect(code).not.toMatch(/'stack'|'starting_stack'|to_jsonb\(ps\)|to_jsonb\(s\)/);
  });
});
