import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  clubId: 'club-a' as string | undefined,
  userId: 'viewer',
  hand: null as null | (() => void),
  hit: null as null | (() => void),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => io.rpc(...args),
    from: (...args: unknown[]) => io.from(...args),
    channel: () => {
      const c = {
        on: (_a: unknown, _b: unknown, cb: () => void) => {
          io.hit = cb;
          return c;
        },
        subscribe: () => c,
      };
      return c;
    },
    removeChannel: vi.fn(),
  },
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ clubId: io.clubId }) }));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: io.userId } }) }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => io.toast }));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../src/lib/bbjPoolFeed', () => ({
  watchBbjPool: () => () => {},
  getBbjAllocationPolicy: async () => null,
  BBJ_PIVOT_APPROACH_FRACTION: 0.8,
}));
vi.mock('../src/components/club-buttons', () => ({
  ArenaJackpotDisplay: () => <div>Jackpot Display</div>,
}));
vi.mock('../src/components/bbj/BBJRulesPanel', () => ({ default: () => <div>Rules</div> }));
vi.mock('../src/components/bbj/BBJHandDetail', () => ({ BBJHandDetail: () => null }));
vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => {
      const c = { on: () => c, subscribe: () => c };
      return c;
    },
    removeRegisteredChannel: vi.fn(),
    subscribe: () => () => {},
    subscribeDebounced: (_event: string, cb: () => void) => {
      io.hand = cb;
      return () => {};
    },
  },
}));

import Page from '../src/pages/BadBeatJackpotPage';
import { BBJRecentHits } from '../src/components/bbj/BBJRecentHits';
import { BBJAdminAnalytics } from '../src/components/bbj/BBJAdminAnalytics';
import { __resetBbjMiniFeedForTests, watchBbjMini } from '../src/lib/bbjMiniFeed';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const result = (data: unknown) => ({ data, error: null });
const pool = {
  id: 'pool-a',
  club_id: 'club-a',
  main_balance: 100,
  backup_balance: 25,
  promo_balance: 4,
  total_contributed: 129,
};
let requests: Record<string, ReturnType<typeof deferred>>;
let promo: ReturnType<typeof deferred>;
beforeEach(() => {
  __resetBbjMiniFeedForTests();
  io.clubId = 'club-a';
  io.userId = 'viewer';
  io.rpc.mockReset();
  io.from.mockReset();
  io.hand = null;
  io.hit = null;
  promo = deferred();
  promo.resolve(result([{ is_operator: false }]));
  requests = Object.fromEntries(
    ['fn_bbj_recent_hits', 'fn_bbj_analytics', 'fn_bbj_mini_for_club'].map((k) => [k, deferred()])
  );
  io.rpc.mockImplementation((name: string) =>
    name === 'fn_bbj_promo_facts'
      ? promo.promise
      : (requests[name]?.promise ?? Promise.resolve(result([])))
  );
  io.from.mockImplementation((table: string) => {
    const q = {
      select: (s: string) => {
        expect(s).not.toContain('owner_id');
        return q;
      },
      eq: () => q,
      maybeSingle: () =>
        table === 'clubs'
          ? Promise.resolve(result({ union_id: null }))
          : Promise.resolve(result(pool)),
    };
    return q;
  });
});
afterEach(() => __resetBbjMiniFeedForTests());
const root = (c: HTMLElement) => c.querySelector('.bbj-page')!;
const pending = (c: HTMLElement) => c.querySelectorAll('[data-initial-layout="pending"]');

it('settles after StrictMode retires and restarts the initial scope effect', async () => {
  const { container } = render(
    <StrictMode>
      <Page />
    </StrictMode>
  );
  await act(async () => Object.values(requests).forEach((r) => r.resolve(result([]))));
  await screen.findByText('Jackpot Display');
  expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
});

