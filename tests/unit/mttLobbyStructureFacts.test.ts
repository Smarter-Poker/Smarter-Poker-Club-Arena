import { describe, expect, it } from 'vitest';
import {
  tournamentEntry,
  stackDepthBB,
  stackDepthLabel,
  stackFormatRank,
  levelSpeedLabel,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

const row = (overrides: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow => ({
  id: 'mtt-structure',
  name: 'Deep Stack Turbo Hyper Satellite',
  game_type: 'NLH',
  buy_in_amount: 10,
  buy_in_fee: 1,
  guaranteed_prize: 0,
  start_time: '',
  status: 'REGISTERING',
  current_players: 0,
  max_players: 0,
  starting_chips: 1000,
  ...overrides,
});

describe('the main MTT board uses actual clocks and independent depth', () => {
  it.each([
    { minutes: 2, chips: 1000, label: 'Hyper Turbo', rank: 1, key: 'hyper', depth: 50 },
    { minutes: 3, chips: 30000, label: 'Turbo', rank: 2, key: 'turbo', depth: 1500 },
    { minutes: 10, chips: 100, label: 'Regular', rank: 3, key: null, depth: 5 },
    { minutes: 15, chips: 1000, label: 'Slow', rank: 4, key: 'slow', depth: 50 },
  ])(
    'uses $label for display, sort and medallions despite the name',
    ({ minutes, chips, label, rank, key, depth }) => {
      const raw = row({
        starting_chips: chips,
        blind_structure: JSON.stringify([{ duration: minutes * 60, bigBlind: 20 }]),
      });
      const before = JSON.stringify(raw);
      const entry = tournamentEntry(raw, 'mtt');
      expect(entry.speedLabel).toBe(label);
      expect(stackDepthLabel(entry)).toBe(label);
      expect(stackFormatRank(entry)).toBe(rank);
      expect(stackDepthBB(entry)).toBe(depth);
      expect(levelSpeedLabel(raw)).toBe(`${minutes} Min`);
      expect(
        entry.rules
          .filter((r) => ['hyper', 'turbo', 'slow', 'deepstack'].includes(r.key))
          .map((r) => r.key)
      ).toEqual(key ? [key] : []);
      expect(JSON.stringify(raw)).toBe(before);
    }
  );

  it('does not infer speed from a name or known depth when its clock is absent', () => {
    const entry = tournamentEntry(
      row({ blind_structure: JSON.stringify([{ bigBlind: 20 }]) }),
      'mtt'
    );
    expect(entry.speedLabel).toBeNull();
    expect(stackDepthLabel(entry)).toBeNull();
    expect(stackFormatRank(entry)).toBe(Infinity);
    expect(stackDepthBB(entry)).toBe(50);
    expect(entry.rules.some((r) => ['hyper', 'turbo', 'deepstack'].includes(r.key))).toBe(false);
  });

  it('skips a leading break consistently for the board clock and depth', () => {
    const raw = row({
      blind_structure: JSON.stringify([
        { level: 1, isBreak: true, durationMinutes: 5, bigBlind: 0 },
        { level: 2, durationMinutes: 12, bigBlind: 50 },
      ]),
    });
    const entry = tournamentEntry(raw, 'mtt');
    expect(entry.speedLabel).toBe('Slow');
    expect(levelSpeedLabel(raw)).toBe('12 Min');
    expect(stackDepthBB(entry)).toBe(20);
  });
});
