// @vitest-environment happy-dom

import { act, render } from '@testing-library/react';
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
    render(<ChallengeToastListener />);

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
      'Challenge Complete: Play Ten Hands. Claim 10 Diamonds In Daily Challenges.'
    );
  });

  it('uses safe generic Title Case copy when catalog display text is absent', () => {
    render(<ChallengeToastListener />);

    act(() => {
      mocks.subscription?.onPayload({ id: 'row-unknown', challengeId: 'future_type' });
    });

    expect(mocks.success).toHaveBeenCalledWith(
      'Challenge Complete: Daily Challenge. Open Daily Challenges To Claim Your Reward.'
    );
  });
});
