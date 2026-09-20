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
    /* SUBSCRIBED IS NOT 'live'. This asserted 'live' here, and the page painted a
       green Live badge on the strength of it - while game_management_events was
       not in the supabase_realtime publication at all, so the channel joined,
       reported SUBSCRIBED and then received nothing, for ever. Joining is a
       transport fact. Only an arriving row proves delivery, so only an arriving
       row promotes the status. The resync still runs on connect: it is the
       authoritative read this page is actually built on. */
    act(() => mocks.channelOptions.onSubscriptionStatus('SUBSCRIBED'));
    expect(result.current).toBe('connecting');
    expect(resync).toHaveBeenCalledOnce();

    act(() =>
      mocks.channelOptions.onPayload({
        new: {
          event_type: 'ticker_settings_changed',
          scope_kind: 'club',
          scope_id: 'club-1',
        },
      })
    );
    expect(result.current).toBe('live');
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

  it('routes every managed content invalidation through its named event', () => {
    renderHook(() =>
      useGameManagementRealtime({
        scope: 'club',
        scopeId: 'club-1',
        enabled: true,
        onResync: vi.fn(),
      })
    );

    act(() =>
      mocks.channelOptions.onPayload({
        new: {
          event_type: 'ticker_settings_changed',
          scope_kind: 'club',
          scope_id: 'club-1',
        },
      })
    );
    expect(mocks.emit).toHaveBeenLastCalledWith('TICKER_SETTINGS_CHANGED', {
      scope: 'club',
      scopeId: 'club-1',
    });

    act(() =>
      mocks.channelOptions.onPayload({
        new: {
          event_type: 'club_identity_changed',
          scope_kind: 'club',
          scope_id: 'club-1',
          club_id: 'club-1',
        },
      })
    );
    expect(mocks.emit).toHaveBeenLastCalledWith('CLUB_UPDATED', { clubId: 'club-1' });

    act(() =>
      mocks.channelOptions.onPayload({
        new: {
          event_type: 'announcement_changed',
          scope_kind: 'club',
          scope_id: 'club-1',
          club_id: 'club-1',
        },
      })
    );
    expect(mocks.emit).toHaveBeenLastCalledWith('ANNOUNCEMENT_CHANGED', {
      clubId: 'club-1',
      action: 'created',
    });
  });

  it('marks every terminal channel state degraded and resyncs on recovery', () => {
    const resync = vi.fn();
    const { result } = renderHook(() =>
      useGameManagementRealtime({
        scope: 'union',
        scopeId: 'union-1',
        enabled: true,
        onResync: resync,
      })
    );

    act(() => mocks.channelOptions.onSubscriptionStatus('TIMED_OUT'));
    expect(result.current).toBe('degraded');
    act(() => mocks.channelOptions.onSubscriptionStatus('CLOSED'));
    expect(result.current).toBe('degraded');
    act(() => mocks.channelOptions.onSubscriptionStatus('SUBSCRIBED'));
    /* Recovered transport, unproven delivery. Not 'degraded' any more, and not
       'live' either until something actually arrives. */
    expect(result.current).toBe('connecting');
    expect(resync).toHaveBeenCalledOnce();

    act(() =>
      mocks.channelOptions.onPayload({
        new: { scope_kind: 'union', scope_id: 'union-1', entity_type: 'table', entity_id: 't-9' },
      })
    );
    expect(result.current).toBe('live');

    /* And a later re-SUBSCRIBE must not demote a feed that has proven itself:
       a reconnect on a working channel is not a regression to unknown. */
    act(() => mocks.channelOptions.onSubscriptionStatus('SUBSCRIBED'));
    expect(result.current).toBe('live');
  });

  /**
   * THE BADGE MUST NOT GO GREEN ON A DEAD FEED. game_management_events carries
   * 1,027,487 writes over 3.1M rows and is one of the eleven tables the
   * 2026-09-06 publication trim keeps out, so this hook's channel joins and
   * receives nothing. GameManagementPage renders `status === 'live'` as a green
   * "Live"; anything else reads "Recovering". Subscribing must therefore never
   * reach 'live' on its own, whatever order the states arrive in.
   */
  it('never reports live from transport states alone, in any order', () => {
    const { result } = renderHook(() =>
      useGameManagementRealtime({
        scope: 'club',
        scopeId: 'club-1',
        enabled: true,
        onResync: vi.fn(),
      })
    );
    for (const state of ['SUBSCRIBED', 'TIMED_OUT', 'SUBSCRIBED', 'CLOSED', 'SUBSCRIBED']) {
      act(() => mocks.channelOptions.onSubscriptionStatus(state));
      expect(result.current, `${state} must not be reported as live`).not.toBe('live');
    }
  });
});
