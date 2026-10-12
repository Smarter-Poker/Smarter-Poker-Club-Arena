import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cloud: {
    data: null as null | { favorites: string[]; loadouts: unknown[]; revision: number },
    error: null,
  },
  upsert: vi.fn(),
  rpc: vi.fn(),
  readCloud: vi.fn(),
  realtime: undefined as undefined | ((payload: { new: unknown; eventType?: string }) => void),
  realtimeStatus: undefined as undefined | ((status: string) => void),
  removeChannel: vi.fn(),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => {
  const channel = {
    on: vi.fn(
      (
        _event: string,
        _filter: unknown,
        callback: (payload: { new: unknown; eventType?: string }) => void
      ) => {
        mocks.realtime = callback;
        return channel;
      }
    ),
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
  face_deck_id: 'house-classic',
};

function Harness({ userId = 'user-1', isOpen = true }: { userId?: string; isOpen?: boolean }) {
  const value = useTableStudioCollections(isOpen, userId);
  return (
    <div>
      <output data-testid="favorites">{value.favorites.join(',')}</output>
      <output data-testid="loadout">{value.loadouts[0]?.table_id || 'empty'}</output>
      <output data-testid="loadout-name">{value.loadouts[0]?.name || 'unnamed'}</output>
      <output data-testid="face-deck">{value.loadouts[0]?.face_deck_id || 'empty'}</output>
      <output data-testid="state">{value.syncState}</output>
      <output data-testid="realtime-state">{value.realtimeState}</output>
      <button onClick={() => value.toggleFavorite('table:classic_green')}>Favorite</button>
      <button onClick={() => value.toggleFavorite('background:place_paris')}>
        Favorite Background
      </button>
      <button
        onClick={() => {
          for (let index = 0; index < 10; index += 1) {
            value.toggleFavorite(`rapid:${index}`);
          }
        }}
      >
        Rapid Favorites
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

type MockPreferenceRow = {
  favorites: string[];
  loadouts: unknown[];
  revision: number;
};

type MockRpcSuccess = { data: MockPreferenceRow[]; error: null };

const schemaRpcRows = new Map<string, MockPreferenceRow>();

function schemaRpcSuccess(functionName: string, args: Record<string, unknown>): MockRpcSuccess {
  const owner = String(args.p_expected_user_id);
  const existing = schemaRpcRows.get(owner);
  const cloud = mocks.cloud.data;
  const base: MockPreferenceRow = existing ?? {
    favorites: cloud ? [...cloud.favorites] : [],
    loadouts: cloud ? [...cloud.loadouts] : [null, null, null],
    revision: cloud?.revision ?? 0,
  };

  let next: MockPreferenceRow;
  if (functionName === 'fn_seed_table_studio_preferences') {
    next = existing ?? {
      favorites: [...(args.p_favorites as string[])],
      loadouts: [...(args.p_loadouts as unknown[])],
      revision: 0,
    };
  } else if (functionName === 'fn_mutate_table_studio_preferences') {
    const favoriteKey = args.p_favorite_key;
    const loadoutSlot = args.p_loadout_slot;
    const favorites = [...base.favorites];
    const loadouts = [...base.loadouts];
    if (typeof favoriteKey === 'string') {
      if (args.p_favorite_enabled === true) {
        favorites.splice(
          0,
          favorites.length,
          favoriteKey,
          ...favorites.filter((key) => key !== favoriteKey)
        );
      } else {
        favorites.splice(0, favorites.length, ...favorites.filter((key) => key !== favoriteKey));
      }
    } else if (typeof loadoutSlot === 'number') {
      loadouts[loadoutSlot] = args.p_loadout;
    }
    next = { favorites, loadouts, revision: base.revision + 1 };
  } else {
    throw new Error(`Unexpected Table Studio RPC ${functionName}`);
  }

  schemaRpcRows.set(owner, next);
  return {
    data: [
      { favorites: [...next.favorites], loadouts: [...next.loadouts], revision: next.revision },
    ],
    error: null,
  };
}

function schemaResultForCall(callIndex: number): MockRpcSuccess {
  const [functionName, args] = mocks.rpc.mock.calls[callIndex] as [string, Record<string, unknown>];
  return schemaRpcSuccess(functionName, args);
}

async function settleLocalWrites(buttonNames: string[]) {
  const writes = buttonNames.map(() => deferred<MockRpcSuccess>());
  const startingCallCount = mocks.rpc.mock.calls.length;
  for (const write of writes) {
    mocks.rpc.mockImplementationOnce(() => write.promise);
  }
  for (const buttonName of buttonNames) {
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
  }
  for (let index = 0; index < writes.length; index += 1) {
    await act(async () => {
      writes[index].resolve(schemaResultForCall(startingCallCount + index));
      await writes[index].promise;
    });
    if (index < writes.length - 1) {
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(startingCallCount + index + 2));
    }
  }
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
}

describe('useTableStudioCollections', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.cloud = { data: null, error: null };
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.rpc.mockReset();
    schemaRpcRows.clear();
    mocks.rpc.mockImplementation(schemaRpcSuccess);
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
        revision: 1,
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

  it('rejects malformed hydration collections without poisoning the revision floor', async () => {
    localStorage.setItem('table-studio-favorites:user-1', JSON.stringify(['cards:local']));
    mocks.readCloud.mockResolvedValueOnce({
      data: { favorites: null, loadouts: [null, null, null], revision: 999 },
      error: null,
    });
    const view = render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:local');

    mocks.cloud = {
      data: { favorites: ['cards:recovered'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    view.rerender(<Harness isOpen={false} />);
    view.rerender(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:recovered');
  });

  it('ignores a stale hydration error after a newer mutation has synced', async () => {
    const staleRead = deferred<{ data: null; error: Error }>();
    mocks.readCloud.mockImplementationOnce(() => staleRead.promise);
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    await act(async () => {
      staleRead.resolve({ data: null, error: new Error('stale read failed') });
      await staleRead.promise;
    });

    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
  });

  it('upgrades a legacy saved look to House Classic without discarding it', async () => {
    const legacyLoadout = {
      theme_id: loadout.theme_id,
      table_id: loadout.table_id,
      button_id: loadout.button_id,
      background_id: loadout.background_id,
      cards_id: loadout.cards_id,
    };
    localStorage.setItem(
      'table-studio-loadouts:user-1',
      JSON.stringify([legacyLoadout, null, null])
    );

    render(<Harness />);

    expect(await screen.findByTestId('face-deck')).toHaveTextContent('house-classic');
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'fn_seed_table_studio_preferences',
        expect.objectContaining({
          p_expected_user_id: 'user-1',
          p_loadouts: [expect.objectContaining({ face_deck_id: 'house-classic' }), null, null],
        })
      )
    );
  });

  it('persists favorites and loadouts with the authenticated owner id', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_mutate_table_studio_preferences', {
        p_expected_user_id: 'user-1',
        p_favorite_enabled: true,
        p_favorite_key: 'table:classic_green',
        p_loadout: null,
        p_loadout_slot: null,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Loadout' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenLastCalledWith('fn_mutate_table_studio_preferences', {
        p_expected_user_id: 'user-1',
        p_favorite_enabled: null,
        p_favorite_key: null,
        p_loadout: loadout,
        p_loadout_slot: 0,
      })
    );
  });

  it.each([
    ['missing revision', { favorites: ['table:classic_green'], loadouts: [null, null, null] }],
    [
      'invalid revision',
      {
        favorites: ['table:classic_green'],
        loadouts: [null, null, null],
        revision: 'invalid',
      },
    ],
    [
      'invalid favorites at a high revision',
      { favorites: null, loadouts: [null, null, null], revision: 999 },
    ],
    [
      'invalid loadouts at a high revision',
      { favorites: ['table:classic_green'], loadouts: null, revision: 999 },
    ],
  ])('keeps a mutation retryable after a receipt with %s', async (_label, receipt) => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: [receipt], error: null });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
    expect(schemaRpcRows.get('user-1')?.revision).toBe(1);
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
        p_expected_user_id: 'user-1',
        p_favorites: ['table:carbon_red'],
        p_loadouts: [{ ...loadout, table_id: 'carbon_red' }, null, null],
      })
    );
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
  });

  it.each([
    ['missing revision', { favorites: ['table:carbon_red'], loadouts: [null, null, null] }],
    [
      'invalid revision',
      { favorites: ['table:carbon_red'], loadouts: [null, null, null], revision: 'invalid' },
    ],
    ['invalid favorites', { favorites: null, loadouts: [null, null, null], revision: 0 }],
    ['invalid loadouts', { favorites: ['table:carbon_red'], loadouts: null, revision: 0 }],
  ])('refuses a seed receipt with %s instead of reporting synced', async (_label, receipt) => {
    localStorage.setItem('table-studio-favorites:user-1', JSON.stringify(['table:carbon_red']));
    mocks.rpc.mockResolvedValueOnce({ data: [receipt], error: null });

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:carbon_red');
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_seed_table_studio_preferences',
      expect.objectContaining({ p_expected_user_id: 'user-1' })
    );
  });

  it('reconciles a realtime update from another device', async () => {
    render(<Harness />);
    await waitFor(() => expect(mocks.realtime).toBeTypeOf('function'));

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['background:place_paris'],
          loadouts: [loadout, null, null],
          revision: 0,
        },
      });
    });

    expect(screen.getByTestId('favorites')).toHaveTextContent('background:place_paris');
    expect(screen.getByTestId('loadout')).toHaveTextContent('classic_green');
  });

  it('ignores DELETE payloads without interpreting them as empty collections', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    act(() => {
      mocks.realtime?.({ eventType: 'DELETE', new: null });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    expect(screen.getByTestId('realtime-state')).toHaveTextContent('live');
  });

  it.each([
    ['missing revision', { favorites: ['cards:invalid'], loadouts: [null, null, null] }],
    [
      'invalid revision',
      { favorites: ['cards:invalid'], loadouts: [null, null, null], revision: 'invalid' },
    ],
    ['invalid favorites', { favorites: null, loadouts: [null, null, null], revision: 1 }],
    ['invalid loadouts', { favorites: ['cards:invalid'], loadouts: null, revision: 1 }],
    ['missing row', null],
  ])('refuses a non-delete realtime receipt with %s', async (_label, row) => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    act(() => {
      mocks.realtime?.({ new: row });
    });
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('cards:invalid');
    expect(screen.getByTestId('state')).toHaveTextContent('error');
    expect(screen.getByTestId('realtime-state')).toHaveTextContent('error');
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
    const firstWrite = deferred<MockRpcSuccess>();
    const secondWrite = deferred<MockRpcSuccess>();
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
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 1,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );

    firstWrite.resolve(schemaResultForCall(0));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    secondWrite.resolve(schemaResultForCall(1));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 1,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );

    // A later, strictly newer remote return to the same JSON is authoritative.
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 3,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');

    // Revision order, not repeated JSON, decides each later remote return.
    act(() => {
      mocks.realtime?.({
        new: { favorites: ['cards:remote'], loadouts: [null, null, null], revision: 4 },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:remote');
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['background:place_paris', 'table:classic_green'],
          loadouts: [null, null, null],
          revision: 5,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'background:place_paris,table:classic_green'
    );
  });

  it('keeps repeated enable, disable, enable echoes in their committed order', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await settleLocalWrites(['Favorite', 'Favorite', 'Favorite']);

    // The first enable has the same JSON as the final enable. Its older
    // revision cannot impersonate the final committed row.
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 1,
        },
      });
    });
    act(() => {
      mocks.realtime?.({
        new: { favorites: [], loadouts: [null, null, null], revision: 2 },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 3,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
  });

  it('applies the newest revision when remote truth lands before the final pump cleanup', async () => {
    const firstWrite = deferred<{
      data: Array<{ favorites: string[]; loadouts: null[]; revision: number }>;
      error: null;
    }>();
    const secondWrite = deferred<{
      data: Array<{ favorites: string[]; loadouts: null[]; revision: number }>;
      error: null;
    }>();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
      .mockImplementationOnce(() => {
        // The local revision-3 echo and a newer remote revision can beat the
        // HTTP response back to this pump. Keep only revision 4, then apply it
        // as soon as the owner-specific pump token is removed.
        mocks.realtime?.({
          new: {
            favorites: ['table:classic_green'],
            loadouts: [null, null, null],
            revision: 3,
          },
        });
        mocks.realtime?.({
          new: { favorites: [], loadouts: [null, null, null], revision: 4 },
        });
        return Promise.resolve({
          data: [
            {
              favorites: ['table:classic_green'],
              loadouts: [null, null, null],
              revision: 3,
            },
          ],
          error: null,
        });
      });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 1,
        },
      });
    });
    await act(async () => {
      firstWrite.resolve({
        data: [
          {
            favorites: ['table:classic_green'],
            loadouts: [null, null, null],
            revision: 1,
          },
        ],
        error: null,
      });
      await firstWrite.promise;
    });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));

    act(() => {
      mocks.realtime?.({
        new: { favorites: [], loadouts: [null, null, null], revision: 2 },
      });
    });
    await act(async () => {
      secondWrite.resolve({
        data: [{ favorites: [], loadouts: [null, null, null], revision: 2 }],
        error: null,
      });
      await secondWrite.promise;
    });

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('table:classic_green');

    // Anything at or below the accepted floor is now an old echo, even if its
    // JSON matches the optimistic state that was visible moments earlier.
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 3,
        },
      });
    });
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('table:classic_green');
  });

  it('advances the revision floor after authoritative hydration', async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await settleLocalWrites(['Favorite', 'Favorite Background']);

    mocks.cloud = {
      data: {
        favorites: ['cards:hydrated-authority'],
        loadouts: [null, null, null],
        revision: 10,
      },
      error: null,
    };
    view.rerender(<Harness isOpen={false} />);
    view.rerender(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:hydrated-authority')
    );

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 2,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:hydrated-authority');
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 11,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
  });

  it('advances the revision floor after authoritative reconnect', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await settleLocalWrites(['Favorite', 'Favorite Background']);

    mocks.cloud = {
      data: {
        favorites: ['cards:reconnect-authority'],
        loadouts: [null, null, null],
        revision: 10,
      },
      error: null,
    };
    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
      mocks.realtimeStatus?.('SUBSCRIBED');
    });
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:reconnect-authority')
    );

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 2,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:reconnect-authority');
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 11,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
  });

  it('rejects malformed reconnect collections without poisoning the revision floor', async () => {
    mocks.cloud = {
      data: { favorites: ['cards:known'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.readCloud.mockResolvedValueOnce({
      data: { favorites: ['cards:malformed'], loadouts: null, revision: 999 },
      error: null,
    });

    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
      mocks.realtimeStatus?.('SUBSCRIBED');
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('realtime-state')).toHaveTextContent('error');
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:known');

    mocks.cloud = {
      data: { favorites: ['cards:recovered'], loadouts: [null, null, null], revision: 2 },
      error: null,
    };
    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
      mocks.realtimeStatus?.('SUBSCRIBED');
    });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('realtime-state')).toHaveTextContent('live');
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:recovered');
  });

  it('advances the revision floor before replaying an authoritative retry', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    await settleLocalWrites(['Favorite', 'Favorite Background']);

    mocks.cloud = {
      data: {
        favorites: ['cards:retry-authority'],
        loadouts: [null, null, null],
        revision: 10,
      },
      error: null,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:retry-authority')
    );

    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 2,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:retry-authority');
    act(() => {
      mocks.realtime?.({
        new: {
          favorites: ['table:classic_green'],
          loadouts: [null, null, null],
          revision: 11,
        },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
  });

  it('retains newer known authority and settles when later reads are older', async () => {
    mocks.cloud = {
      data: {
        favorites: ['cards:newer-authority'],
        loadouts: [null, null, null],
        revision: 10,
      },
      error: null,
    };
    const view = render(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:newer-authority')
    );

    mocks.cloud = {
      data: {
        favorites: ['cards:older-select'],
        loadouts: [null, null, null],
        revision: 9,
      },
      error: null,
    };
    view.rerender(<Harness isOpen={false} />);
    view.rerender(<Harness />);
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:newer-authority');

    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
      mocks.realtimeStatus?.('SUBSCRIBED');
    });
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:newer-authority');

    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:newer-authority');
  });

  it('keeps failed writes retryable when the retry SELECT is older than known authority', async () => {
    mocks.cloud = {
      data: {
        favorites: ['cards:newer-authority'],
        loadouts: [null, null, null],
        revision: 10,
      },
      error: null,
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    mocks.cloud = {
      data: {
        favorites: ['cards:older-select'],
        loadouts: [null, null, null],
        revision: 9,
      },
      error: null,
    };

    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('state')).toHaveTextContent('error');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'table:classic_green,cards:newer-authority'
    );
  });

  it('rejects malformed retry collections without losing the failed mutation', async () => {
    mocks.cloud = {
      data: { favorites: ['cards:known'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    mocks.readCloud.mockResolvedValueOnce({
      data: { favorites: null, loadouts: [null, null, null], revision: 999 },
      error: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('state')).toHaveTextContent('error');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green,cards:known');

    mocks.cloud = {
      data: { favorites: ['cards:recovered'], loadouts: [null, null, null], revision: 2 },
      error: null,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent(
      'table:classic_green,cards:recovered'
    );
  });

  it('provides the retry promised by the sync error state', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));

    mocks.cloud = {
      data: { favorites: ['cards:gold'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green,cards:gold');
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_mutate_table_studio_preferences', {
      p_expected_user_id: 'user-1',
      p_favorite_enabled: true,
      p_favorite_key: 'table:classic_green',
      p_loadout: null,
      p_loadout_slot: null,
    });
  });

  it('holds newer same-owner intents behind a failure and retries them in tap order', async () => {
    const firstWrite = deferred<{ data: null; error: Error }>();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockImplementationOnce(() => firstWrite.promise);

    // enable -> disable are queued while the first request is unresolved.
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    firstWrite.resolve({ data: null, error: new Error('offline') });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    // A newer enable made during the failure joins the retry log; it is not
    // dispatched ahead of the two older taps.
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.cloud = {
      data: { favorites: [], loadouts: [null, null, null], revision: 0 },
      error: null,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(4));
    expect(
      mocks.rpc.mock.calls.slice(1).map(([, args]) => args.p_favorite_enabled as boolean)
    ).toEqual([true, false, true]);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    expect(screen.getByTestId('favorites')).toHaveTextContent('table:classic_green');
  });

  it('orders more than eight rapid echoes by revision without a fixed history cap', async () => {
    const writes = Array.from({ length: 10 }, () => deferred<MockRpcSuccess>());
    let writeIndex = 0;
    mocks.rpc.mockImplementation(() => writes[writeIndex++].promise);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    fireEvent.click(screen.getByRole('button', { name: 'Rapid Favorites' }));
    const latestFavorites = Array.from({ length: 10 }, (_, index) => `rapid:${9 - index}`);
    expect(screen.getByTestId('favorites')).toHaveTextContent(latestFavorites.join(','));

    for (let index = 0; index < writes.length; index += 1) {
      await act(async () => {
        writes[index].resolve(schemaResultForCall(index));
        await writes[index].promise;
      });
      if (index < writes.length - 1) {
        await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(index + 2));
      }
    }
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));

    // The oldest echo remains below the revision-10 floor even after ten
    // rapid writes; no fixed signature-history window is needed.
    act(() => {
      mocks.realtime?.({
        new: { favorites: ['rapid:0'], loadouts: [null, null, null], revision: 1 },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent(latestFavorites.join(','));

    // The local latest echo is also old authority. A strictly newer remote
    // return to rapid:0 is accepted immediately.
    act(() => {
      mocks.realtime?.({
        new: { favorites: latestFavorites, loadouts: [null, null, null], revision: 10 },
      });
    });
    act(() => {
      mocks.realtime?.({
        new: { favorites: ['rapid:0'], loadouts: [null, null, null], revision: 11 },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('rapid:0');
  });

  it('keeps inflight writes, failures, realtime, and canonical caches isolated by account', async () => {
    const userOneWrite = deferred<{ data: null; error: Error }>();
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc
      .mockImplementationOnce(() => userOneWrite.promise)
      .mockResolvedValueOnce({
        data: [
          {
            favorites: ['cards:server-canonical'],
            loadouts: [null, null, null],
            revision: 3,
          },
        ],
        error: null,
      });

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    expect(JSON.parse(localStorage.getItem('table-studio-favorites:user-1') || '[]')).toEqual([
      'table:classic_green',
    ]);

    mocks.cloud = {
      data: { favorites: ['cards:gold'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    localStorage.setItem('table-studio-favorites:user-2', JSON.stringify(['cards:b-cache']));
    view.rerender(<Harness userId="user-2" />);
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:b-cache');
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('table:classic_green');
    await waitFor(() => expect(screen.getByTestId('favorites')).toHaveTextContent('cards:gold'));

    // User one's still-pending request must not block user two's channel.
    act(() => {
      mocks.realtime?.({
        new: { favorites: ['cards:royal'], loadouts: [null, null, null], revision: 2 },
      });
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:royal');

    // User two gets an independent pump: its RPC and canonical response finish
    // while user one's request is still unresolved.
    fireEvent.click(screen.getByRole('button', { name: 'Favorite Background' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:server-canonical')
    );
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
    expect(JSON.parse(localStorage.getItem('table-studio-favorites:user-2') || '[]')).toEqual([
      'cards:server-canonical',
    ]);
    expect(JSON.parse(localStorage.getItem('table-studio-favorites:user-1') || '[]')).toEqual([
      'table:classic_green',
    ]);

    await act(async () => {
      userOneWrite.resolve({ data: null, error: new Error('user one is offline') });
      await userOneWrite.promise;
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:server-canonical');
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
  });

  it('rejects an A to B to A hydration response made stale by an A write', async () => {
    const staleUserOneRead = deferred<{
      data: { favorites: string[]; loadouts: unknown[]; revision: number };
      error: null;
    }>();
    mocks.readCloud
      .mockResolvedValueOnce({
        data: { favorites: ['cards:a-initial'], loadouts: [null, null, null], revision: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { favorites: ['cards:b'], loadouts: [null, null, null], revision: 1 },
        error: null,
      })
      .mockImplementationOnce(() => staleUserOneRead.promise);
    const view = render(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:a-initial')
    );

    view.rerender(<Harness userId="user-2" />);
    await waitFor(() => expect(screen.getByTestId('favorites')).toHaveTextContent('cards:b'));
    view.rerender(<Harness />);
    await waitFor(() => expect(mocks.readCloud).toHaveBeenCalledTimes(3));

    mocks.rpc.mockResolvedValueOnce({
      data: [
        {
          favorites: ['background:server-canonical'],
          loadouts: [null, null, null],
          revision: 2,
        },
      ],
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Favorite Background' }));
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('background:server-canonical')
    );

    await act(async () => {
      staleUserOneRead.resolve({
        data: {
          favorites: ['cards:stale-select'],
          loadouts: [null, null, null],
          revision: 1,
        },
        error: null,
      });
      await staleUserOneRead.promise;
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('background:server-canonical');
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('cards:stale-select');
  });

  it('ignores a retry result after its account lifecycle has been replaced', async () => {
    const staleRetry = deferred<{
      data: { favorites: string[]; loadouts: unknown[]; revision: number };
      error: null;
    }>();
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));

    mocks.readCloud.mockImplementationOnce(() => staleRetry.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sync' }));
    mocks.cloud = {
      data: { favorites: ['cards:b-current'], loadouts: [null, null, null], revision: 1 },
      error: null,
    };
    view.rerender(<Harness userId="user-2" />);
    await waitFor(() =>
      expect(screen.getByTestId('favorites')).toHaveTextContent('cards:b-current')
    );
    expect(screen.getByTestId('state')).toHaveTextContent('synced');

    await act(async () => {
      staleRetry.resolve({
        data: {
          favorites: ['cards:a-stale-retry'],
          loadouts: [null, null, null],
          revision: 1,
        },
        error: null,
      });
      await staleRetry.promise;
    });
    expect(screen.getByTestId('favorites')).toHaveTextContent('cards:b-current');
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('cards:a-stale-retry');
    expect(screen.getByTestId('state')).toHaveTextContent('synced');
  });

  it('keeps guest sync local when an authenticated write settles after logout', async () => {
    const signedInWrite = deferred<MockRpcSuccess>();
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('synced'));
    mocks.rpc.mockImplementationOnce(() => signedInWrite.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    view.rerender(<Harness userId="" />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('local'));

    await act(async () => {
      signedInWrite.resolve(schemaResultForCall(0));
      await signedInWrite.promise;
    });

    expect(screen.getByTestId('state')).toHaveTextContent('local');
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