it('keeps first-layout pending for the actual promo, mini, analytics and recent-hit reads', async () => {
  promo = deferred();
  const { container } = render(<Page />);
  await waitFor(() =>
    expect(io.rpc).toHaveBeenCalledWith('fn_bbj_promo_facts', { p_pool_id: 'pool-a' })
  );
  expect(root(container)).toHaveAttribute('data-initial-layout', 'pending');
  expect(screen.queryByText('Jackpot Display')).not.toBeInTheDocument();
  await act(async () => promo.resolve(result([{ is_operator: false }])));
  await screen.findByText('Jackpot Display');
  expect(root(container)).toHaveAttribute('data-initial-layout', 'pending');
  expect(pending(container)).toHaveLength(3);
  expect(root(container)).toHaveAttribute('data-initial-layout', 'pending');
  await act(async () => {
    requests.fn_bbj_mini_for_club.resolve(
      result([{ pool_id: 'pool-a', enabled: true, tiers: [] }])
    );
  });
  expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
  expect(pending(container)).toHaveLength(2);
  await act(async () => {
    requests.fn_bbj_analytics.resolve(result([{ contributions_7d: 7, net_pool_position: 3 }]));
  });
  expect(pending(container)).toHaveLength(1);
  await act(async () => {
    requests.fn_bbj_recent_hits.resolve(result([]));
  });
  expect(pending(container)).toHaveLength(0);
  expect(screen.getByText('Jackpot Health')).toBeInTheDocument();
});

it.each(['empty', 'error', 'rejected'] as const)(
  'settles terminal %s outcomes without inventing a mini balance',
  async (outcome) => {
    const { container } = render(<Page />);
    await screen.findByText('Jackpot Display');
    await act(async () => {
      for (const request of Object.values(requests)) {
        if (outcome === 'rejected') request.reject(new Error('offline'));
        else
          request.resolve(
            outcome === 'error' ? { data: null, error: { message: 'denied' } } : result([])
          );
      }
    });
    expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
    expect(pending(container)).toHaveLength(0);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Jackpot Health')).not.toBeInTheDocument();
  }
);

it('keeps pending child reads mounted across routine hand refreshes', async () => {
  const { container } = render(<Page />);
  await screen.findByText('Jackpot Display');
  const hits = container.querySelector('.bbj-hits');
  await act(async () => {
    io.hand!();
  });
  expect(container.querySelector('.bbj-hits')).toBe(hits);
  expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_recent_hits')).toHaveLength(1);
  expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_analytics')).toHaveLength(1);
  await act(async () => {
    Object.values(requests).forEach((r) => r.resolve(result([])));
  });
  expect(pending(container)).toHaveLength(0);
});

it.each(['rows', 'error', 'rejected'] as const)(
  'waits for the current near-miss %s outcome before declaring admin layout settled',
  async (outcome) => {
    requests.fn_bbj_near_miss_summary = deferred();
    const { container } = render(<BBJAdminAnalytics poolId="pool-a" />);
    await act(async () => {
      requests.fn_bbj_analytics.resolve(result([{ contributions_7d: 7, net_pool_position: 3 }]));
    });
    expect(screen.getByText('Jackpot Health')).toBeInTheDocument();
    expect(pending(container)).toHaveLength(1);
    await act(async () => {
      const request = requests.fn_bbj_near_miss_summary;
      if (outcome === 'rejected') request.reject(new Error('offline'));
      else if (outcome === 'error') request.resolve({ data: null, error: { message: 'denied' } });
      else
        request.resolve(
          result([{ kind: 'main', reason: 'pot_too_small', refusals: 2, biggest_pot: 5 }])
        );
    });
    expect(pending(container)).toHaveLength(0);
    if (outcome === 'rows')
      expect(screen.getByText('Pot Did Not Reach The Minimum')).toBeInTheDocument();
    else expect(screen.getByText(/The Refusal Log Could Not Be Read/)).toBeInTheDocument();
  }
);

it('ignores a retired near-miss response while the next pool still loads', async () => {
  requests.fn_bbj_near_miss_summary = deferred();
  const retired = requests.fn_bbj_near_miss_summary;
  const { container, rerender } = render(<BBJAdminAnalytics poolId="pool-a" />);
  await act(async () => requests.fn_bbj_analytics.resolve(result([{ net_pool_position: 3 }])));
  requests.fn_bbj_analytics = deferred();
  requests.fn_bbj_near_miss_summary = deferred();
  rerender(<BBJAdminAnalytics poolId="pool-b" />);
  await act(async () => {
    requests.fn_bbj_analytics.resolve(result([{ net_pool_position: 4 }]));
    retired.resolve(
      result([{ kind: 'main', reason: 'pot_too_small', refusals: 2, biggest_pot: 5 }])
    );
  });
  expect(pending(container)).toHaveLength(1);
  expect(screen.queryByText('Pot Did Not Reach The Minimum')).not.toBeInTheDocument();
  await act(async () => requests.fn_bbj_near_miss_summary.resolve(result([])));
  expect(pending(container)).toHaveLength(0);
  expect(screen.getByText(/No Hand Was Refused In 30 Days/)).toBeInTheDocument();
});

