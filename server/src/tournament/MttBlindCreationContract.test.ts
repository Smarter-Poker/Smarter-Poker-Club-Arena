import { readFileSync } from 'node:fs';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { validateMttBlindStructure } from '../domain/tournamentBlindContract.js';
import { MTT_BLIND_PRESETS, mttLateRegistrationMinutes } from './mttStructurePolicy.js';

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

describe.each(['scheduled', 'createTournament', 'createXMTT'])(
  '%s late-registration units',
  (method) => {
    async function createdRow(structure: unknown[], overrides: Record<string, unknown> = {}) {
      const config = {
        name: 'Registration clock',
        type: 'mtt',
        gameVariant: 'nlh',
        buyIn: 10,
        startingStack: 10000,
        maxPlayers: 100,
        horsesToRegister: 0,
        payoutPreset: 'NINE',
        blindStructure: structure,
        ...overrides,
      };
      if (method === 'scheduled') {
        return (new ScheduledTournamentService() as any).buildInsertRow(
          { id: 'clock-schedule', club_id: 'club', union_id: null, name: config.name },
          config,
          new Date()
        );
      }
      let inserted: Record<string, unknown> | null = null;
      const query = {
        insert: vi.fn((row: Record<string, unknown>) => {
          inserted = row;
          return query;
        }),
        select: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: { id: 'clock-event' }, error: null })),
        update: vi.fn(() => query),
        eq: vi.fn(async () => ({ error: null })),
      };
      vi.spyOn(supabase, 'from').mockReturnValue(query as never);
      const service = new TournamentRecurringService();
      vi.spyOn(service as any, 'registerHorses').mockResolvedValue(0);
      await (service as any)[method](config, 'union', 'club');
      return inserted;
    }

    const cap = method === 'createXMTT' ? 10 : 8;
    it.each([
      { clock: { durationMinutes: 10 }, minutes: cap * 10 },
      { clock: { duration_minutes: 4 }, minutes: cap * 4 },
      { clock: { duration: 90 }, minutes: cap * 1.5 },
      { clock: { durationMinutes: 0, duration: 120 }, minutes: cap * 2 },
    ])('writes minutes from the authored clock $clock', async ({ clock, minutes }) => {
      const structure = [{ smallBlind: 25, bigBlind: 50, ante: 0, ...clock }];
      const before = JSON.stringify(structure);
      const row = await createdRow(structure);
      expect(row).toMatchObject({ late_reg_levels: cap, late_reg_mins: minutes });
      expect(JSON.stringify(structure)).toBe(before);
    });

    it('uses the indexed cutoff, skips unused break rows, and extends the last playable clock', async () => {
      const row = await createdRow([
        { ...level, durationMinutes: 10 },
        { smallBlind: 0, bigBlind: 0, ante: 0, durationMinutes: 5, isBreak: true },
        { ...level, smallBlind: 50, bigBlind: 100, durationMinutes: 4 },
        { smallBlind: 0, bigBlind: 0, ante: 0, durationMinutes: 5, isBreak: true },
      ]);
      expect(row).toMatchObject({ late_reg_levels: cap, late_reg_mins: 14 + (cap - 4) * 4 });
    });

    it('keeps Free Buy add-on availability while storing the real registration duration', async () => {
      const row = await createdRow([{ ...level, durationMinutes: 10 }], { buyIn: 0 });
      expect(row).toMatchObject({
        late_reg_levels: cap,
        late_reg_mins: cap * 10,
        addon_from_start: true,
        add_on_available: true,
      });
    });
  }
);

it('rounds only the final minute projection and preserves a zero level window', () => {
  expect(mttLateRegistrationMinutes([{ ...level, durationMinutes: 1.1 }], 3)).toBe(4);
  expect(mttLateRegistrationMinutes([{ ...level, durationMinutes: 1.1 }], 10)).toBe(11);
  expect(
    mttLateRegistrationMinutes(
      Array.from({ length: 10 }, () => ({ ...level, durationMinutes: 1.1 })),
      10
    )
  ).toBe(11);
  expect(mttLateRegistrationMinutes([level], 0)).toBe(0);
});

it.each([-1, NaN, Infinity, 0.5])('refuses an invalid level cutoff %s', (cutoff) => {
  expect(() => mttLateRegistrationMinutes([level], cutoff)).toThrow('level count');
});

it('refuses an absent, unreadable, or unpersistable registration clock', () => {
  expect(() => mttLateRegistrationMinutes([], 8)).toThrow('Missing');
  expect(() => mttLateRegistrationMinutes([{ ...level, durationMinutes: NaN }], 8)).toThrow(
    'clock'
  );
  expect(() =>
    mttLateRegistrationMinutes([{ ...level, durationMinutes: 2_147_483_647 }], 2)
  ).toThrow('database range');
});
