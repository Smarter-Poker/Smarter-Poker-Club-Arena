import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cloud: { data: null as null | { favorites: string[]; loadouts: unknown[] }, error: null },
  upsert: vi.fn(),
  rpc: vi.fn(),
  readCloud: vi.fn(),
  realtime: undefined as undefined | ((payload: { new: unknown }) => void),
  realtimeStatus: undefined as undefined | ((status: string) => void),
  removeChannel: vi.fn(),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => {
  const channel = {
    on: vi.fn((_event: string, _filter: unknown, callback: (payload: { new: unknown }) => void) => {
      mocks.realtime = callback;
      return channel;
    }),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      mocks.realtimeStatus = callback;
      callback?.('SUBSCRIBED');
      return channel;
    }),
  };
  return {
    supabase: {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: mocks.readCloud,
          upsert: mocks.upsert,
        };
        return builder;
      }),
      rpc: mocks.rpc,
      channel: vi.fn(() => channel),
      removeChannel: mocks.removeChannel,
    },
  };
});

import { useTableStudioCollections } from '../../src/hooks/useTableStudioCollections';

const loadout = {
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

function Harness() {
  const value = useTableStudioCollections(true, 'user-1');
  return (
    <div>
      <output data-testid="favorites">{value.favorites.join(',')}</output>
      <output data-testid="loadout">{value.loadouts[0]?.table_id || 'empty'}</output>
      <output data-testid="loadout-name">{value.loadouts[0]?.name || 'unnamed'}</output>
      <output data-testid="state">{value.syncState}</output>
      <output data-testid="realtime-state">{value.realtimeState}</output>
      <button onClick={() => value.toggleFavorite('table:classic_green')}>Favorite</button>
      <button onClick={() => value.toggleFavorite('background:place_paris')}>
        Favorite Background
      </button>
      <button onClick={() => value.saveLoadout(0, loadout)}>Save Loadout</button>
      <button
        onClick={() =>
          value.saveLoadout(0, {
            ...loadout,
            name: '  Friday   Night  ',
            saved_at: '2026-08-29T22:00:00.000Z',
          })
        }
      >
        Save Named Loadout
      </button>
      <button onClick={() => value.renameLoadout(0, '  Main   Event  ')}>Rename Loadout</button>
      <button onClick={() => value.clearLoadout(0)}>Clear Loadout</button>
      <button onClick={value.retrySync}>Retry Sync</button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useTableStudioCollections', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.cloud = { data: null, error: null };
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.readCloud.mockReset();
    mocks.readCloud.mockImplementation(() => Promise.resolve(mocks.cloud));
    mocks.removeChannel.mockReset();
    mocks.realtime = undefined;
    mocks.realtimeStatus = undefined;
  });

  it('uses local cache for first paint then reconciles the signed-in cloud row', async () => {
    localStorage.setItem('table-studio-favorites:user-1', JSON.stringify(['table:carbon_red']));
    mocks.cloud = {
      data: {
        favorites: ['cards:gold'],
        loadouts: [{ ...loadout, table_id: 'ocean_blue' }, null, null],
      },
      error: null,
    };
    render(<Harness />);

    expect(await screen.findByTestId('favorites')).toHaveTextContent('cards:gold');
    expect(screen.getByTestId('loadout')).toHaveTextContent('ocean_blue');
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    expect(JSON.parse(localStorage.getItem('table-studio-favorites:user-1') || '[]')).toEqual([
      'cards:gold',
    ]);
  });

  it('persists favorites and loadouts with the authenticated owner id', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_mutate_table_studio_preferences', {
        p_favorite_enabled: true,
        p_favorite_key: 'table:classic_green',
        p_loadout: null,
        p_loadout_slot: null,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Loadout' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenLastCalledWith('fn_mutate_table_studio_preferences', {
        p_favorite_enabled: null,
        p_favorite_key: null,
        p_loadout: loadout,
        p_loadout_slot: 0,
      })
    );
  });

  it('seeds an existing local collection into a new cloud row without another tap', async () => {
    localStorage.setItem('table-studio-favorites:user-1', JSON.stringify(['table:carbon_red']));
    localStorage.setItem(
      'table-studio-loadouts:user-1',
      JSON.stringify([{ ...loadout, table_id: 'carbon_red' }, null, null])
    );

    render(<Harness />);

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_seed_table_studio_preferences', {
        p_favorites: ['table:carbon_red'],
        p_loadouts: [{ ...loadout, table_id: 'carbon_red' }, null, null],
      })
    );
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
  });

  it('reconciles a realtime update from another device', async () => {
    render(<Harness />);
    await waitFor(() => expect(mocks.realtime).toBeTypeOf('function'));

    act(() => {
      mocks.realtime?.({
        new: { favorites: ['background:place_paris'], loadouts: [loadout, null, null] },
      });
    });

    expect(screen.getByTestId('favorites')).toHaveTextContent('background:place_paris');
    expect(screen.getByTestId('loadout')).toHaveTextContent('classic_green');
  });

  it('stores a clean player-facing name and lets the owner rename or clear the cartridge', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    fireEvent.click(screen.getByRole('button', { name: 'Save Named Loadout' }));
    expect(screen.getByTestId('loadout-name')).toHaveTextContent('Friday Night');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Loadout' }));
    expect(screen.getByTestId('loadout-name')).toHaveTextContent('Main Event');

    fireEvent.click(screen.getByRole('button', { name: 'Clear Loadout' }));
    expect(screen.getByTestId('loadout')).toHaveTextContent('empty');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
  });

  it('keeps a stale realtime echo from rolling back a newer local tap', async () => {
    const firstWrite = deferred<{ error: null }>();
    const secondWrite = deferred<{ error: null }>();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite Background' }));
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );

    act(() => {
      mocks.realtime?.({
        new: { favorites: ['table:classic_green'], loadouts: [null, null, null] },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );

    firstWrite.resolve({ error: null });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    secondWrite.resolve({ error: null });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    act(() => {
      mocks.realtime?.({
        new: { favorites: ['table:classic_green'], loadouts: [null, null, null] },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );
  });

  it('provides the retry promised by the sync error state', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));

    mocks.cloud = {
      data: { favorites: ['cards:gold'], loadouts: [null, null, null] },
      error: null,
    };
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green,cards:gold');
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_mutate_table_studio_preferences', {
      p_favorite_enabled: true,
      p_favorite_key: 'table:classic_green',
      p_loadout: null,
      p_loadout_slot: null,
    });
  });

  it('reconnects a failed realtime channel when the player retries sync', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('realtime-state')).toHaveTextContent('live'));

    act(() => mocks.realtimeStatus?.('CHANNEL_ERROR'));
    expect(screen.getByTestId('realtime-state')).toHaveTextContent('error');

    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(screen.getByTestId('realtime-state')).toHaveTextContent('live'));
    expect(mocks.removeChannel).toHaveBeenCalled();
  });
});
