/**
 * STALE STORAGE IS READ SAFELY OR DISCARDED (Diamond Phase 11, line 7).
 *
 * localStorage on smarter.poker outlives every build that wrote to it, and the
 * World Hub shares it. What an older build left behind must either be read
 * safely or thrown away - never trusted into a crash, a foreign balance or a
 * retired arena. The arena selection, the pinned clubs and the Diamond figure
 * the wallet store keeps are pinned here; the queued money mutations an older
 * build could leave in IndexedDB are pinned in OfflineQueueService.test.ts
 * (drained and refused, never replayed).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialArenaIndex,
  orderArenaCards,
  savedPinnedClubIds,
} from '../../src/components/home/arenaSelection';
import { DIAMOND_ARENA_CLUB_ID } from '../../src/lib/constants';

const shark = { id: 'shark-uuid', club_id: 25450, slug: 'shark-club' };
const diamond = { id: DIAMOND_ARENA_CLUB_ID, slug: 'diamond-arena' };
const joined = { id: 'joined-uuid' };
const cards = orderArenaCards([joined, diamond, shark], [], []);

describe('pinned clubs an older build, or another app on this origin, left behind', () => {
  it.each([
    [null, []],
    ['', []],
    ['null', []],
    ['{}', []],
    ['{"shark-uuid":true}', []],
    ['"shark-uuid"', []],
    ['5', []],
    ['not json at all', []],
    ['[1, "a", null, {"id": "b"}, "b"]', ['a', 'b']],
    ['["joined-uuid"]', ['joined-uuid']],
  ])('%j reads as %j', (raw, want) => {
    expect(savedPinnedClubIds(raw)).toEqual(want);
  });

  it('never reaches a sort as anything but an array', () => {
    // What the old reader did: JSON.parse's answer went straight to `.includes`
    // in the home sorts, so a player with two joined clubs and a stored `null`,
    // `{}` or number got a Poker Arena home that threw instead of rendering.
    const two = [joined, { id: 'second-uuid' }, diamond, shark];
    for (const raw of ['null', '{}', '7'])
      expect(() => orderArenaCards(two, JSON.parse(raw), [])).toThrow(TypeError);
    for (const raw of ['null', '{}', '"x"', '7'])
      expect(() => orderArenaCards(two, savedPinnedClubIds(raw), [])).not.toThrow();
  });
});

describe('a saved arena selection from any build opens a real arena', () => {
  const at = (saved: string | null) => cards[initialArenaIndex(cards, saved)];
  it('keeps the Diamond Arena by its id or its slug', () => {
    expect(at(DIAMOND_ARENA_CLUB_ID)).toBe(diamond);
    expect(at('diamond-arena')).toBe(diamond);
  });
  it.each([
    null,
    '',
    'diamond', // no such arena
    '/hub/diamond-arena', // the retired standalone route
    '25450', // a numeric club id, not a card id
    'undefined',
    '{"id":"shark-uuid"}',
  ])('%j falls back to Shark, never to a blank or retired arena', (saved) => {
    expect(at(saved)).toBe(shark);
  });
  it('ignores a saved order of the wrong shape', () => {
    for (const saved of [{ old: 'shape' }, 'shark-uuid', 42, null, [1, 2]])
      expect(orderArenaCards([joined, diamond, shark], [], saved).map((c) => c.id)).toEqual(
        cards.map((c) => c.id)
      );
  });
});

describe('no build still reads what the retired standalone Diamond Arena stored', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }
  it('neither the World Hub store keys nor its preferences column have a reader here', () => {
    const src = sources(resolve(__dirname, '../../src')).map((p) => readFileSync(p, 'utf8'));
    for (const key of ['sp-diamond-arena-prefs', 'diamond_arena_preferences', 'world-store-v1'])
      expect(src.filter((s) => s.includes(key)).length, key).toBe(0);
  });
});

const wallet = vi.hoisted(() => ({ getBalance: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/services/WalletService', () => ({ WalletService: { getBalances: vi.fn() } }));
vi.mock('../../src/services/DiamondService', () => ({ DiamondService: wallet }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

describe('the Diamond figure the wallet store left in storage', () => {
  const A = 'a0000000-0000-4000-8000-00000000000a';
  const B = 'b0000000-0000-4000-8000-00000000000b';
  const balances = {
    BUSINESS: { type: 'BUSINESS', available: 1, locked: 0, pending: 0, total: 1 },
    PLAYER: { type: 'PLAYER', available: 2, locked: 0, pending: 0, total: 2 },
    PROMO: { type: 'PROMO', available: 3, locked: 0, pending: 0, total: 3 },
  };
  async function bootWith(saved: object) {
    localStorage.setItem('wallet-store', JSON.stringify(saved));
    vi.resetModules();
    const { useWalletStore } = await import('../../src/stores/useWalletStore');
    await useWalletStore.persist.rehydrate();
    return useWalletStore;
  }
  beforeEach(() => {
    localStorage.clear();
    wallet.getBalance.mockReset();
  });

  it('an older build saved it with no owner, so it is discarded; the chip balances stay', async () => {
    const store = await bootWith({
      state: { balances, diamonds: 494465, _balancesUserId: A, _balancesAt: 5 },
      version: 0,
    });
    expect(store.getState().diamonds).toBe(0);
    expect(store.getState()._diamondsUserId).toBeNull();
    expect(store.getState().balances.PLAYER.total).toBe(2);
    expect(store.getState()._balancesUserId).toBe(A);
  });

  it('another account’s figure is never painted, not while loading and not after a failed read', async () => {
    const store = await bootWith({
      state: { balances, diamonds: 494465, _diamondsUserId: A, _diamondsAt: Date.now() },
      version: 1,
    });
    expect(store.getState().diamonds).toBe(494465); // A's, for A
    let fail!: (e: Error) => void;
    wallet.getBalance.mockReturnValue(new Promise((_r, reject) => (fail = reject)));
    const load = store.getState().loadDiamonds(B);
    expect(store.getState().diamonds).toBe(0);
    fail(new Error('JWT expired'));
    await load;
    expect(store.getState().diamonds).toBe(0);
    expect(store.getState()._diamondsUserId).toBeNull();
  });

  it('its own account keeps its last figure through a failed read (the 2026-08-24 rule)', async () => {
    const store = await bootWith({
      state: { balances, diamonds: 812, _diamondsUserId: B, _diamondsAt: 1 },
      version: 1,
    });
    wallet.getBalance.mockRejectedValue(new Error('network'));
    await store.getState().loadDiamonds(B);
    expect(store.getState().diamonds).toBe(812);
    wallet.getBalance.mockResolvedValue({ balance: 900 });
    await store.getState().loadDiamonds(B, { force: true });
    expect(store.getState()).toMatchObject({ diamonds: 900, _diamondsUserId: B });
    const saved = JSON.parse(localStorage.getItem('wallet-store') || '{}');
    expect(saved.version).toBe(1);
    expect(saved.state).toMatchObject({ diamonds: 900, _diamondsUserId: B });
  });
});
