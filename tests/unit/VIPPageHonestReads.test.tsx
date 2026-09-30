/**
 * THE VIP PAGE NEVER PRINTS A ZERO IT DID NOT READ (2026-09-30).
 *
 * `const { data } = await supabase...` discards the error, and supabase-js
 * RESOLVES with `{ data: null, error }` rather than throwing. So on this page
 * an RLS denial, a dropped link or a PGRST002 503 reached the player as
 * `setDiamonds(profData?.diamonds || 0)` - a confident balance of ZERO for a
 * wallet that was merely unreadable, and the same for their VIP points.
 *
 * That is CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and
 * must have its own name. These cases hold the outcomes apart, and the ones
 * that matter are the PAIRS: a genuine zero still prints "0", and only an
 * unreadable figure prints "Unavailable". A test that checked the error case
 * alone would pass just as happily against a page that had stopped showing
 * zeros at all.
 *
 * The last case is the same page's activity list, which could fall through to
 * a bare snake_case kind (`arena_deposit`) where every other wallet surface
 * says "Diamond Arena Buy-In".
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /* STABLE IDENTITY, DELIBERATELY. `loadVIPStatus` is a useCallback whose deps
     are [toast, user?.id], and the effect that calls it depends on that
     callback. A `useToast` mock returning a fresh object per render therefore
     re-fires the load on every render, for ever - it OOMs the worker rather
     than failing an assertion, which is a nasty half-hour. */
  toast: { success: vi.fn(), error: vi.fn() },
  profilesResponse: vi.fn(() => Promise.resolve({ data: { diamonds: 100 }, error: null })),
  vipPointsResponse: vi.fn(() =>
    Promise.resolve({ data: { current_points: 42, lifetime_points: 77 }, error: null })
  ),
  ledgerResponse: vi.fn(() => Promise.resolve({ data: [] as unknown[], error: null })),
  reportError: vi.fn(),
  platePoints: null as null | {
    points: { current: number; lifetime: number };
    pointsState?: string;
  },
  activityProps: null as null | {
    activities: Array<{ id: string; description: string }>;
  },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'account-a' } }),
}));

vi.mock('../../src/services/VIPService', () => ({
  VIP_MONTHLY_ALLOWANCES: {
    rabbitHunts: 100,
    timeBankSeconds: 120,
    emojis: 1200,
    tags: 1000,
    throwables: 500,
  },
  FEATURE_PRICING: {
    rabbit_hunt: { cost: 5, usageType: 'per_use', description: 'Reveal Undealt Cards' },
  },
  vipService: {
    checkVIPStatus: vi.fn(() =>
      Promise.resolve({
        isVIP: false,
        status: 'none',
        expiresAt: null,
        monthlyLimits: {
          rabbitHunts: { used: 0, limit: 0 },
          timeBankSeconds: { used: 0, limit: 0 },
          emojis: { used: 0, limit: 0 },
          tags: { used: 0, limit: 0 },
          throwables: { used: 0, limit: 0 },
        },
      })
    ),
    purchaseFeature: vi.fn(),
  },
  normalizeVIPPurchaseError: () => 'Purchase Failed',
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.maybeSingle = () =>
        table === 'profiles' ? mocks.profilesResponse() : mocks.vipPointsResponse();
      builder.limit = () =>
        table === 'diamond_transactions'
          ? mocks.ledgerResponse()
          : Promise.resolve({ data: [], error: null });
      return builder;
    },
    rpc: vi.fn(),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
  reportWarning: vi.fn(),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribeDebounced: vi.fn(() => () => {}) },
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));

vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: (props: { metrics?: Array<{ label: string; value: string }> }) => (
    <div>
      {(props.metrics || []).map((m) => (
        <div key={m.label} data-testid={`metric-${m.label}`}>
          {m.value}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => <div>Loading</div> }));
vi.mock('../../src/components/vip/VIPCardsModal', () => ({ VIPCardsModal: () => null }));
vi.mock('../../src/components/vip/VIPPerksGrid', () => ({ VIPPerksGrid: () => null }));
vi.mock('../../src/components/vip/DiamondTopUpModal', () => ({ DiamondTopUpModal: () => null }));
vi.mock('../../src/components/vip/VIPMembershipPlate', () => ({
  VIPMembershipPlate: (props: {
    points: { current: number; lifetime: number };
    pointsState?: string;
  }) => {
    mocks.platePoints = props;
    return null;
  },
}));
vi.mock('../../src/components/vip/RewardsMarketplace', () => ({ RewardsMarketplace: () => null }));
vi.mock('../../src/components/vip/VIPActivityHistory', () => ({
  VIPActivityHistory: (props: { activities: Array<{ id: string; description: string }> }) => {
    mocks.activityProps = props;
    return null;
  },
}));
vi.mock('../../src/components/wallet/DiamondWalletModal', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/components/wallet/DiamondWalletModal'
  );
  // Keep the REAL `diamondTxLabel`: it is the thing under test in the last case.
  return { ...actual, default: () => null };
});

import VIPPage from '../../src/pages/VIPPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.profilesResponse.mockImplementation(() =>
    Promise.resolve({ data: { diamonds: 100 }, error: null })
  );
  mocks.vipPointsResponse.mockImplementation(() =>
    Promise.resolve({ data: { current_points: 42, lifetime_points: 77 }, error: null })
  );
  mocks.ledgerResponse.mockImplementation(() => Promise.resolve({ data: [], error: null }));
  mocks.platePoints = null;
  mocks.activityProps = null;
});

