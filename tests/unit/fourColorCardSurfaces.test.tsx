import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CASH_VARIANTS } from '../../src/config/cashGames';
import { holeCardCountFor } from '../../src/lib/holeCardCount';
import { buildReplay } from '../../src/utils/handReplay';
import HandReplay from '../../src/components/replay/HandReplay';
import HandDetailView from '../../src/components/handdetail/HandDetailView';
import {
  __resetTableSettingsStoreForTest,
  setTableSetting,
} from '../../src/hooks/useTableSettings';
import { STORAGE_KEYS } from '../../src/lib/storage';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
const account = vi.hoisted(() => ({ user: { id: 'surface-viewer' }, reads: 0 }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign((selector: (state: typeof account) => unknown) => selector(account), {
    getState: () => account,
  }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: account.user }) }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            account.reads++;
            return {
              data: { four_color_deck: true, settings_touched: ['four_color_deck'] },
              error: null,
            };
          },
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
    rpc: async () => ({ error: null }),
  },
}));

beforeEach(() => {
  account.reads = 0;
  localStorage.clear();
  localStorage.setItem(
    STORAGE_KEYS.TABLE_SETTINGS,
    JSON.stringify({ fourColorDeck: false, fourColorDeckExplicit: true })
  );
  localStorage.setItem('ca_table_settings_owner', account.user.id);
  __resetTableSettingsStoreForTest();
});
afterEach(cleanup);

function source(variant: string, extraBoards: string[][] = []) {
  const cards = ['Ad', 'Kc', 'Qh', 'Js', 'Td', '9c'].slice(0, holeCardCountFor(variant));
  return {
    viewerId: account.user.id,
    tableName: 'Deck Qualification',
    handNumber: 41,
    model: buildReplay({
      handNumber: 41,
      playedAt: '2026-10-18T12:00:00Z',
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      buttonSeat: 1,
      potSize: 4,
      board: ['6d', '7c', '8h', '9s', 'Td'],
      extraBoards,
      players: [
        { userId: account.user.id, username: 'Viewer', seat: 1, stack: 100 },
        { userId: 'other', username: 'Other', seat: 2, stack: 96 },
      ],
      actions: [
        { seat: 1, userId: account.user.id, action: 'call', amount: 1, stage: 'preflop' },
        { seat: 2, userId: 'other', action: 'check', stage: 'river' },
      ],
      winners: [{ userId: account.user.id, amount: 4 }],
      holeCards: { [account.user.id]: cards, other: cards },
      showdown: [
        { user_id: account.user.id, seat: 1, mucked: false },
        { user_id: 'other', seat: 2, mucked: false },
      ],
    }),
  };
}
function faces(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLImageElement>('.card-image__img')];
}
function expectDeck(root: HTMLElement, deck: string) {
  const cards = faces(root);
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((img) => img.src.includes(`/cards/${deck}/`))).toBe(true);
}

describe('real history and replay cards across every dealt variant', () => {
  it.each(CASH_VARIANTS.map((v) => v.id))(
    '%s hydrates ON directly, then follows OFF/ON in replay and rundown',
    async (variant) => {
      const view = render(<HandReplay source={source(variant)} />);
      await waitFor(() => expectDeck(view.container, '4color'));
      expect(account.reads).toBe(1); // many card readers, one account hydration
      fireEvent.click(view.getByLabelText('Last Step'));
      expectDeck(view.container, '4color');
      expect(faces(view.container).some((img) => img.src.includes('diamonds_'))).toBe(true);
      expect(faces(view.container).some((img) => img.src.includes('clubs_'))).toBe(true);
      act(() => setTableSetting('fourColorDeck', false));
      expectDeck(view.container, '2color');
      fireEvent.click(view.getByRole('tab', { name: 'Rundown' }));
      expectDeck(view.container, '2color');
      act(() => setTableSetting('fourColorDeck', true));
      expectDeck(view.container, '4color');
    }
  );

  it.each([2, 3])(
    '%i-board histories keep every board and showdown on the account deck',
    async (count) => {
      const extra = Array.from({ length: count - 1 }, () => ['Ac', 'Kd', 'Qh', 'Js', 'Tc']);
      const model = source('plo6', extra).model;
      const view = render(<HandDetailView model={model} currentUserId={account.user.id} />);
      await waitFor(() => expectDeck(view.container, '4color'));
      expect(faces(view.container).some((img) => img.src.includes('clubs_a'))).toBe(true);
      act(() => setTableSetting('fourColorDeck', false));
      expectDeck(view.container, '2color');
      act(() => setTableSetting('fourColorDeck', true));
      expectDeck(view.container, '4color');
    }
  );
});
