import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: { id: 'owner-a' } as { id: string } | null,
  scope: { status: 'ready', userId: 'owner-a', clubId: 'club-a', platformWide: false },
  requests: [] as any[],
  channels: [] as any[],
  response: (_q: any): any => ({ data: [], error: null }),
  toast: { error: vi.fn() },
  sound: vi.fn(),
  haptic: vi.fn(),
  removed: vi.fn(),
  removedFactory: vi.fn(),
  factories: new Map<string, () => void>(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const q: any = {
        table,
        filters: {},
        select: (v: string) => {
          q.columns = v;
          return q;
        },
        eq: (k: string, v: string) => {
          q.filters[k] = v;
          return q;
        },
        limit: (n: number) => {
          q.limitCount = n;
          return q;
        },
        order: () => q,
        abortSignal: (s: AbortSignal) => {
          q.signal = s;
          return q;
        },
        maybeSingle: () => q,
        then: (resolve: any, reject: any) => {
          h.requests.push(q);
          return Promise.resolve(h.response(q)).then(resolve, reject);
        },
      };
      return q;
    },
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: h.user }) }));
vi.mock('../../src/hooks/useFinancialAdminScope', async (original) => ({
  ...(await original<any>()),
  useFinancialAdminScope: () => h.scope,
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: vi.fn(() => vi.fn()),
    registerChannelFactory: (name: string, fn: () => void) => h.factories.set(name, fn),
    removeChannelFactory: h.removedFactory,
    removeRegisteredChannel: h.removed,
    getOrCreateChannel: (name: string) => {
      const ch: any = {
        name,
        state: 'closed',
        on: (type: string, filter: any, fn: any) => {
          ch.type = type;
          ch.filter = filter;
          ch.payload = fn;
          return ch;
        },
        subscribe: (fn: any) => {
          ch.status = fn;
          return ch;
        },
      };
      h.channels.push(ch);
      return ch;
    },
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ haptic: { success: h.haptic } }));
vi.mock('../../src/services/SoundService', () => ({ soundService: { playAchievement: h.sound } }));
vi.mock('../../src/components/achievements/AchievementBadge', () => ({
  default: ({ name, progress, unlocked }: any) => (
    <output data-testid={name}>
      {progress}:{String(unlocked)}
    </output>
  ),
  AchievementGrid: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('../../src/components/achievements/AchievementShareCard', () => ({
  AchievementShareCard: () => null,
}));
vi.mock('../../src/components/common/BottomSheet', () => ({ default: () => null }));
vi.mock('../../src/components/gamification/StreakFire', () => ({ StreakFire: () => null }));
vi.mock('../../src/components/common/ActivityHeatmap', () => ({ default: () => null }));
vi.mock('../../src/components/gamification/ConfettiEffect', () => ({ ConfettiEffect: () => null }));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, pill, title, titleAs: Title = 'h2', titleId }: any) => (
    <div>
      <Title id={titleId}>{title}</Title>
      {pill && <span>{pill}</span>}
      {children}
    </div>
  ),
}));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ metrics }: any) => (
    <div>
      {metrics.map((m: any) => (
        <output key={m.label} data-testid={m.label}>
          {m.value}
        </output>
      ))}
    </div>
  ),
}));
vi.mock('../../src/components/common/EmptyState', () => ({
  ErrorState: ({ message, onRetry }: any) => (
    <div role="alert">
      {message}
      <button onClick={onRetry}>Retry</button>
    </div>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({
  default: () => <div>Loading History</div>,
}));
vi.mock('../../src/components/common/FinancialAdminScopeState', () => ({
  default: () => <div>Verify Club Access</div>,
}));

import AchievementsPage from '../../src/pages/AchievementsPage';
import RateAuditPage from '../../src/pages/RateAuditPage';
import { achievementService } from '../../src/services/AchievementService';

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const progress = (user = 'owner-a', n: any = 10, unlocked: any = null) => ({
  id: 'progress-1',
  user_id: user,
  achievement_id: 'hands_100',
  progress: n,
  unlocked_at: unlocked,
});
const RATE_AUDIT_A = '11111111-1111-4111-8111-111111111111';
const RATE_AUDIT_B = '22222222-2222-4222-8222-222222222222';
const RATE_AUDIT_C = '33333333-3333-4333-8333-333333333333';
const RATE_AUDIT_D = '44444444-4444-4444-8444-444444444444';
const RATE_AGENT = '55555555-5555-4555-8555-555555555555';
const RATE_OPERATOR = '66666666-6666-4666-8666-666666666666';
const RATE_CLUB_A = '77777777-7777-4777-8777-777777777777';
const RATE_CLUB_B = '88888888-8888-4888-8888-888888888888';
const rate = (id = RATE_AUDIT_A, value: any = 0.1, clubId = RATE_CLUB_A) => ({
  id,
  agent_id: RATE_AGENT,
  club_id: clubId,
  changed_by: RATE_OPERATOR,
  old_rate: 0.05,
  new_rate: value,
  rate_type: 'commission',
  created_at: '2026-09-20T12:00:00Z',
});
const count = (table: string) => h.requests.filter((q) => q.table === table).length;
let visibility: DocumentVisibilityState;
let online: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.requests = [];
  h.channels = [];
  h.factories.clear();
  h.user = { id: 'owner-a' };
  h.scope = { status: 'ready', userId: 'owner-a', clubId: 'club-a', platformWide: false };
  h.response = (q) => ({
    data:
      q.table === 'profiles'
        ? { login_streak: 4 }
        : q.table === 'training_user_achievements'
          ? [progress()]
          : [],
    error: null,
  });
  visibility = 'visible';
  online = true;
  sessionStorage.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('achievement reads and page-owned notification invalidation', () => {
  it('observes progress only on an open visible online page without training WAL or writes', async () => {
    const view = render(<AchievementsPage />);
    await settle();
    expect(screen.getByTestId('Getting Started').textContent).toBe('10:false');
    expect(h.channels[0].filter).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: 'user_id=eq.owner-a',
    });
    h.response = (q) => ({
      data: q.table === 'profiles' ? { login_streak: 5 } : [progress('owner-a', 55)],
      error: null,
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByTestId('Getting Started').textContent).toBe('55:false');
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(count('training_user_achievements')).toBe(2);
    visibility = 'visible';
    online = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(count('training_user_achievements')).toBe(2);
    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await settle();
    expect(count('training_user_achievements')).toBe(3);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(count('training_user_achievements')).toBe(3);
    expect(h.removed).toHaveBeenCalledWith('achievement-notifications-owner-a');
    expect(h.removedFactory).toHaveBeenCalledWith('achievement-notifications-owner-a');
  });

  it('accepts only the owner achievement signal, then celebrates the authoritative unlock once', async () => {
    render(<AchievementsPage />);
    await settle();
    const ch = h.channels[0];
    for (const row of [
      { user_id: 'owner-b', type: 'achievement', data: { achievement_id: 'hands_100' } },
      { user_id: 'owner-a', type: 'message', data: { achievement_id: 'hands_100' } },
      { user_id: 'owner-a', type: 'achievement', data: { achievement_id: 'invented' } },
    ])
      await act(async () => {
        await ch.payload({ new: row });
      });
    await settle();
    expect(count('training_user_achievements')).toBe(1);
    const event = {
      new: { user_id: 'owner-a', type: 'achievement', data: { achievement_id: 'hands_100' } },
    };
    await act(async () => {
      await ch.payload(event);
    });
    await settle();
    expect(screen.queryByText('Achievement Unlocked!')).toBeNull();
    expect(h.sound).not.toHaveBeenCalled();
    h.response = (q) => ({
      data:
        q.table === 'profiles'
          ? { login_streak: 4 }
          : [progress('owner-a', 100, '2026-09-27T00:00:00Z')],
      error: null,
    });
    await act(async () => {
      await ch.payload(event);
    });
    await settle();
    expect(screen.getByText('Achievement Unlocked!')).toBeTruthy();
    expect(h.sound).toHaveBeenCalledOnce();
    expect(h.haptic).toHaveBeenCalledOnce();
    const reads = count('training_user_achievements');
    await act(async () => {
      await ch.payload(event);
    });
    await settle();
    expect(count('training_user_achievements')).toBe(reads);
    expect(h.sound).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByText('Achievement Unlocked!')).toBeNull();
    act(() => ch.status('SUBSCRIBED'));
    await settle();
    expect(count('training_user_achievements')).toBe(reads + 1);
    expect(h.sound).toHaveBeenCalledOnce();
  });

  it('aborts late owner reads, discards old channels, and clears owner counters on account change', async () => {
    let resolve!: (value: any) => void;
    h.response = (q) =>
      q.table === 'profiles'
        ? { data: { login_streak: 9 }, error: null }
        : new Promise((r) => {
            resolve = r;
          });
    const view = render(<AchievementsPage />);
    await settle();
    const old = h.channels[0];
    const request = h.requests.find((q) => q.table === 'training_user_achievements');
    h.user = { id: 'owner-b' };
    h.response = (q) => ({
      data: q.table === 'profiles' ? { login_streak: 1 } : [progress('owner-b', 20)],
      error: null,
    });
    view.rerender(<AchievementsPage />);
    await settle();
    expect(request.signal.aborted).toBe(true);
    expect(screen.getByTestId('Getting Started').textContent).toBe('20:false');
    await act(async () =>
      resolve({ data: [progress('owner-a', 100, '2026-09-27T00:00:00Z')], error: null })
    );
    const reads = h.requests.length;
    act(() => {
      old.payload({
        new: { user_id: 'owner-a', type: 'achievement', data: { achievement_id: 'hands_100' } },
      });
      old.status('SUBSCRIBED');
    });
    await settle();
    expect(h.requests).toHaveLength(reads);
    expect(screen.getByTestId('Getting Started').textContent).toBe('20:false');
    expect(h.sound).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('ach_cache_owner-a')).toBeNull();
  });

  it('reports read failure and recovers on demand without disabling the singleton for another account', async () => {
    h.response = (q) =>
      q.table === 'profiles'
        ? { data: { login_streak: 2 }, error: null }
        : { data: null, error: new Error('RLS refused') };
    render(<AchievementsPage />);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByTestId('Getting Started')).toBeNull();
    h.response = (q) => ({
      data: q.table === 'profiles' ? { login_streak: 2 } : [progress('owner-a', 30)],
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByTestId('Getting Started').textContent).toBe('30:false');
    h.response = () => ({ data: [progress('owner-b', 41)], error: null });
    expect((await achievementService.getUserAchievements('owner-b'))[0].progress).toBe(41);
  });

  it('keeps a hidden unlock pending until an authoritative visible read', async () => {
    render(<AchievementsPage />);
    await settle();
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    h.response = (q) => ({
      data:
        q.table === 'profiles'
          ? { login_streak: 4 }
          : [progress('owner-a', 100, '2026-09-27T00:00:00Z')],
      error: null,
    });
    act(() => {
      h.channels[0].payload({
        new: { user_id: 'owner-a', type: 'achievement', data: { achievement_id: 'hands_100' } },
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(count('training_user_achievements')).toBe(1);
    expect(h.sound).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(screen.getByText('Achievement Unlocked!')).toBeTruthy();
    expect(h.sound).toHaveBeenCalledOnce();
  });

  it('does not carry the displayed unlock count or popup into the next account', async () => {
    h.response = (q) => ({
      data:
        q.table === 'profiles'
          ? { login_streak: 9 }
          : [progress('owner-a', 100, '2026-09-27T00:00:00Z')],
      error: null,
    });
    const view = render(<AchievementsPage />);
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(screen.getByTestId('Unlocked').textContent).toBe('1');
    act(() => {
      h.channels[0].payload({
        new: { user_id: 'owner-a', type: 'achievement', data: { achievement_id: 'hands_100' } },
      });
    });
    await settle();
    expect(screen.getByText('Achievement Unlocked!')).toBeTruthy();
    h.user = { id: 'owner-b' };
    h.response = () => new Promise(() => {});
    view.rerender(<AchievementsPage />);
    await settle();
    expect(screen.getByTestId('Unlocked').textContent).toBe('0');
    expect(screen.queryByText('Achievement Unlocked!')).toBeNull();
    expect(screen.queryByTestId('Getting Started')).toBeNull();
    expect(screen.getByTestId('Login Streak').textContent).toBe('Unavailable');
  });

  it.each([null, undefined, '', ' ', false, 'invalid', -1, Infinity])(
    'refuses malformed progress %s instead of zero',
    async (value) => {
      h.response = () => ({ data: [{ ...progress(), progress: value }], error: null });
      await expect(achievementService.getUserAchievements('owner-a')).rejects.toThrow('not valid');
    }
  );
});

describe('visible scoped rate history', () => {
  beforeEach(() => {
    h.scope = {
      status: 'ready',
      userId: 'owner-a',
      clubId: RATE_CLUB_A,
      platformWide: false,
    };
  });

  it('labels an authorized empty history as zero changes without offering a retry', async () => {
    h.response = () => ({ data: [], error: null });
    render(<RateAuditPage />);
    await settle();
    expect(screen.getByText('0 Changes', { exact: true })).toBeTruthy();
    expect(screen.getByText('No Rate Changes Recorded Yet', { exact: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).toBeNull();
  });

  it('observes bounded histories for the authorized club, pauses when hidden and cleans up', async () => {
    h.response = (q) => ({
      data: q.table === 'commission_rate_audit' ? [rate()] : [],
      error: null,
    });
    const view = render(<RateAuditPage />);
    await settle();
    const headings = screen.getAllByRole('heading', { name: 'Rate Audit Trail' });
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe('H1');
    expect(screen.getByText('10.0%')).toBeTruthy();
    expect(h.requests).toHaveLength(2);
    for (const q of h.requests) {
      expect(q.filters.club_id).toBe(RATE_CLUB_A);
      expect(q.limitCount).toBe(100);
      expect(q.signal).toBeInstanceOf(AbortSignal);
    }
    h.response = (q) => ({
      data: q.table === 'commission_rate_audit' ? [rate(RATE_AUDIT_B, 0.15)] : [],
      error: null,
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText('15.0%')).toBeTruthy();
    expect(screen.queryByText('10.0%')).toBeNull();
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(h.requests).toHaveLength(4);
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(h.requests).toHaveLength(6);
    expect(h.channels).toHaveLength(0);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(h.requests).toHaveLength(6);
  });

  it('cannot query under a previous account scope and rejects the old club late reply', async () => {
    let resolve!: (value: any) => void;
    h.response = (q) =>
      q.table === 'commission_rate_audit'
        ? new Promise((r) => {
            resolve = r;
          })
        : { data: [], error: null };
    const view = render(<RateAuditPage />);
    await settle();
    const old = h.requests[0];
    h.user = { id: 'owner-b' };
    view.rerender(<RateAuditPage />);
    await settle();
    const accessHeading = screen.getAllByRole('heading', { name: 'Rate Audit Trail' });
    expect(accessHeading).toHaveLength(1);
    expect(accessHeading[0].tagName).toBe('H1');
    expect(screen.getByText('Verify Club Access')).toBeTruthy();
    expect(h.requests).toHaveLength(2);
    expect(old.signal.aborted).toBe(true);
    h.scope = {
      status: 'ready',
      userId: 'owner-b',
      clubId: RATE_CLUB_B,
      platformWide: false,
    };
    h.response = (q) => ({
      data: q.table === 'commission_rate_audit' ? [rate(RATE_AUDIT_C, 0.2, RATE_CLUB_B)] : [],
      error: null,
    });
    view.rerender(<RateAuditPage />);
    await settle();
    expect(screen.getByText('20.0%')).toBeTruthy();
    await act(async () => resolve({ data: [rate(RATE_AUDIT_D, 0.8, RATE_CLUB_A)], error: null }));
    expect(screen.queryByText('80.0%')).toBeNull();
    expect(h.requests.slice(2).every((q) => q.filters.club_id === RATE_CLUB_B)).toBe(true);
  });

  it.each([null, '', false, 'not-a-rate', Number.POSITIVE_INFINITY])(
    'refuses the malformed rate value %s instead of coercing it to zero',
    async (value) => {
      h.response = (q) => ({
        data: q.table === 'commission_rate_audit' ? [{ ...rate(), old_rate: value }] : [],
        error: null,
      });
      render(<RateAuditPage />);
      await settle();

      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(screen.queryByText('0.0%')).toBeNull();
    }
  );

  it('refuses a well-formed rate row from another club', async () => {
    h.response = (q) => ({
      data: q.table === 'commission_rate_audit' ? [rate(RATE_AUDIT_B, 0.2, RATE_CLUB_B)] : [],
      error: null,
    });
    render(<RateAuditPage />);
    await settle();

    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('20.0%')).toBeNull();
  });

  it('renders either failed source as unavailable, then recovers both histories on retry', async () => {
    h.response = (q) =>
      q.table === 'rake_rate_audit'
        ? { data: null, error: new Error('Read refused') }
        : { data: [rate()], error: null };
    render(<RateAuditPage />);
    await settle();
    expect(screen.queryByText('10.0%')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    h.response = (q) => ({
      data: q.table === 'commission_rate_audit' ? [rate()] : [],
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('10.0%')).toBeTruthy();
  });
});
