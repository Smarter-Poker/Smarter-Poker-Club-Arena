/**
 * DYNAMIC WALLET: NOTHING IS PRINTED THAT WAS NOT READ FOR THIS CLUB, BY THIS
 * VIEWER (cashier launch, round 2, 2026-10-09).
 *
 * The first swarm left four probes against this panel (.agent-logs/C5-probe-dw-*)
 * and each recorded a defect the merged tree still had:
 *  - a club switch counted club A's balances down into club B's rows, and a
 *    failed first read for club B kept club A's jackpot on the banner;
 *  - a plain player in a standalone club was shown the club's Backup BBJ
 *    reserve as a third wallet, against the wallet visibility law;
 *  - Retry cleared the "Balances Unavailable" badge before the retried read
 *    answered, so a read that failed again showed seeded zeros as balances;
 *  - an unresolvable club id left Retry with nothing to retry.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_A = '22222222-2222-4222-8222-222222222222';
const CLUB_B = '44444444-4444-4444-8444-444444444444';
const SLUG = 'deep-stack-society';

const fx = vi.hoisted(() => ({
  bankByClub: {} as Record<string, number>,
  chipByClub: {} as Record<string, number>,
  bbjByClub: {} as Record<string, { main: number; backup: number }>,
  failClubs: new Set<string>(),
  scope: 'club' as 'club' | 'member',
  inUnion: false,
  slugMap: {} as Record<string, string>,
  resolveCalls: 0,
  panelCalls: 0,
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscriptions: vi.fn() }));
vi.mock('../../src/hooks/useSpinsWallet', () => ({
  useSpinsWallet: () => ({ balance: 0, state: null }),
}));
vi.mock('../../src/components/arena/arenaAccess', () => ({ useArenaHasChipWallet: () => true }));
vi.mock('../../src/lib/bbjPoolFeed', () => ({ watchBbjPool: () => () => {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/walletCache', () => ({
  walletCacheKey: (...args: string[]) => args.join(':'),
  readWalletCacheEntry: () => null,
  writeWalletCacheDebounced: vi.fn(),
  dedupedFetch: (_key: string, read: () => unknown) => read(),
}));
vi.mock('../../src/utils/clubIdResolver', () => {
  const isUUID = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return {
    isUUID,
    resolveClubUUIDSync: (id: string) => (isUUID(id) ? id : (fx.slugMap[id] ?? null)),
    // The documented fallback: an id that cannot be resolved comes back raw.
    resolveClubUUID: async (id: string) => {
      if (isUUID(id)) return id;
      fx.resolveCalls += 1;
      return fx.slugMap[id] ?? id;
    },
  };
});
vi.mock('../../src/lib/supabase', () => {
  let lastClub = '';
  const from = (table: string) => {
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (column: string, v: string) => {
        if (column === 'club_id') lastClub = v;
        return query;
      },
      abortSignal: () => query,
      maybeSingle: async () => ({
        error: null,
        data:
          table === 'profiles'
            ? { diamonds: 8 }
            : table === 'club_members'
              ? { chip_balance: fx.chipByClub[lastClub] ?? 0 }
              : null,
      }),
    };
    return query;
  };
  return {
    supabase: {
      from,
      rpc: (name: string, args: { p_club_id?: string }) => {
        if (name === 'get_my_full_profile') return from('profiles');
        fx.panelCalls += 1;
        const club = args?.p_club_id ?? '';
        const result = () =>
          fx.failClubs.has(club)
            ? { error: { message: 'TypeError: Failed to fetch', code: '' }, data: null }
            : {
                error: null,
                data: {
                  authorized: true,
                  scope: fx.scope,
                  in_union: fx.inUnion,
                  union_id: null,
                  club_treasury: fx.bankByClub[club] ?? 0,
                  club_promo_wallet: 0,
                  bbj: fx.bbjByClub[club] ?? { main: 0, backup: 0 },
                },
              };
        return {
          abortSignal: async () => result(),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
      },
    },
  };
});

import DynamicWallet from '../../src/components/wallet/DynamicWallet';

const base = { userId: '11111111-1111-4111-8111-111111111111', roleReady: true };
const microtasks = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
const flush = async () => {
  await microtasks();
  await act(() => vi.advanceTimersByTimeAsync(450));
};
const text = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-wallet-key="${key}"] .dw__row-value`)?.textContent ?? null;
const keys = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-wallet-key]')).map((n) => n.getAttribute('data-wallet-key'));
const values = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-wallet-key] .dw__row-value')).map((n) => n.textContent);
const badge = (c: HTMLElement) => c.querySelector('.dw__error-badge') as HTMLButtonElement | null;
/** "777K" -> 777000, "347.8K" -> 347800, "5" -> 5; "-" is not a figure. */
const figure = (printed: string | null) => {
  if (!printed || printed === '-') return null;
  const m = /^(-?[\d,.]+)([KMB]?)$/.exec(printed.trim());
  if (!m) return null;
  const scale = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1;
  return Number(m[1].replace(/,/g, '')) * scale;
};