/* The big diamond figure, read off the element that owns it, never by a
   plain `getByText('0')`. Until 2026-09-30 the ambiguity was a Monthly
   header metric that was also permanently 0; that metric has been deleted
   (nothing computed it), but reading the figure off its own element is the
   correct habit regardless of what else happens to be on the page. */
const balanceText = (container: HTMLElement) =>
  container.querySelector('.diamond-count')?.textContent ?? '';

describe('the VIP page keeps a failed read apart from a real zero', () => {
  it('a diamond balance that could not be read prints Unavailable, not 0', async () => {
    mocks.profilesResponse.mockImplementation(() =>
      Promise.resolve({
        data: null as never,
        error: { message: 'permission denied for table profiles' } as never,
      })
    );

    const { container } = render(<VIPPage />);

    await waitFor(() => expect(balanceText(container)).toBe('Unavailable'));
    // The figure is not a number at all, so nothing downstream can read it as
    // a balance the player actually holds.
    expect(balanceText(container)).not.toMatch(/\d/);
    expect(
      mocks.reportError.mock.calls.some(
        (call) => call[1] === 'VIPPage.Diamond_balance_load_failed'
      ),
      'a failed money read is reported, not swallowed'
    ).toBe(true);
  });

  it('a genuine zero balance still prints 0', async () => {
    mocks.profilesResponse.mockImplementation(() =>
      Promise.resolve({ data: { diamonds: 0 }, error: null })
    );

    const { container } = render(<VIPPage />);

    await waitFor(() => expect(balanceText(container)).toBe('0'));
    expect(container.textContent).not.toContain('Unavailable');
    expect(
      mocks.reportError.mock.calls.some((call) => call[1] === 'VIPPage.Diamond_balance_load_failed')
    ).toBe(false);
  });

  it('VIP points that could not be read reach the plate and the header as unknown', async () => {
    mocks.vipPointsResponse.mockImplementation(() =>
      Promise.resolve({
        data: null as never,
        error: { message: 'could not connect' } as never,
      })
    );

    render(<VIPPage />);

    await waitFor(() => expect(mocks.platePoints?.pointsState).toBe('error'));
    expect(screen.getByTestId('metric-Current Points').textContent).toBe('Unavailable');
    expect(
      mocks.reportError.mock.calls.some((call) => call[1] === 'VIPPage.Vip_points_load_failed')
    ).toBe(true);
  });

  it('VIP points that read as zero are ready, not unknown', async () => {
    mocks.vipPointsResponse.mockImplementation(() =>
      Promise.resolve({ data: { current_points: 0, lifetime_points: 0 }, error: null })
    );

    render(<VIPPage />);

    await waitFor(() => expect(mocks.platePoints?.pointsState).toBe('ready'));
    expect(screen.getByTestId('metric-Current Points').textContent).toBe('0');
  });
});

/**
 * 2026-09-30. The header carried a "Monthly" and an "Active Streak" metric,
 * and the plate a "This Month" and an "Active Streak" cell. Nothing wrote
 * any of them: `vip_points` returns only current_points and lifetime_points,
 * and no other writer existed, so all four printed a permanent fabricated
 * zero. They are gone, and the state fields behind them are gone with them
 * so a later reader cannot resurrect the zero.
 *
 * The removal assertions below are deliberately paired with a genuine-zero
 * assertion. A suite that only proved the fabricated figures were absent
 * would pass just as happily against a page that had stopped reporting real
 * figures at all, which is the opposite failure and just as dishonest.
 */
describe('the VIP page offers no figure the platform does not compute', () => {
  it('has no Monthly or Active Streak metric, and passes neither to the plate', async () => {
    render(<VIPPage />);

    await waitFor(() => expect(mocks.platePoints?.pointsState).toBe('ready'));

    expect(screen.queryByTestId('metric-Monthly')).toBeNull();
    expect(screen.queryByTestId('metric-Active Streak')).toBeNull();

    const passed = mocks.platePoints?.points as Record<string, unknown> | undefined;
    expect(passed).toBeTruthy();
    expect(Object.keys(passed as Record<string, unknown>).sort()).toEqual(['current', 'lifetime']);
  });

  it('still reports the two figures it does compute, including real zeros', async () => {
    mocks.vipPointsResponse.mockImplementation(() =>
      Promise.resolve({ data: { current_points: 0, lifetime_points: 0 }, error: null })
    );

    render(<VIPPage />);

    // A player who genuinely holds nothing is still told so, by both figures.
    await waitFor(() => expect(mocks.platePoints?.points.current).toBe(0));
    expect(mocks.platePoints?.points.lifetime).toBe(0);
    expect(mocks.platePoints?.pointsState).toBe('ready');
    expect(screen.getByTestId('metric-Current Points').textContent).toBe('0');
  });
});

describe('the VIP activity list never prints a raw kind to a player', () => {
  it('a row with no player_line takes the kind row label, not the snake_case enum', async () => {
    mocks.ledgerResponse.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            id: 'tx-1',
            type: null,
            transaction_type: 'arena_deposit',
            amount: -50,
            player_line: null,
            balance_after: 50,
            created_at: '2026-09-30T00:00:00.000Z',
          },
        ],
        error: null,
      })
    );

    render(<VIPPage />);

    await waitFor(() => expect(mocks.activityProps?.activities.length).toBe(1));
    const description = mocks.activityProps?.activities[0].description;
    expect(description).toBe('Diamond Arena Buy-In');
    expect(description).not.toBe('arena_deposit');
  });
});
