import { describe, expect, it } from 'vitest';
import {
  classifyTournament,
  isSeatFirstTournament,
  tournamentEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { tournamentVariant } from '../../src/utils/tournamentFilters';
import { rakeRateFor } from '../../src/utils/buyIn';
import { gameCode } from '../../src/utils/gameCode';

const row: LobbyTournamentRow = {
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

  it.each([null, 0, 2, 300, 1000000])('recognizes the MTT variant with old cap %s', (max_players) => {
    const input = { ...row, variant: 'freezeout', max_players };
    expect(classifyTournament(input)).toBe('mtt');
    expect(tournamentVariant(input)).toBe('MTT');
    expect(isSeatFirstTournament(input)).toBe(false);
    expect(tournamentEntry(input, 'mtt').capacity).toBe(0);
  });

  it('a known MTT adapter never publishes a field denominator from an old partial row', () => {
    expect(tournamentEntry(row, 'mtt').capacity).toBe(0);
  });

  it.each(['satellite_target_id', 'satellite_target'])(
    'recognizes a linked satellite through %s when its old type is SNG', (targetKey) => {
    const input = { ...row, tournament_type: 'SNG', variant: 'sng', [targetKey]: 'target' };
    expect(classifyTournament(input)).toBe('mtt');
    expect(tournamentVariant(input)).toBe('MTT');
    expect(isSeatFirstTournament(input)).toBe(false);
    expect(tournamentEntry(input, 'mtt').capacity).toBe(0);
  });

  it.each([
    { tournament_type: 'SNG', variant: 'sng', max_players: 2, kind: 'sng' as const },
    { tournament_type: 'SPIN', variant: 'spin', max_players: 3, kind: 'spin' as const },
  ])('preserves fixed $tournament_type field seats', ({ kind, ...format }) => {
    const input = { ...row, ...format, current_players: 1 };
    expect(classifyTournament(input)).toBe(kind);
    expect(isSeatFirstTournament(input)).toBe(true);
    expect(tournamentEntry(input, kind).capacity).toBe(format.max_players);
  });

  it('keeps a physical two-seat cash table distinct from an MTT', () => {
    expect(gameCode({ variant: 'NLH', maxPlayers: 2 })).toBe('HU');
    expect(gameCode({ isTournament: true, tournamentFormat: 'mtt', maxPlayers: 2 })).toBe('MTT');
  });
});
