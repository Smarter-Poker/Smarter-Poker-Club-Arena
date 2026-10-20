/**
 * MilestoneToast is mounted at the app root with only the root error boundary
 * above it. AchievementTriggerService once sent `reward: { chips: 100 }` - an
 * object - and the toast handed it to formatPopupText, whose `.replace` threw
 * during render: one achievement would have replaced the whole app, open
 * tables included, with the error screen (2026-10-20). These pin that a bus
 * payload of any shape renders, and that a structured reward reads as text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, act } from '@testing-library/react';

let handler: ((data: unknown) => void) | null = null;
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (_event: string, cb: (data: unknown) => void) => {
    handler = cb;
  },
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playAchievement: vi.fn() },
  haptic: { medium: vi.fn() },
}));

import { MilestoneToast, milestoneRewardText } from '../../src/components/common/MilestoneToast';

function fire(data: unknown) {
  act(() => handler?.(data));
}

describe('milestoneRewardText', () => {
  it('reads a structured reward as text', () => {
    expect(milestoneRewardText({ chips: 100 })).toBe('+100 Chips');
    expect(milestoneRewardText({ chips: 1500 })).toBe(`+${(1500).toLocaleString()} Chips`);
    expect(milestoneRewardText({ diamonds: 500 })).toBe('+500 Diamonds');
    expect(milestoneRewardText({ chips: 5, diamonds: 2 })).toBe('+5 Chips And +2 Diamonds');
  });

  it('passes text through and invents nothing for anything else', () => {
    expect(milestoneRewardText('Free Spin')).toBe('Free Spin');
    for (const v of [
      undefined,
      null,
      '',
      '  ',
      0,
      12,
      [],
      {},
      { chips: 0 },
      { chips: 'x' },
      { other: 9 },
    ]) {
      expect(milestoneRewardText(v)).toBeUndefined();
    }
  });
});

describe('MilestoneToast renders any bus payload without throwing', () => {
  beforeEach(() => {
    handler = null;
  });

  it('an object reward renders as "+100 Chips"', () => {
    render(
      <MemoryRouter>
        <MilestoneToast />
      </MemoryRouter>
    );
    expect(() =>
      fire({
        milestoneName: 'royal flush',
        description: 'hit a royal flush',
        reward: { chips: 100 },
      })
    ).not.toThrow();
    expect(screen.getByText('Royal Flush')).toBeTruthy();
    expect(screen.getByText('Reward: +100 Chips')).toBeTruthy();
  });

  it('non-string title, description, icon and reward never reach .replace', () => {
    render(
      <MemoryRouter>
        <MilestoneToast />
      </MemoryRouter>
    );
    expect(() =>
      fire({
        title: { x: 1 },
        milestoneName: 7,
        description: ['a'],
        icon: {},
        reward: [1],
        rewardText: 3,
      })
    ).not.toThrow();
    expect(screen.getByText('Milestone Unlocked!')).toBeTruthy();
    expect(screen.getByText('You Reached A New Milestone!')).toBeTruthy();
    expect(screen.queryByText(/Reward:/)).toBeNull();
  });

  it('diamonds the server credited still show, Title Case, no em dash', () => {
    render(
      <MemoryRouter>
        <MilestoneToast />
      </MemoryRouter>
    );
    fire({
      milestoneName: 'monthly grinder',
      description: 'log in 30 days — in a row',
      rewardDiamonds: 100,
    });
    expect(screen.getByText('Monthly Grinder')).toBeTruthy();
    expect(screen.getByText('Log In 30 Days. In A Row')).toBeTruthy();
    expect(screen.getByText('+100 Diamonds')).toBeTruthy();
  });
});