it('does not settle or expose the old pool after a scope switch', async () => {
  const oldHits = requests.fn_bbj_recent_hits;
  const oldAdmin = requests.fn_bbj_analytics;
  const { container, rerender } = render(
    <>
      <BBJRecentHits poolId="pool-a" />
      <BBJAdminAnalytics poolId="pool-a" />
    </>
  );
  requests.fn_bbj_recent_hits = deferred();
  requests.fn_bbj_analytics = deferred();
  rerender(
    <>
      <BBJRecentHits poolId="pool-b" />
      <BBJAdminAnalytics poolId="pool-b" />
    </>
  );
  await act(async () => {
    oldHits.resolve(result([]));
    oldAdmin.resolve(result([{ net_pool_position: 999 }]));
  });
  expect(pending(container)).toHaveLength(2);
  await act(async () => {
    requests.fn_bbj_recent_hits.resolve(result([]));
    requests.fn_bbj_analytics.resolve(result([]));
  });
  expect(pending(container)).toHaveLength(0);
});

it('settles a missing route without starting requests', async () => {
  io.clubId = undefined;
  const { container } = render(<Page />);
  await waitFor(() => expect(root(container)).toHaveAttribute('data-initial-layout', 'settled'));
  expect(io.rpc).not.toHaveBeenCalled();
});

it('replays a shared terminal mini result and never calls a retired first-read listener', async () => {
  const retired = vi.fn(),
    live = vi.fn(),
    later = vi.fn();
  const stop = watchBbjMini('club-a', () => {}, retired);
  stop();
  const old = requests.fn_bbj_mini_for_club;
  requests.fn_bbj_mini_for_club = deferred();
  const stopLive = watchBbjMini('club-a', () => {}, live);
  await act(async () => old.resolve(result([])));
  expect(retired).not.toHaveBeenCalled();
  expect(live).not.toHaveBeenCalled();
  await act(async () => requests.fn_bbj_mini_for_club.resolve(result([])));
  const stopLater = watchBbjMini('club-a', () => {}, later);
  expect(live).toHaveBeenCalledWith('empty');
  expect(later).toHaveBeenCalledWith('empty');
  expect(io.rpc).toHaveBeenCalledTimes(2);
  stopLive();
  stopLater();
});

it('preserves rendered winner rows during an actual realtime refetch', async () => {
  const { container } = render(<BBJRecentHits poolId="pool-a" />);
  await act(async () =>
    requests.fn_bbj_recent_hits.resolve(
      result([
        {
          payout_id: 'fixture-hit',
          awarded_at: '2026-09-11T12:00:00Z',
          total_payout: 100,
          bad_beat_name: 'Fixture Winner',
          bad_beat_amount: 50,
          recipients: [],
        },
      ])
    )
  );
  expect(screen.getByText('Fixture Winner')).toBeInTheDocument();
  const row = container.querySelector('.bbj-hits__row');
  requests.fn_bbj_recent_hits = deferred();
  await act(async () => io.hit!());
  expect(container.querySelector('.bbj-hits__row')).toBe(row);
  expect(pending(container)).toHaveLength(0);
  await act(async () => requests.fn_bbj_recent_hits.resolve(result([])));
  expect(screen.queryByText('Fixture Winner')).not.toBeInTheDocument();
});

it('re-enters pending when returning to a prior pool before the intervening read completes', async () => {
  const renderPools = (id: string) => (
    <>
      <BBJRecentHits poolId={id} />
      <BBJAdminAnalytics poolId={id} />
    </>
  );
  const { container, rerender } = render(renderPools('pool-a'));
  await act(async () => {
    requests.fn_bbj_recent_hits.resolve(result([]));
    requests.fn_bbj_analytics.resolve(result([]));
  });
  requests.fn_bbj_recent_hits = deferred();
  requests.fn_bbj_analytics = deferred();
  rerender(renderPools('pool-b'));
  const intervening = { ...requests };
  requests.fn_bbj_recent_hits = deferred();
  requests.fn_bbj_analytics = deferred();
  rerender(renderPools('pool-a'));
  expect(pending(container)).toHaveLength(2);
  await act(async () => {
    intervening.fn_bbj_recent_hits.resolve(result([]));
    intervening.fn_bbj_analytics.resolve(result([]));
  });
  expect(pending(container)).toHaveLength(2);
  await act(async () => {
    requests.fn_bbj_recent_hits.resolve(result([]));
    requests.fn_bbj_analytics.resolve(result([]));
  });
  expect(pending(container)).toHaveLength(0);
});

