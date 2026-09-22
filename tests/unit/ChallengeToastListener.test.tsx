// @vitest-environment happy-dom

import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111' as string | null,
  success: vi.fn(),
  subscription: null as null | {
    channelName: string | null | undefined;
    event: string;
    onPayload: (payload: unknown) => void;
  },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success }),
}));

vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: typeof mocks.subscription) => {
    mocks.subscription = options;
  },
}));

const { ChallengeToastListener } =
  await import('../../src/components/notifications/ChallengeToastListener');
const { dailyMissionCompletionFromPayload } =
  await import('../../src/utils/dailyMissionCompletion');

/* The listener navigates, so it mounts inside a router, as it does in the app:
   App.tsx mounts it and main.tsx renders App inside BrowserRouter. The probe
   prints where a tap on the toast went, and `router.navigate` moves the
   player between the toast arriving and the tap. */
const router = { navigate: (_to: string): void => undefined };

function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    router.navigate = (to) => {
      void navigate(to);
    };
  }, [navigate]);
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderListener(at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <ChallengeToastListener />
      <RouterProbe />
    </MemoryRouter>
  );
}

function tapToast() {
  const onClick = mocks.success.mock.calls[0]?.[2] as (() => void) | undefined;
  expect(onClick).toBeTypeOf('function');
  act(() => {
    onClick?.();
  });
}

describe('ChallengeToastListener', () => {
  beforeEach(() => {
    mocks.userId = '11111111-1111-4111-8111-111111111111';
    mocks.success.mockReset();
    mocks.subscription = null;
  });

  it('parses direct and nested private Broadcast receipts safely', () => {
    expect(
      dailyMissionCompletionFromPayload({
        payload: {
          id: 'row-1',
          name: 'win a showdown',
          diamondReward: 25,
        },
      })
    ).toEqual({ id: 'row-1', name: 'Win A Showdown', diamondReward: 25 });
    expect(dailyMissionCompletionFromPayload({ data: { challengeId: 'unknown' } })).toBeNull();
  });

  it('subscribes to the private completion topic and dedupes duplicate frames', () => {
    renderListener();

    expect(mocks.subscription).toMatchObject({
      channelName: `daily-mission-completion:${mocks.userId}`,
      event: 'daily_mission_completed',
    });

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-1', name: 'play ten hands', diamondReward: 10 });
      mocks.subscription?.onPayload({ id: 'row-1', name: 'play ten hands', diamondReward: 10 });
    });

    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith(
      'Challenge Complete: Play Ten Hands. Claim 10 Diamonds In Daily Challenges.',
      undefined,
      expect.any(Function)
    );
  });

  it('uses safe generic Title Case copy when catalog display text is absent', () => {
    renderListener();

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-unknown', challengeId: 'future_type' });
    });

    expect(mocks.success).toHaveBeenCalledWith(
      'Challenge Complete: Daily Challenge. Open Daily Challenges To Claim Your Reward.',
      undefined,
      expect.any(Function)
    );
  });

  it('opens Daily Challenges inside the club the current page names when tapped', () => {
    renderListener('/wallet?club=deep-stack-society');

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-2', name: 'win a showdown', diamondReward: 25 });
    });
    tapToast();

    expect(screen.getByTestId('location').textContent).toBe('/challenges?club=deep-stack-society');
  });

  it('opens plain Daily Challenges when the current page names no club', () => {
    renderListener('/profile');

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-3', name: 'play ten hands', diamondReward: 10 });
    });
    tapToast();

    expect(screen.getByTestId('location').textContent).toBe('/challenges');
  });

  it('reads the club from where the player is when they tap, not where the toast arrived', () => {
    renderListener('/profile');

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-4', name: 'play ten hands', diamondReward: 10 });
    });
    act(() => {
      router.navigate('/leaderboard?club=deep-stack-society');
    });
    tapToast();

    expect(screen.getByTestId('location').textContent).toBe('/challenges?club=deep-stack-society');
  });
});
