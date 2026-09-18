import { describe, expect, it } from 'vitest';
import {
  classifyTournament,
  isSeatFirstTournament,
  tournamentEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { tournamentVariant } from '../../src/utils/tournamentFilters';
import { rakeRateFor } from '../../src/utils/buyIn';
import {
  readTournamentFormat,
  isTournamentEntryUnavailable,
  getTournamentEntryCapacity,
} from '../../src/utils/tournamentPresentation';
import { gameCode } from '../../src/utils/gameCode';

const row: LobbyTournamentRow = {
  format_contract: 'mtt-v2',
  id: 'unlimited-event',
  name: 'Evening Tournament',
  game_type: 'NLH',
  buy_in_amount: 9,
  buy_in_fee: 1,
  guaranteed_prize: 0,
  start_time: '2099-01-01T00:00:00Z',
  status: 'REGISTERING',
  current_players: 1000001,
  max_players: 2,
  starting_chips: 3000,
};

describe('unlimited MTT lobby admission and presentation', () => {
  it.each(['MTT', 'SATELLITE', 'XMTT'])('%s ignores a stale two-seat Spin projection', (type) => {
    const input = Object.freeze({ ...row, tournament_type: type, variant: 'spin' });
    expect(classifyTournament(input)).toBe('mtt');
    expect(tournamentVariant(input)).toBe('MTT');
    expect(isSeatFirstTournament(input)).toBe(false);
    const entry = tournamentEntry(input, classifyTournament(input));
    expect(entry.kind).toBe('mtt');
    expect(entry.capacity).toBe(0);
    expect(entry.players).toBe(1000001);
    expect(entry.status).not.toBe('full');
    expect(entry.status).not.toBe('running');
    expect(input.max_players).toBe(2);
    expect(rakeRateFor({ tournamentType: type, variant: 'spin', maxPlayers: 2 })).toBe(0.1);
  });

  it.each([null, 0, 2, 300, 1000000])(
    'recognizes the MTT variant with old cap %s',
    (max_players) => {
      const input = { ...row, variant: 'freezeout', max_players };
      expect(classifyTournament(input)).toBe('mtt');
      expect(tournamentVariant(input)).toBe('MTT');
      expect(isSeatFirstTournament(input)).toBe(false);
      expect(tournamentEntry(input, 'mtt').capacity).toBe(0);
    }
  );

  it('a known MTT adapter never publishes a field denominator from an old partial row', () => {
    expect(tournamentEntry(row, 'mtt').capacity).toBe(0);
  });

  it.each(['satellite_target_id', 'satellite_target'])(
    'recognizes a linked satellite through %s when its old type is SNG',
    (targetKey) => {
      const input = { ...row, tournament_type: 'SNG', variant: 'sng', [targetKey]: 'target' };
      expect(classifyTournament(input)).toBe('mtt');
      expect(tournamentVariant(input)).toBe('MTT');
      expect(isSeatFirstTournament(input)).toBe(false);
      expect(tournamentEntry(input, 'mtt').capacity).toBe(0);
    }
  );

  it.each([
    {
      format_contract: 'sng-v1',
      tournament_type: 'SNG',
      variant: 'sng',
      max_players: 2,
      kind: 'sng' as const,
    },
    {
      format_contract: 'spin-v1',
      tournament_type: 'SPIN',
      variant: 'spin',
      max_players: 3,
      kind: 'spin' as const,
    },
  ])('preserves fixed $tournament_type field seats', ({ kind, ...format }) => {
    const input = { ...row, ...format, current_players: 1 };
    expect(classifyTournament(input)).toBe(kind);
    expect(isSeatFirstTournament(input)).toBe(true);
    expect(tournamentEntry(input, kind).capacity).toBe(format.max_players);
  });

  it.each(['mtt-v1', 'mtt-v2'])(
    'uses the persisted %s format despite contradictory labels',
    (format_contract) => {
      const input = {
        ...row,
        format_contract,
        tournament_type: 'SPIN',
        variant: 'spin',
        max_players: 2,
      };
      expect(classifyTournament(input)).toBe('mtt');
      expect(isTournamentEntryUnavailable(input, 1000001)).toBe(false);
    }
  );

  it('retains the funded legacy satellite seat contract despite its target', () => {
    const input = {
      ...row,
      format_contract: 'seat-first-satellite-v1',
      tournament_type: 'SATELLITE',
      satellite_target_id: 'target',
      max_players: 2,
      current_players: 1,
    };
    expect(classifyTournament(input)).toBe('sng');
    expect(isSeatFirstTournament(input)).toBe(true);
    expect(getTournamentEntryCapacity(input)).toBe(2);
    expect(isTournamentEntryUnavailable(input, 1)).toBe(false);
    expect(isTournamentEntryUnavailable(input, 2)).toBe(true);
  });

  it.each([1, 2, 9])(
    'offers ordinary SNG seat-first entry only for the exact HU capacity: %i',
    (max_players) => {
      const input = {
        ...row,
        format_contract: 'sng-v1',
        max_players,
        current_players: 0,
      };
      expect(isSeatFirstTournament(input)).toBe(max_players === 2);
    }
  );

  it.each([undefined, null, '', 'MTT-V2', 'mtt-v3', {}, 2])(
    'refuses unknown format %s without guessing from a target or cap',
    (format_contract) => {
      const input = {
        ...row,
        format_contract,
        tournament_type: 'MTT',
        satellite_target_id: 'target',
      };
      expect(readTournamentFormat(input)).toBeNull();
      expect(classifyTournament(input)).toBe('unknown');
      expect(tournamentVariant(input)).toBe('Unknown');
      expect(isSeatFirstTournament(input)).toBe(false);
      expect(getTournamentEntryCapacity(input)).toBeNull();
      expect(isTournamentEntryUnavailable(input, 1)).toBe(true);
      const entry = tournamentEntry(input, classifyTournament(input));
      expect(entry.statusLabel).toBe('Entry Unavailable');
      expect(entry.speedLabel).toBeNull();
      const namedTurbo = tournamentEntry({ ...input, name: 'Morning Turbo' }, 'unknown');
      expect(namedTurbo.speedLabel).toBeNull();
      expect(
        namedTurbo.rules.some((rule) => ['turbo', 'hyper', 'slow', 'deepstack'].includes(rule.key))
      ).toBe(false);
      expect(entry.players).toBe(1000001);
    }
  );

  it('rejects inherited or camel-case format markers', () => {
    expect(readTournamentFormat(Object.create({ format_contract: 'mtt-v2' }))).toBeNull();
    expect(readTournamentFormat({ formatContract: 'mtt-v2' })).toBeNull();
  });

  it.each(['COMPLETING', 'COMPLETED', 'CANCELLED'])(
    'keeps %s history viewable without admission',
    (status) => {
      for (const format_contract of [null, 'mtt-v2']) {
        const input = { ...row, format_contract, status };
        expect(isTournamentEntryUnavailable(input, 1)).toBe(true);
        expect(tournamentEntry(input, classifyTournament(input)).players).toBe(1000001);
      }
    }
  );

  it('keeps a physical two-seat cash table distinct from an MTT', () => {
    expect(gameCode({ variant: 'NLH', maxPlayers: 2 })).toBe('HU');
    expect(gameCode({ isTournament: true, tournamentFormat: 'mtt', maxPlayers: 2 })).toBe('MTT');
  });
});
