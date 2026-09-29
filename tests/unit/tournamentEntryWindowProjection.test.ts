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
  /* Replaced 2026-09-26 with fn_tournament_late_registration_open
     (20260926035534). This pin used to read "keeps a level window open through
     a long break until the engine advances it": the level cap won and the
     configured minutes were ignored, which is how Sunday Funday Six-Card Closer
     (9 levels / 90 minutes) still advertised late registration at level 3 five
     days after it started. The clock is wall time by design (the platform thaw
     never shifts started_at + late_reg_mins), so whichever deadline passes
     first now closes the window. */
  it('closes a level window at its clock deadline when the level clock has not advanced', () => {
    expect(isInLateRegistration(row({ late_reg_mins: 1 }), now + 3600000)).toBe(false);
    const closer = row({
      started_at: '2026-09-09T10:00:00Z',
      late_reg_levels: 9,
      late_reg_mins: 90,
      current_level: 3,
    });
    expect(isInLateRegistration(closer, now)).toBe(false);
  });
  it('admits while both the level and the clock window are open', () => {
    expect(isInLateRegistration(row({ late_reg_levels: 9, late_reg_mins: 90 }), now)).toBe(true);
  });
  it('still closes at the level cap while the clock is open', () => {
    expect(
      isInLateRegistration(row({ late_reg_levels: 9, late_reg_mins: 90, current_level: 9 }), now)
    ).toBe(false);
  });
  it('closes at the exact clock deadline of a level window', () => {
    const r = row({ late_reg_levels: 9, late_reg_mins: 30, current_level: 0 });
    expect(isInLateRegistration(r, now - 1)).toBe(true);
    expect(isInLateRegistration(r, now)).toBe(false);
  });
  it('estimates the clock deadline when it comes before the level window ends', () => {
    // Levels would end at 10:33; the 31-minute clock ends at 10:31.
    expect(lateRegEndMs(row({ late_reg_mins: 31 }) as LobbyTournamentRow)).toBe(now + 60000);
  });
});
