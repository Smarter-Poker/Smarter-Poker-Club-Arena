import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  channelOptions: undefined as any,
  emit: vi.fn(),
}));

vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: any) => {
    mocks.channelOptions = options;
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));

import { useGameManagementRealtime } from '../../src/hooks/useGameManagementRealtime';

describe('useGameManagementRealtime', () => {
  beforeEach(() => {
    mocks.channelOptions = undefined;
    mocks.emit.mockReset();
  });

  it('subscribes to only the active management scope and resyncs after connection', () => {
    const resync = vi.fn();
    const { result } = renderHook(() =>
      useGameManagementRealtime({
        scope: 'club',
        scopeId: 'club-1',
        enabled: true,
        onResync: resync,
      })
    );
    expect(mocks.channelOptions).toMatchObject({
      table: 'game_management_events',
      filter: 'scope_id=eq.club-1',
      event: 'INSERT',
    });
    act(() => mocks.channelOptions.onSubscriptionStatus('SUBSCRIBED'));
    expect(result.current).toBe('live');
    expect(resync).toHaveBeenCalledOnce();
  });

  it('ignores wrong-scope rows and emits a named table invalidation for its scope', () => {
    renderHook(() =>
      useGameManagementRealtime({
        scope: 'union',
        scopeId: 'union-1',
        enabled: true,
        onResync: vi.fn(),
      })
    );
    act(() =>
      mocks.channelOptions.onPayload({
        new: { scope_kind: 'union', scope_id: 'union-2', entity_type: 'table', entity_id: 't-0' },
      })
    );
    expect(mocks.emit).not.toHaveBeenCalled();
    act(() =>
      mocks.channelOptions.onPayload({
        new: { scope_kind: 'union', scope_id: 'union-1', entity_type: 'table', entity_id: 't-1' },
      })
    );
    expect(mocks.emit).toHaveBeenCalledWith('TABLE_UPDATED', { tableId: 't-1' });
  });

  it('surfaces a degraded channel and routes access revocation immediately', () => {
    const { result } = renderHook(() =>
      useGameManagementRealtime({
        scope: 'club',
        scopeId: 'club-1',
        enabled: true,
        onResync: vi.fn(),
      })
    );
    act(() => mocks.channelOptions.onSubscriptionStatus('CHANNEL_ERROR'));
    expect(result.current).toBe('degraded');
    act(() =>
      mocks.channelOptions.onPayload({
        new: {
          event_type: 'management_access_changed',
          scope_kind: 'club',
          scope_id: 'club-1',
          club_id: 'club-1',
        },
      })
    );
    expect(mocks.emit).toHaveBeenCalledWith('GAME_MANAGEMENT_ACCESS_CHANGED', {
      scope: 'club',
      scopeId: 'club-1',
      clubId: 'club-1',
    });
  });
});
