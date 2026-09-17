import { readFileSync } from 'node:fs';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { validateMttBlindStructure } from '../domain/tournamentBlindContract.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';

const level = { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 4 };
const invalid = [
  [null],
  [{ ...level, bigBlind: 0 }],
  [{ ...level, smallBlind: 100 }],
  [{ ...level, durationMinutes: 'never' }],
  [{ ...level, smallBlind: 0, bigBlind: 0 }],
  [{ ...level, isBreak: 'false' }],
  [level, { ...level, level: 2, smallBlind: 20 }],
  [{ ...level, ante: -1 }],
];

describe('MTT structure creation contract', () => {
  it.each(invalid.map((structure) => ({ structure })))(
    'refuses a malformed scheduled ladder %j',
    async ({ structure }) => {
      const service = new ScheduledTournamentService();
      await expect(
        (service as any).buildInsertRow(
          { id: 'structure-schedule', club_id: 'club', union_id: null, name: 'Structure test' },
          {
            name: 'Structure test',
            type: 'mtt',
            buyIn: 10,
            startingStack: 10000,
            maxPlayers: 100,
            blindStructure: structure,
            payoutPreset: 'NINE',
          },
          new Date()
        )
      ).rejects.toThrow('Invalid tournament blind structure');
    }
  );

  it.each(Object.entries(MTT_BLIND_PRESETS))(
    'preserves the advertised %s engine preset',
    (_name, structure) => {
      const before = JSON.stringify(structure);
      expect(() => validateMttBlindStructure(structure, 10000)).not.toThrow();
      expect(JSON.stringify(structure)).toBe(before);
    }
  );
  it.each([0, -1, null, '', 'NaN', 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an unusable starting stack %j',
    (stack) => {
      expect(() => validateMttBlindStructure([level], stack)).toThrow('starting stack');
    }
  );
  it.each(
    [
      [{ smallBlind: 0, bigBlind: 50, ante: 5, duration: 120 }],
      [{ ...level, durationMinutes: undefined, duration_minutes: 5 }],
      [
        level,
        { smallBlind: 0, bigBlind: 0, ante: 0, durationMinutes: 5, isBreak: true },
        { ...level, smallBlind: 50, bigBlind: 100 },
      ],
      [{ ...level, durationMinutes: 0, duration: 180 }],
    ].map((structure) => ({ structure }))
  )(
    'keeps valid clock aliases, short-deck small blinds, and explicit break markers %j',
    ({ structure }) => {
      expect(() => validateMttBlindStructure(structure, 10000)).not.toThrow();
    }
  );
});

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../scripts/dev/fixtures/mtt-blind-contract/vectors.json', import.meta.url),
    'utf8'
  )
) as Array<{ name: string; structure: unknown; stack: unknown; valid: boolean }>;
const shapes = JSON.parse(
  readFileSync(
    new URL('../../../scripts/dev/fixtures/mtt-blind-contract/baseline.json', import.meta.url),
    'utf8'
  )
).existing_shapes as Array<{ blind_structure: string; starting_chips: number }>;
afterEach(() => vi.restoreAllMocks());
it.each(vectors)('shares native validation vector $name', ({ structure, stack, valid }) => {
  if (valid) expect(() => validateMttBlindStructure(structure, stack)).not.toThrow();
  else
    expect(() => validateMttBlindStructure(structure, stack)).toThrow(
      'Invalid tournament blind structure'
    );
});
it('accepts all captured current active MTT structures without mutation', () => {
  for (const row of shapes)
    expect(() =>
      validateMttBlindStructure(JSON.parse(row.blind_structure), row.starting_chips)
    ).not.toThrow();
});
it.each(['createTournament', 'createXMTT'])(
  'refuses malformed recurring %s before any database write',
  async (method) => {
    const query = vi.spyOn(supabase, 'from');
    const service = new TournamentRecurringService();
    const result = await (service as any)[method](
      {
        name: 'Invalid structure',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 10,
        startingStack: 10000,
        maxPlayers: 100,
        blindStructure: [{ ...level, bigBlind: 0 }],
      },
      'union',
      'club'
    );
    expect(result).toEqual({ tournamentId: null, registered: 0 });
    expect(query).not.toHaveBeenCalled();
  }
);