beforeEach(() => {
  vi.useFakeTimers();
  fx.bankByClub = { [CLUB_A]: 777000, [CLUB_B]: 5 };
  fx.chipByClub = { [CLUB_A]: 900, [CLUB_B]: 3 };
  fx.bbjByClub = {
    [CLUB_A]: { main: 9000, backup: 0 },
    [CLUB_B]: { main: 0, backup: 0 },
  };
  fx.failClubs = new Set();
  fx.scope = 'club';
  fx.inUnion = false;
  fx.slugMap = {};
  fx.resolveCalls = 0;
  fx.panelCalls = 0;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a club switch never shows the club that was left', () => {
  it('counts club B up from nothing, never down from club A', async () => {
    const view = render(<DynamicWallet {...base} role="owner" clubId={CLUB_A} variant="club" />);
    await flush();
    expect(text(view.container, 'club_bank')).toBe('777,000.00');
    expect(text(view.container, 'player_wallet')).toBe('900.00');

    view.rerender(<DynamicWallet {...base} role="owner" clubId={CLUB_B} variant="club" />);
    const banks: (string | null)[] = [text(view.container, 'club_bank')];
    const chips: (string | null)[] = [text(view.container, 'player_wallet')];
    // Club B's read lands; no animation frame has run yet.
    await microtasks();
    banks.push(text(view.container, 'club_bank'));
    chips.push(text(view.container, 'player_wallet'));
    for (let step = 0; step < 10; step++) {
      await act(() => vi.advanceTimersByTimeAsync(60));
      banks.push(text(view.container, 'club_bank'));
      chips.push(text(view.container, 'player_wallet'));
    }
    for (const printed of banks) expect(figure(printed) ?? 0).toBeLessThanOrEqual(5);
    for (const printed of chips) expect(figure(printed) ?? 0).toBeLessThanOrEqual(3);
    expect(text(view.container, 'club_bank')).toBe('5.00');
    expect(text(view.container, 'player_wallet')).toBe('3.00');
  });

  it("keeps club A's jackpot and balances off club B when club B's first read fails", async () => {
    const view = render(<DynamicWallet {...base} role="owner" clubId={CLUB_A} variant="club" />);
    await flush();
    expect(view.container.querySelector('.dw__bbj-amount')?.textContent).toBe('9,000.00');

    fx.failClubs.add(CLUB_B);
    view.rerender(<DynamicWallet {...base} role="owner" clubId={CLUB_B} variant="club" />);
    await flush();
    expect(badge(view.container)).not.toBeNull();
    expect(view.container.querySelector('.dw__bbj-amount')?.textContent).toBe('-');
    for (const printed of values(view.container)) expect(printed).toBe('-');
    expect(view.container.textContent).not.toMatch(/777K|9K|\b900\b/);
  });
});

