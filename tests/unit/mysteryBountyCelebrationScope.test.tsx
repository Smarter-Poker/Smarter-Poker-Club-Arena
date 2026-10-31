// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  from: vi.fn(),
  inventory: vi.fn(),
  channels: new Map<string, any>(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: io.from } }));
vi.mock('../../src/services/TournamentService', () => ({
  TOURNAMENT_ARENA_EMBED: 'club:clubs(*)',
}));
vi.mock('../../src/services/MysteryBountyService', () => ({
  MysteryBountyService: { getInventory: io.inventory },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: (key: string) => {
      const channel = {
        state: 'joined',
        receive: (_payload: unknown) => {},
        on: vi.fn(),
        subscribe: vi.fn(),
      };
      channel.on.mockImplementation((_type, _filter, receive) => {
        channel.receive = receive;
        return channel;
      });
      io.channels.set(key, channel);
      return channel;
    },
    removeRegisteredChannel: vi.fn(),
  },
}));
import MysteryBountyCelebration from '../../src/components/tournament/MysteryBountyCelebration';
const reveal = {
  payload: {
    type: 'mystery_bounty_revealed',
    payload: { amount: 100, prizeRank: 1, knockerName: 'Alice' },
  },
};
beforeEach(() => {
  io.channels.clear();
  io.inventory.mockReset();
  io.inventory.mockResolvedValue({
    tiers: [10000, 5000, 2500, 1000].map((amountCents) => ({ amountCents, original: 1 })),
  });
  io.from.mockImplementation((table: string) => {
    const q: any = {};
    for (const k of ['select', 'eq', 'gt']) q[k] = () => q;
    q.maybeSingle = async () => ({
      data: { is_mystery_bounty: true, club: { currency: 'CHIPS' } },
      error: null,
    });
    q.then = (resolve: any) =>
      Promise.resolve({
        data: table === 'tournament_players' ? [{ current_bounty: 100 }] : [],
        error: null,
      }).then(resolve);
    return q;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
it('clears the previous event celebration when the details scope changes', async () => {
  const view = render(<MysteryBountyCelebration tournamentId="old" />);
  await settle();
  act(() => io.channels.get('t-break-old').receive(reveal));
  expect(screen.queryByRole('status')).not.toBeNull();
  view.rerender(<MysteryBountyCelebration tournamentId="new" />);
  await settle();
  expect(screen.queryByRole('status')).toBeNull();
});
it('ignores a delayed callback retained by another consumer of the old channel', async () => {
  const view = render(<MysteryBountyCelebration tournamentId="old" />);
  await settle();
  const oldChannel = io.channels.get('t-break-old');
  view.rerender(<MysteryBountyCelebration tournamentId="new" />);
  await settle();
  act(() => oldChannel.receive(reveal));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => io.channels.get('t-break-new').receive(reveal));
  expect(screen.queryByRole('status')).not.toBeNull();
});

it('ranks an unranked chest against chest inventory, never flat pre-phase heads', async () => {
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: {
        type: 'mystery_bounty_revealed',
        payload: { amount: 10, knockerName: 'Alice' },
      },
    })
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(io.inventory).toHaveBeenCalledWith('chests', { strict: true });
});
it('announces the actual third chest rung even when no rank is broadcast', async () => {
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: {
        type: 'mystery_bounty_revealed',
        payload: { amount: 25, knockerName: 'Alice' },
      },
    })
  );
  expect(screen.getByRole('status').textContent).toContain(
    'Alice Just Pulled A Top Mystery Bounty'
  );
  expect(document.querySelector('.mbcel__card--r3')).not.toBeNull();
});
it('does not guess a chest rank from heads when the inventory cannot be read', async () => {
  io.inventory.mockRejectedValue(new Error('inventory unavailable'));
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: {
        type: 'mystery_bounty_revealed',
        payload: { amount: 10, knockerName: 'Alice' },
      },
    })
  );
  expect(screen.queryByRole('status')).toBeNull();
});
it('loads the sealed ladder when activation arrives after an empty pre-start inventory', async () => {
  io.inventory.mockResolvedValueOnce({ tiers: [] });
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels
      .get('t-break-chests')
      .receive({ payload: { type: 'mystery_bounty_activated', payload: {} } })
  );
  await settle();
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: { type: 'mystery_bounty_revealed', payload: { amount: 25, knockerName: 'Alice' } },
    })
  );
  expect(document.querySelector('.mbcel__card--r3')).not.toBeNull();
  expect(io.inventory).toHaveBeenCalledTimes(2);
});
it('does not let a delayed pre-activation read replace the sealed ladder', async () => {
  let finishInitial!: (value: unknown) => void;
  io.inventory.mockReturnValueOnce(
    new Promise((resolve) => {
      finishInitial = resolve;
    })
  );
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels
      .get('t-break-chests')
      .receive({ payload: { type: 'mystery_bounty_activated', payload: {} } })
  );
  await settle();
  await act(async () => finishInitial({ tiers: [] }));
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: { type: 'mystery_bounty_revealed', payload: { amount: 25, knockerName: 'Alice' } },
    })
  );
  expect(document.querySelector('.mbcel__card--r3')).not.toBeNull();
});
it('ignores an older failed inventory read after activation succeeds', async () => {
  let rejectInitial!: (error: Error) => void;
  io.inventory.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectInitial = reject;
    })
  );
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels
      .get('t-break-chests')
      .receive({ payload: { type: 'mystery_bounty_activated', payload: {} } })
  );
  await settle();
  await act(async () => rejectInitial(new Error('old request unavailable')));
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: { type: 'mystery_bounty_revealed', payload: { amount: 25, knockerName: 'Alice' } },
    })
  );
  expect(document.querySelector('.mbcel__card--r3')).not.toBeNull();
});
it('does not build a partial ladder around an unreadable tier', async () => {
  io.inventory.mockResolvedValue({
    tiers: [
      { amountCents: 0, original: 1 },
      { amountCents: 1000, original: 1 },
    ],
  });
  render(<MysteryBountyCelebration tournamentId="chests" />);
  await settle();
  act(() =>
    io.channels.get('t-break-chests').receive({
      payload: { type: 'mystery_bounty_revealed', payload: { amount: 10, knockerName: 'Alice' } },
    })
  );
  expect(screen.queryByRole('status')).toBeNull();
});
