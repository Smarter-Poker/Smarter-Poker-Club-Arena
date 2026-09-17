import { describe, expect, it } from 'vitest';
import { isInLateRegistration } from '../../src/utils/tournamentFilters';
import { lateRegEndMs } from '../../src/components/lobby/lateRegWindow';
import { tournamentStatus, type LobbyTournamentRow } from '../../src/components/lobby/lobbyEntries';

const now = Date.parse('2026-09-14T10:30:00Z');
const row = (changes: Record<string, unknown> = {}) => ({
  id: 'window',
  name: 'Window contract',
  game_type: 'NLH',
  status: 'RUNNING',
  buy_in_amount: 10,
  buy_in_fee: 1,
  guaranteed_prize: 0,
  starting_chips: 10000,
  start_time: '2026-09-14T10:00:00Z',
  started_at: '2026-09-14T10:00:00Z',
  current_players: 10,
  max_players: 100,
  current_level: 2,
  late_reg_levels: 3,
  late_reg_mins: 60,
  rebuy_levels: 8,
  prize_pool_finalized: false,
  level_started_at: '2026-09-14T10:28:00Z',
  blind_structure: JSON.stringify([
    { durationMinutes: 5 },
    { durationMinutes: 5 },
    { durationMinutes: 5 },
  ]),
  ...changes,
});

describe('client projection of the existing engine entry window', () => {
  it('does not reopen the closed level window with a longer minutes setting', () => {
    expect(isInLateRegistration(row({ current_level: 3 }), now)).toBe(false);
  });
  it('does not advertise entry after pool finalization', () => {
    expect(isInLateRegistration(row({ prize_pool_finalized: true }), now)).toBe(false);
    expect(tournamentStatus(row({ prize_pool_finalized: true }) as LobbyTournamentRow).key).toBe(
      'running'
    );
  });
  it('uses the legacy rebuy-level fallback only when late levels are null', () => {
    expect(isInLateRegistration(row({ late_reg_levels: null, late_reg_mins: 0 }), now)).toBe(true);
    expect(isInLateRegistration(row({ late_reg_levels: 0, late_reg_mins: 0 }), now)).toBe(false);
  });
  it('closes the minute window at the exact deadline', () => {
    expect(isInLateRegistration(row({ late_reg_levels: 0, late_reg_mins: 30 }), now - 1)).toBe(
      true
    );
    expect(isInLateRegistration(row({ late_reg_levels: 0, late_reg_mins: 30 }), now)).toBe(false);
  });
  it('never substitutes a scheduled start for an unconfirmed actual start', () => {
    expect(isInLateRegistration(row({ late_reg_levels: 0, started_at: null }), now)).toBe(false);
  });
  it.each(['current_level', 'late_reg_levels', 'rebuy_levels', 'late_reg_mins'])(
    'refuses negative %s like the server predicate',
    (field) => {
      expect(isInLateRegistration(row({ [field]: -1 }), now)).toBe(false);
    }
  );
  it('estimates only the selected level window even when minutes would last longer', () => {
    expect(lateRegEndMs(row() as LobbyTournamentRow)).toBe(now + 3 * 60000);
  });
  it('cannot recover a missing level clock from an unrelated minutes window', () => {
    expect(lateRegEndMs(row({ level_started_at: null }) as LobbyTournamentRow)).toBeNull();
    expect(lateRegEndMs(row({ blind_structure: 'broken' }) as LobbyTournamentRow)).toBeNull();
  });
  it('does not publish a close deadline for a finalized pool', () => {
    expect(lateRegEndMs(row({ prize_pool_finalized: true }) as LobbyTournamentRow)).toBeNull();
  });
  it('keeps a level window open through a long break until the engine advances it', () => {
    expect(isInLateRegistration(row({ late_reg_mins: 1 }), now + 3600000)).toBe(true);
  });
});
