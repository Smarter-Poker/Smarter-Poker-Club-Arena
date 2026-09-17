import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NormalisedBlindLevel,
  TournamentTabProps,
} from '../../src/components/tournament/details/types';

vi.mock('../../src/components/tournament/details/useSatellites', () => ({
  useSatellites: () => ({
    cards: [],
    registration: {},
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    getCurrentLevelState: () => ({
      levelIndex: 0,
      currentLevel: null,
      nextLevel: null,
      timeRemainingSeconds: 0,
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/MysteryBountyService', () => ({
  activationStatusLine: () => '',
  formatCents: String,
  topBountyCents: () => 0,
}));
vi.mock('../../src/components/tournament/RegistrationApprovalsPanel', () => ({
  default: () => null,
}));
vi.mock('../../src/components/tournament/TournamentDealReview', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/TournamentLobbyCard', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/HandForHandBanner', () => ({
  HandForHandBanner: () => null,
}));

import DetailOverviewTab from '../../src/components/tournament/details/DetailOverviewTab';

afterEach(cleanup);
const level = (duration: number, bigBlind = 50, isBreak = false): NormalisedBlindLevel => ({
  level: 1,
  smallBlind: bigBlind / 2,
  bigBlind,
  ante: 0,
  duration,
  isBreak,
});
function props(startingChips: number, blindLevels: NormalisedBlindLevel[]): TournamentTabProps {
  return {
    tournament: Object.freeze({
      id: 'structure-event',
      name: 'Structure Event',
      status: 'ANNOUNCED',
      game_type: 'nlh',
      table_size: 9,
      starting_chips: startingChips,
      current_players: 0,
      blind_structure: blindLevels.map((b) => ({ ...b, duration: b.duration * 60 })),
    }) as unknown as TournamentTabProps['tournament'],
    entries: [],
    tables: [],
    blindLevels,
    isRegistered: false,
  };
}
const value = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent;

describe('Overview displays engine structure facts without changing tournament rules', () => {
  it.each([
    { minutes: 2, bb: 100, stack: 5000, speed: 'Hyper Turbo', depth: '50 BB' },
    { minutes: 15, bb: 50, stack: 1000, speed: 'Slow', depth: '20 BB' },
    { minutes: 10, bb: 50, stack: 30000, speed: 'Regular', depth: '600 BB' },
    { minutes: 3, bb: 20, stack: 1000, speed: 'Turbo', depth: '50 BB' },
  ])('shows $speed and $depth independently', ({ minutes, bb, stack, speed, depth }) => {
    const input = props(stack, [level(minutes, bb)]);
    const original = JSON.stringify(input);
    render(<DetailOverviewTab {...input} />);
    expect(value('Structure')).toBe(speed);
    expect(value('Starting Stack')).toContain(depth);
    expect(value('Levels')).toBe(`${minutes} Min`);
    expect(screen.queryByText('Deep Stack')).toBeNull();
    expect(JSON.stringify(input)).toBe(original);
  });

  it('skips leading breaks and displays the full taper with its opening clock', () => {
    render(<DetailOverviewTab {...props(10000, [level(5, 0, true), level(10), level(5, 100)])} />);
    expect(value('Structure')).toBe('Regular');
    expect(value('Starting Stack')).toBe('10,000 · 200 BB');
    expect(value('Levels')).toBe('10 Min Opening · 5-10 Min Range');
  });

  it('keeps unknown opening clock and depth unconfirmed', () => {
    render(<DetailOverviewTab {...props(1000, [level(0, 0), level(10, 100)])} />);
    expect(value('Structure')).toBe('Unconfirmed');
    expect(value('Levels')).toBe('Unconfirmed');
    expect(value('Starting Stack')).toBe('1,000');
  });

  it('does not advertise a fixed clock when a later level lacks duration', () => {
    render(<DetailOverviewTab {...props(10000, [level(10), level(0, 100)])} />);
    expect(value('Levels')).toBe('10 Min Opening');
  });

  it('updates facts directly with new server-provided configuration', () => {
    const first = props(1000, [level(15)]);
    const next = props(30000, [level(2, 100)]);
    const originals = [JSON.stringify(first), JSON.stringify(next)];
    const rendered = render(<DetailOverviewTab {...first} />);
    expect(value('Structure')).toBe('Slow');
    rendered.rerender(<DetailOverviewTab {...next} />);
    expect(value('Structure')).toBe('Hyper Turbo');
    expect(value('Starting Stack')).toBe('30,000 · 300 BB');
    expect([JSON.stringify(first), JSON.stringify(next)]).toEqual(originals);
  });
});