describe('the wallet visibility law covers the Backup BBJ reserve too', () => {
  const funded = () => {
    fx.bbjByClub[CLUB_A] = { main: 5000, backup: 2400 };
  };

  it('shows a plain player only Diamonds and the Player Wallet', async () => {
    funded();
    fx.scope = 'member';
    let count = -1;
    const view = render(
      <DynamicWallet
        {...base}
        role="player"
        clubId={CLUB_A}
        variant="club"
        compactLobby
        showAllLobbyWallets
        onVisibleWalletCountChange={(n) => (count = n)}
      />
    );
    await flush();
    expect(keys(view.container)).toEqual(['diamonds', 'player_wallet']);
    expect(count).toBe(2);
  });

  it('shows an agent no reserve row on the full panel either', async () => {
    funded();
    fx.scope = 'member';
    const view = render(<DynamicWallet {...base} role="agent" clubId={CLUB_A} variant="club" />);
    await flush();
    expect(keys(view.container)).not.toContain('backup_bbj');
  });

  it('still shows the reserve to an owner on the lobby glance, where it belongs', async () => {
    funded();
    const view = render(
      <DynamicWallet {...base} role="owner" clubId={CLUB_A} variant="club" compactLobby />
    );
    await flush();
    expect(keys(view.container)).toEqual(['diamonds', 'club_bank', 'player_wallet', 'backup_bbj']);
  });
});

describe('Retry never takes the badge down before a read lands', () => {
  it('keeps the dashes and the badge while the first read keeps failing', async () => {
    fx.failClubs.add(CLUB_A);
    const view = render(<DynamicWallet {...base} role="owner" clubId={CLUB_A} variant="club" />);
    await flush();
    expect(badge(view.container)).not.toBeNull();
    for (const printed of values(view.container)) expect(printed).toBe('-');

    const before = fx.panelCalls;
    fireEvent.click(badge(view.container)!);
    await flush();
    expect(fx.panelCalls).toBeGreaterThan(before);
    expect(badge(view.container)).not.toBeNull();
    for (const printed of values(view.container)) expect(printed).toBe('-');

    fx.failClubs.clear();
    fireEvent.click(badge(view.container)!);
    await flush();
    expect(badge(view.container)).toBeNull();
    expect(text(view.container, 'club_bank')).toBe('777,000.00');
  });

  it('keeps the last good figure and the badge when a later read and its retry fail', async () => {
    const view = render(<DynamicWallet {...base} role="owner" clubId={CLUB_A} variant="club" />);
    await flush();
    fx.failClubs.add(CLUB_A);
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await flush();
    expect(badge(view.container)).not.toBeNull();

    fireEvent.click(badge(view.container)!);
    await flush();
    expect(badge(view.container)).not.toBeNull();
    expect(text(view.container, 'club_bank')).toBe('777,000.00');
  });
});

describe('an unresolvable club id', () => {
  it('prints unknown, and Retry resolves the club again before it reads', async () => {
    const view = render(<DynamicWallet {...base} role="owner" clubId={SLUG} variant="club" />);
    await flush();
    expect(badge(view.container)).not.toBeNull();
    for (const printed of values(view.container)) expect(printed).toBe('-');
    expect(fx.panelCalls).toBe(0);

    // Still unresolvable: the badge and the dashes stay.
    const calls = fx.resolveCalls;
    fireEvent.click(badge(view.container)!);
    await flush();
    expect(fx.resolveCalls).toBeGreaterThan(calls);
    expect(badge(view.container)).not.toBeNull();
    for (const printed of values(view.container)) expect(printed).toBe('-');

    // The club resolves now: the read runs and the real figures arrive.
    fx.slugMap[SLUG] = CLUB_A;
    fireEvent.click(badge(view.container)!);
    await flush();
    expect(fx.panelCalls).toBeGreaterThan(0);
    expect(badge(view.container)).toBeNull();
    expect(text(view.container, 'club_bank')).toBe('777,000.00');
  });
});