const operatorFacts = (amount: number) =>
  result([
    {
      is_operator: true,
      purse_kind: 'club',
      purse_available: amount,
      contributed_all_time: 100,
      swept_all_time: 90,
      observed_rate_pct: 26.1,
    },
  ]);

it.each(['club', 'user'] as const)(
  'hides prior operator facts immediately while a new %s permission is pending',
  async (scope) => {
    promo = deferred();
    const { container, rerender } = render(<Page />);
    await act(async () => {
      promo.resolve(operatorFacts(98765));
      Object.values(requests).forEach((r) => r.resolve(result([])));
    });
    expect(await screen.findByText('The Promo Slice')).toBeInTheDocument();
    expect(screen.getByText('98,765 Chips')).toBeInTheDocument();
    promo = deferred();
    if (scope === 'club') io.clubId = 'club-b';
    else io.userId = 'other-viewer';
    rerender(<Page />);
    expect(screen.queryByText('The Promo Slice')).not.toBeInTheDocument();
    expect(screen.queryByText('98,765 Chips')).not.toBeInTheDocument();
    expect(root(container)).toHaveAttribute('data-initial-layout', 'pending');
    await waitFor(() =>
      expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(2)
    );
    await act(async () => promo.resolve(result([{ is_operator: false }])));
    await screen.findByText('Jackpot Display');
    expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
    expect(screen.queryByText('The Promo Slice')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Promo Rain Amount')).not.toBeInTheDocument();
  }
);

it.each(['club', 'user'] as const)(
  'ignores a late old-%s operator result after the new scope denied access',
  async (scope) => {
    promo = deferred();
    const oldPromo = promo;
    const { container, rerender } = render(<Page />);
    await waitFor(() =>
      expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(1)
    );
    promo = deferred();
    if (scope === 'club') io.clubId = 'club-b';
    else io.userId = 'other-viewer';
    rerender(<Page />);
    await waitFor(() =>
      expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(2)
    );
    await act(async () => {
      promo.resolve(result([{ is_operator: false }]));
      Object.values(requests).forEach((r) => r.resolve(result([])));
    });
    await screen.findByText('Jackpot Display');
    await act(async () => oldPromo.resolve(operatorFacts(98765)));
    expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
    expect(screen.queryByText('The Promo Slice')).not.toBeInTheDocument();
    expect(screen.queryByText('98,765 Chips')).not.toBeInTheDocument();
  }
);

it('does not let a retired A request settle a later A after an A to B to A switch', async () => {
  promo = deferred();
  const firstA = promo;
  const { container, rerender } = render(<Page />);
  await waitFor(() =>
    expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(1)
  );
  promo = deferred();
  const pendingB = promo;
  io.userId = 'other-viewer';
  rerender(<Page />);
  await waitFor(() =>
    expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(2)
  );
  promo = deferred();
  io.userId = 'viewer';
  rerender(<Page />);
  await waitFor(() =>
    expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(3)
  );
  await act(async () => {
    firstA.resolve(operatorFacts(98765));
    pendingB.resolve(operatorFacts(87654));
    Object.values(requests).forEach((r) => r.resolve(result([])));
  });
  await act(async () => io.hand!());
  expect(io.rpc.mock.calls.filter(([name]) => name === 'fn_bbj_promo_facts')).toHaveLength(3);
  expect(root(container)).toHaveAttribute('data-initial-layout', 'pending');
  expect(screen.queryByText('The Promo Slice')).not.toBeInTheDocument();
  await act(async () => promo.resolve(operatorFacts(12345)));
  expect(await screen.findByText('12,345 Chips')).toBeInTheDocument();
  expect(screen.queryByText('98,765 Chips')).not.toBeInTheDocument();
  expect(screen.queryByText('87,654 Chips')).not.toBeInTheDocument();
  expect(root(container)).toHaveAttribute('data-initial-layout', 'settled');
});
