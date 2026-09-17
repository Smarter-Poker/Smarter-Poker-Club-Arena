import { describe, expect, it } from 'vitest';
import {
  isPersistedTournamentEntryFull,
  isPersistedUnlimitedMtt,
  isTournamentEntryFull,
  isUnlimitedMtt,
  normalizePersistedTournamentMaxPlayers,
  normalizeTournamentMaxPlayers,
  readPersistedTournamentFormatContract,
} from './tournamentEntryCapacity.js';

describe('MTT entry fields have no maximum', () => {
  it.each([
    'MTT',
    'XMTT',
    'SATELLITE',
    'freezeout',
    'bounty',
    'progressive',
    'progressive_bounty',
    'pko',
    'mystery',
    'mystery_bounty',
    'rebuy',
    'reentry',
    'mtt_freezeout',
    'mtt_free_buy',
    'mtt_rebuy',
    'mtt_reentry',
  ])('%s ignores every historical numeric cap', (type) => {
    for (const maxPlayers of [null, 2, 100, 10000]) {
      const row = { type, maxPlayers };
      expect(isUnlimitedMtt(row)).toBe(true);
      expect(normalizeTournamentMaxPlayers(row)).toBeNull();
      expect(isTournamentEntryFull(row, 10001)).toBe(false);
    }
  });
  it('treats an old two-seat SNG-shaped satellite as an unlimited satellite', () => {
    const row = { tournament_type: 'SATELLITE', variant: 'sng', max_players: 2 };
    expect(isUnlimitedMtt(row)).toBe(true);
    expect(normalizeTournamentMaxPlayers(row)).toBeNull();
    expect(isTournamentEntryFull(row, 2)).toBe(false);
  });
  it.each([
    { satellite_target_id: 'target' },
    { satelliteTargetId: 'target' },
    { satellite_target: 'target' },
    { satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 } },
  ])('recognizes linked satellites before old fixed labels (%j)', (target) => {
    expect(isUnlimitedMtt({ type: 'SPIN', variant: 'spin', maxPlayers: 3, ...target })).toBe(true);
  });
  it.each([null, '', '   ', {}, { seatsAwarded: 1 }, { tournamentId: '' }])(
    'does not invent a satellite target from %j',
    (satelliteTarget) => {
      expect(isUnlimitedMtt({ type: 'SNG', maxPlayers: 2, satelliteTarget })).toBe(false);
    }
  );
  it('recognizes a historical MTT variant when its type was absent', () => {
    expect(isUnlimitedMtt({ tournament_type: null, variant: 'mtt', max_players: 2 })).toBe(true);
  });
  it.each([
    ['SNG', 2],
    ['SNG', 6],
    ['SPIN', 3],
  ] as const)('%s keeps its %i-seat field', (type, maxPlayers) => {
    const row = { type, maxPlayers };
    expect(isUnlimitedMtt(row)).toBe(false);
    expect(normalizeTournamentMaxPlayers(row)).toBe(maxPlayers);
    expect(isTournamentEntryFull(row, maxPlayers - 1)).toBe(false);
    expect(isTournamentEntryFull(row, maxPlayers)).toBe(true);
  });
  it('does not classify unknown shapes or physical table capacity as unlimited MTTs', () => {
    expect(isUnlimitedMtt({ max_players: 9 })).toBe(false);
    expect(isUnlimitedMtt({ type: 'unknown', max_players: null })).toBe(false);
    expect(isTournamentEntryFull({ type: 'SNG', max_players: null }, 0)).toBe(true);
  });
});

