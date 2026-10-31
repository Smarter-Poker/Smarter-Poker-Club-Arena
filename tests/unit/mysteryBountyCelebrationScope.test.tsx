// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn(), channels: new Map<string, any>() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: io.from } }));
vi.mock('../../src/services/TournamentService', () => ({
  TOURNAMENT_ARENA_EMBED: 'club:clubs(*)',
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
