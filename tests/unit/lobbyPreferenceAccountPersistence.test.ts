import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  writes: [] as Array<{ payload: any; resolve: (v: any) => void }>,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      upsert: (payload: unknown) =>
        new Promise((resolve) => state.writes.push({ payload, resolve })),
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import {
  loadViewPrefs,
  saveViewPrefs,
  pushRemoteViewPrefs,
} from '../../src/components/lobby/lobbyViewPrefs';
const plo = { tab: 'OMAHA' as const, sortByTab: {}, favoritesOnly: false };
const holdem = { ...plo, tab: 'HOLDEM' as const };
beforeEach(() => {
  localStorage.clear();
  state.writes.length = 0;
});
it('keeps each account choice across sign-out and returning hours later', () => {
  saveViewPrefs('club', plo, 'account-a');
  saveViewPrefs('club', holdem, 'account-b');
  expect(loadViewPrefs('club', 'account-a').tab).toBe('OMAHA');
  expect(loadViewPrefs('club', 'account-b').tab).toBe('HOLDEM');
  expect(loadViewPrefs('club', 'new-account').tab).toBeNull();
});
it('adopts the legacy browser preference for one account only', () => {
  localStorage.setItem('ca_lobby_view_club', JSON.stringify(plo));
  expect(loadViewPrefs('club', 'account-a').tab).toBe('OMAHA');
  expect(loadViewPrefs('club', 'account-b').tab).toBeNull();
});
it('saves rapid changes in tap order even when the first network request is slow', async () => {
  pushRemoteViewPrefs('club', holdem, 'account-a');
  pushRemoteViewPrefs('club', plo, 'account-a');
  expect(state.writes.map((w) => w.payload.view_prefs.tab)).toEqual(['HOLDEM']);
  state.writes[0].resolve({ error: null });
  await vi.waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1].payload.view_prefs.tab).toBe('OMAHA');
  state.writes[1].resolve({ error: null });
  await Promise.resolve();
});
