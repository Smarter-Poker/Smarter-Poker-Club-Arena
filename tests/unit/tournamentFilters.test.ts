/**
 * REGRESSION (2026-08-19): "none of the tournament filters work".
 *
 * The fixtures below mirror the REAL shape of production rows at the time of
 * the report: every live tournament sat in REGISTERING with a start_time
 * already in the past (they start on fill, not on the clock), and no
 * tournament has ever carried a LATE_REG status. Those two facts made the
 * "Starting Soon" and "Late Reg" tabs permanently empty.
 */
import { describe, it, expect } from 'vitest';
import {
  matchesTournamentSubFilter,
  matchesVariant,
  tournamentVariant,
  isInLateRegistration,
  type FilterableTournament,
} from '../../src/utils/tournamentFilters';

const NOW = new Date('2026-08-19T02:10:00Z').getTime();

const mk = (over: Partial<FilterableTournament>): FilterableTournament => ({
  name: 'Midnight Bounty (NLH)',
  status: 'REGISTERING',
  start_time: '2026-08-19T02:05:00Z',
  max_players: 50,
  ...over,
});

// Shapes taken from the live lobby (start times ALREADY PAST while registering).
const SPIN_OVERDUE = mk({
  name: '1 Chip Spin NLH (2x)',
  max_players: 3,
  start_time: '2026-08-19T01:44:02Z',
});
const SNG_OVERDUE = mk({
  name: '5 Chip Turbo SNG 6-Max NLH',
  max_players: 6,
  start_time: '2026-08-19T02:03:11Z',
});
const MTT_RUNNING = mk({
  name: 'Midnight Bounty (NLH)',
  status: 'RUNNING',
  max_players: 50,
  start_time: '2026-08-19T02:03:11Z',
  started_at: '2026-08-19T02:03:11Z',
  late_reg_mins: 30,
  late_reg_levels: 6,
  current_level: 2,
});

describe('tournament variant classification', () => {
  it('classifies the real lobby rows', () => {
    expect(tournamentVariant(SPIN_OVERDUE)).toBe('Spin-It');
    expect(tournamentVariant(SNG_OVERDUE)).toBe('SN');
    expect(tournamentVariant(MTT_RUNNING)).toBe('MTT');
  });

  it('does not misfile a Spin as an SNG just because it is 3-max', () => {
    expect(matchesVariant(SPIN_OVERDUE, 'SN')).toBe(false);
    expect(matchesVariant(SPIN_OVERDUE, 'Spin-It')).toBe(true);
  });

  it('ALL matches everything', () => {
    for (const t of [SPIN_OVERDUE, SNG_OVERDUE, MTT_RUNNING]) {
      expect(matchesVariant(t, 'ALL')).toBe(true);
    }
  });
});

describe('STARTING SOON', () => {
  it('includes a tournament that is overdue but still registering', () => {
    // THE BUG: the old rule required minutesUntilStart > 0. Every live
    // tournament was overdue, so this tab rendered an empty list.
    expect(matchesTournamentSubFilter(SNG_OVERDUE, 'starting_soon', NOW)).toBe(true);
    expect(matchesTournamentSubFilter(SPIN_OVERDUE, 'starting_soon', NOW)).toBe(true);
  });

  it('includes one starting within the hour', () => {
    const t = mk({ start_time: new Date(NOW + 30 * 60000).toISOString() });
    expect(matchesTournamentSubFilter(t, 'starting_soon', NOW)).toBe(true);
  });

  it('excludes one more than an hour out', () => {
    const t = mk({ start_time: new Date(NOW + 90 * 60000).toISOString() });
    expect(matchesTournamentSubFilter(t, 'starting_soon', NOW)).toBe(false);
  });

  it('excludes anything not open for registration', () => {
    expect(matchesTournamentSubFilter(MTT_RUNNING, 'starting_soon', NOW)).toBe(false);
    expect(matchesTournamentSubFilter(mk({ status: 'COMPLETED' }), 'starting_soon', NOW)).toBe(
      false
    );
  });
});

describe('LATE REG', () => {
  it('includes a running tournament inside its late-reg minutes', () => {
    // THE BUG: the old rule looked for status === 'LATE_REG', which this
    // platform never writes, so the tab was always empty.
    expect(isInLateRegistration(MTT_RUNNING, NOW)).toBe(true);
    expect(matchesTournamentSubFilter(MTT_RUNNING, 'late_reg', NOW)).toBe(true);
  });

  it('excludes a running tournament past both windows', () => {
    const late = mk({
      status: 'RUNNING',
      started_at: '2026-08-19T00:00:00Z',
      late_reg_mins: 30,
      late_reg_levels: 6,
      current_level: 12,
    });
    expect(matchesTournamentSubFilter(late, 'late_reg', NOW)).toBe(false);
  });

  it('still honours an explicit LATE_REG status if one ever appears', () => {
    expect(
      matchesTournamentSubFilter(
        mk({ status: 'LATE_REG', late_reg_levels: 3, current_level: 1 }),
        'late_reg',
        NOW
      )
    ).toBe(true);
  });

  it('excludes tournaments that have not started', () => {
    expect(matchesTournamentSubFilter(SNG_OVERDUE, 'late_reg', NOW)).toBe(false);
  });

  it('uses levels when no minute window is configured', () => {
    const byLevel = mk({
      status: 'RUNNING',
      late_reg_mins: 0,
      late_reg_levels: 6,
      current_level: 3,
    });
    expect(matchesTournamentSubFilter(byLevel, 'late_reg', NOW)).toBe(true);
  });
});

describe('RUNNING / REGISTERING / ALL', () => {
  it('running matches RUNNING and IN_PROGRESS only', () => {
    expect(matchesTournamentSubFilter(MTT_RUNNING, 'running', NOW)).toBe(true);
    expect(matchesTournamentSubFilter(SNG_OVERDUE, 'running', NOW)).toBe(false);
    expect(matchesTournamentSubFilter(mk({ status: 'IN_PROGRESS' }), 'running', NOW)).toBe(true);
  });

  it('registering matches the open states', () => {
    expect(matchesTournamentSubFilter(SNG_OVERDUE, 'registering', NOW)).toBe(true);
    expect(matchesTournamentSubFilter(MTT_RUNNING, 'registering', NOW)).toBe(false);
    for (const s of ['OPEN', 'PENDING', 'registering']) {
      expect(matchesTournamentSubFilter(mk({ status: s }), 'registering', NOW)).toBe(true);
    }
  });

  it('all matches everything', () => {
    for (const t of [SPIN_OVERDUE, SNG_OVERDUE, MTT_RUNNING]) {
      expect(matchesTournamentSubFilter(t, 'all', NOW)).toBe(true);
    }
  });

  it('every live row lands in at least one status tab', () => {
    for (const t of [SPIN_OVERDUE, SNG_OVERDUE, MTT_RUNNING]) {
      const tabs = (['running', 'registering', 'late_reg', 'starting_soon'] as const).filter((f) =>
        matchesTournamentSubFilter(t, f, NOW)
      );
      expect(tabs.length).toBeGreaterThan(0);
    }
  });
});