describe('recorded tournament formats preserve purchased fields', () => {
  it.each(['mtt-v1', 'mtt-v2', 'seat-first-satellite-v1', 'sng-v1', 'spin-v1'])(
    'reads the exact persisted %s contract',
    (format_contract) => {
      expect(readPersistedTournamentFormatContract({ format_contract })).toBe(format_contract);
    }
  );

  it.each([
    undefined,
    null,
    '',
    'MTT-V2',
    ' mtt-v2',
    'mtt-v2 ',
    'mtt-v3',
    'legacy-capacity-v1',
    'unlimited-mtt-v2',
    2,
    true,
    ['mtt-v2'],
    { value: 'mtt-v2' },
  ])(
    'refuses an absent or unknown marker %j in every persisted entry helper',
    (format_contract) => {
      const row = { format_contract, tournament_type: 'MTT', max_players: null };
      expect(() => readPersistedTournamentFormatContract(row)).toThrow(
        'TOURNAMENT_FORMAT_CONTRACT_INVALID'
      );
      expect(() => isPersistedUnlimitedMtt(row)).toThrow('TOURNAMENT_FORMAT_CONTRACT_INVALID');
      expect(() => normalizePersistedTournamentMaxPlayers(row)).toThrow(
        'TOURNAMENT_FORMAT_CONTRACT_INVALID'
      );
      expect(() => isPersistedTournamentEntryFull(row, 0)).toThrow(
        'TOURNAMENT_FORMAT_CONTRACT_INVALID'
      );
    }
  );

  it.each([undefined, null, 'mtt-v2', [], {}, { formatContract: 'mtt-v2' }])(
    'does not infer a persisted contract from an invalid row %j',
    (row) => {
      expect(() => readPersistedTournamentFormatContract(row)).toThrow(
        'TOURNAMENT_FORMAT_CONTRACT_INVALID'
      );
    }
  );

  it('requires a projected marker rather than an inherited property', () => {
    const row = Object.assign(Object.create({ format_contract: 'mtt-v2' }), { max_players: 2 });
    expect(() => readPersistedTournamentFormatContract(row)).toThrow(
      'TOURNAMENT_FORMAT_CONTRACT_INVALID'
    );
  });

  it.each(['mtt-v1', 'mtt-v2'])(
    '%s ignores stored numeric caps and stale fixed-format labels',
    (format_contract) => {
      for (const max_players of [null, 2, 100, 10000]) {
        const row = { format_contract, tournament_type: 'SNG', variant: 'sng', max_players };
        expect(isPersistedUnlimitedMtt(row)).toBe(true);
        expect(normalizePersistedTournamentMaxPlayers(row)).toBeNull();
        expect(isPersistedTournamentEntryFull(row, 10001)).toBe(false);
      }
    }
  );

  it.each([
    ['seat-first-satellite-v1', 2],
    ['sng-v1', 2],
    ['sng-v1', 6],
    ['spin-v1', 3],
  ] as const)(
    '%s retains its purchased %i-place field despite target and label heuristics',
    (format_contract, max_players) => {
      const row = {
        format_contract,
        tournament_type: 'SATELLITE',
        variant: 'mtt',
        satellite_target_id: 'upstream',
        max_players,
      };
      expect(isPersistedUnlimitedMtt(row)).toBe(false);
      expect(normalizePersistedTournamentMaxPlayers(row)).toBe(max_players);
      expect(isPersistedTournamentEntryFull(row, max_players - 1)).toBe(false);
      expect(isPersistedTournamentEntryFull(row, max_players)).toBe(true);
    }
  );

  it('does not let a raw creator forge either a legacy exception or unlimited fixed-field entry', () => {
    const satellite = {
      type: 'SNG',
      maxPlayers: 2,
      satelliteTargetId: 'upstream',
      format_contract: 'seat-first-satellite-v1',
    };
    expect(isUnlimitedMtt(satellite)).toBe(true);
    expect(normalizeTournamentMaxPlayers(satellite)).toBeNull();
    expect(isTournamentEntryFull(satellite, 2)).toBe(false);

    const sng = { type: 'SNG', maxPlayers: 2, format_contract: 'mtt-v2' };
    expect(isUnlimitedMtt(sng)).toBe(false);
    expect(normalizeTournamentMaxPlayers(sng)).toBe(2);
    expect(isTournamentEntryFull(sng, 2)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    0,
    -2,
    2.5,
    NaN,
    Infinity,
    true,
    [2],
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ])('refuses additional fixed-field entry for unknown or invalid capacity %j', (max_players) => {
    const row = { format_contract: 'seat-first-satellite-v1', max_players };
    expect(normalizePersistedTournamentMaxPlayers(row)).toBeNull();
    expect(isPersistedTournamentEntryFull(row, 0)).toBe(true);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses additional fixed-field entry with invalid entrant count %j',
    (entrants) => {
      expect(
        isPersistedTournamentEntryFull({ format_contract: 'sng-v1', max_players: 6 }, entrants)
      ).toBe(true);
    }
  );

  it('keeps mapped fixed capacities without letting a stale alias override canonical NULL', () => {
    expect(
      normalizePersistedTournamentMaxPlayers({ format_contract: 'sng-v1', maxPlayers: 6 })
    ).toBe(6);
    expect(
      normalizePersistedTournamentMaxPlayers({ format_contract: 'sng-v1', max_players: '6' })
    ).toBe(6);
    const row = { format_contract: 'sng-v1', max_players: null, maxPlayers: 6 };
    expect(normalizePersistedTournamentMaxPlayers(row)).toBeNull();
    expect(isPersistedTournamentEntryFull(row, 0)).toBe(true);
  });

  it('normalizes the projection without rewriting funded row data', () => {
    const row = Object.freeze({ format_contract: 'mtt-v1', max_players: 100 });
    expect(normalizePersistedTournamentMaxPlayers(row)).toBeNull();
    expect(row.max_players).toBe(100);
  });
});
