/**
 * TOURNAMENT CREATION RULES: ONE LIST, EVERY SURFACE (20260924033701)
 *
 * The shared validator (src/lib/tournamentCreationRules.ts) is held to the same
 * case table as public.fn_tournament_config_refusal
 * (scripts/ci/fixtures/tournament-creation-rules/cases.json, which
 * scripts/ci/test-tournament-creation-rules.py runs against PostgreSQL), and
 * each creation surface is shown to apply it: the service create path, the
 * table-config mapping and the schedule upsert. The modal's live checks are in
 * tests/components/tournamentCreationRulesModal.test.tsx. The assertions that
 * read the migration itself (every SQL refusal code is in the case table, and
 * the pinned post-images) live with the migration, in
 * tests/unit/tournamentCreationRulesSqlParity.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: async () => ({ allowed: true }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (value: string) => value,
}));

import {
  PAYOUT_TOTAL_TOLERANCE,
  START_TIME_GRACE_MS,
  TOURNAMENT_CREATE_ERRORS,
  TournamentConfigRefusedError,
  payoutTotalIsValid,
  rebuyWindowIsOpen,
  startTimeIsPast,
  tournamentCreateDbErrorMessage,
  tournamentCreateErrorMessage,
  tournamentRpcConfigRefusal,
} from '../../src/lib/tournamentCreationRules';
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { supabase } from '../../src/lib/supabase';
import { BLIND_STRUCTURES, newTournamentPlayingLevels } from '../../src/config/blindStructures';

afterEach(() => vi.restoreAllMocks());

const ROOT = join(__dirname, '../..');
const CASES = JSON.parse(
  readFileSync(join(ROOT, 'scripts/ci/fixtures/tournament-creation-rules/cases.json'), 'utf8')
).cases as Array<{
  name: string;
  surface: 'create' | 'schedule';
  config: Record<string, unknown>;
  expect: string | null;
  expectClient?: string | null;
  startOffsetMinutes?: number;
}>;

const NOW = Date.parse('2026-09-24T12:00:00Z');

describe('the shared validator answers the case table the database answers', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const config =
      c.startOffsetMinutes === undefined || Array.isArray(c.config)
        ? c.config
        : { ...c.config, startTime: new Date(NOW + c.startOffsetMinutes * 60_000).toISOString() };
    const expected = 'expectClient' in c ? c.expectClient : c.expect;
    expect(tournamentRpcConfigRefusal(config, { surface: c.surface, nowMs: NOW })).toBe(expected);
  });

  it('has an accepted case on both surfaces', () => {
    // That every refusal fn_tournament_config_refusal can RETURN is in this
    // table is proved beside the migration (tournamentCreationRulesSqlParity).
    expect(CASES.some((c) => c.expect)).toBe(true);
    for (const surface of ['create', 'schedule']) {
      expect(CASES.some((c) => c.surface === surface && c.expect === null)).toBe(true);
    }
  });
});

describe('the single rules the forms read live', () => {
  it('payouts: the database tolerance of 1, and a zero total is refused', () => {
    expect(PAYOUT_TOTAL_TOLERANCE).toBe(1);
    expect(payoutTotalIsValid(100)).toBe(true);
    expect(payoutTotalIsValid(99.2)).toBe(true); // the modal's old 0.5 refused this
    expect(payoutTotalIsValid(101)).toBe(true);
    expect(payoutTotalIsValid(98.9)).toBe(false);
    expect(payoutTotalIsValid(0)).toBe(false); // the service used to skip a zero total
    expect(payoutTotalIsValid(Number.NaN)).toBe(false);
  });

  it('start time: a minute of grace, then the past is refused', () => {
    expect(START_TIME_GRACE_MS).toBe(60_000);
    expect(startTimeIsPast(NOW - 59_000, NOW)).toBe(false);
    expect(startTimeIsPast(NOW - 61_000, NOW)).toBe(true);
    expect(startTimeIsPast(undefined, NOW)).toBe(false);
    expect(startTimeIsPast('not a date', NOW)).toBe(false);
  });

  it('rebuy and re-entry: either alone or both need an open window; a Free Buy has its own', () => {
    const paid = { buyIn: 10, type: 'mtt' };
    expect(rebuyWindowIsOpen({ ...paid, lateRegistrationLevels: 0 })).toBe(true);
    expect(rebuyWindowIsOpen({ ...paid, isRebuy: true, lateRegistrationLevels: 0 })).toBe(false);
    expect(rebuyWindowIsOpen({ ...paid, isReentry: true, lateRegistrationLevels: 0 })).toBe(false);
    expect(
      rebuyWindowIsOpen({ ...paid, isRebuy: true, isReentry: true, lateRegistrationLevels: 4 })
    ).toBe(true);
    expect(rebuyWindowIsOpen({ ...paid, isRebuy: true, lateRegistrationMinutes: 30 })).toBe(true);
    expect(rebuyWindowIsOpen({ buyIn: 0, type: 'mtt', isRebuy: true })).toBe(true);
    expect(rebuyWindowIsOpen({ buyIn: 0, type: 'sng', isRebuy: true })).toBe(false);
  });
});

/** Every `'error', '<code>'` a creation-path function in the repo can return. */
function serverCodes(): string[] {
  const dir = join(ROOT, 'supabase/migrations');
  const files = [
    '20260903172703_an_event_may_restart_every_week.sql',
    '20260912044409_remaining_tournament_variant_allowlist.sql',
    '20260917065000_mtt_dual_creation_preparation.sql',
    '20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql',
  ];
  for (const f of files) expect(readdirSync(dir)).toContain(f);
  const codes = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/'error'\s*,\s*'([a-z_0-9]+)'/g)) codes.add(m[1]);
  }
  // fn_tournament_config_refusal's codes: the case table holds every one of
  // them (tournamentCreationRulesSqlParity reads the migration to prove it).
  for (const c of CASES) if (c.expect) codes.add(c.expect);
  return [...codes].sort();
}

const SCHEDULE_ONLY = new Set([
  'schedule_must_be_object',
  'schedule_not_found',
  'club_id_required',
  'name_required',
  'config_must_be_object',
  'days_of_week_required',
  'days_of_week_out_of_range',
  'start_time_format_invalid',
  'start_times_or_interval_required',
  'interval_minutes_out_of_range',
]);

const isTitleCase = (text: string) =>
  text
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z]+/, ''))
    .filter(Boolean)
    .every((word) => word[0] === word[0].toUpperCase());

describe('every server code and SQLSTATE has its own Title Case sentence', () => {
  it('maps every creation code the database can return', () => {
    const codes = serverCodes().filter((c) => !SCHEDULE_ONLY.has(c));
    expect(codes).toContain('satellite_requires_scheduled_mtt_config');
    expect(codes).toContain('rebuy_requires_late_registration');
    for (const code of codes) {
      expect(TOURNAMENT_CREATE_ERRORS[code], code).toBeTruthy();
    }
  });

  it('writes every sentence in Title Case, with no em dash and no raw code', () => {
    for (const [code, text] of Object.entries(TOURNAMENT_CREATE_ERRORS)) {
      expect(isTitleCase(text), text).toBe(true);
      expect(text).not.toContain('—');
      expect(text).not.toContain(code);
    }
  });

  it('names an unknown code without leaking it', () => {
    expect(tournamentCreateErrorMessage('something_new')).toBe(
      'Could Not Create The Tournament. Refresh The Lobby And Try Again.'
    );
    expect(tournamentCreateErrorMessage('satellite_requires_scheduled_mtt_config')).toBe(
      TOURNAMENT_CREATE_ERRORS.satellite_requires_scheduled_mtt_config
    );
  });

  it.each([
    [
      '23514',
      'tournament guard: 5 paid places for 2 seats - more places than players who can enter',
      TOURNAMENT_CREATE_ERRORS.more_paid_places_than_players,
    ],
    [
      '23514',
      'tournament guard: max_players must be positive (got 0) - a tournament with no seats can never start',
      TOURNAMENT_CREATE_ERRORS.max_players_must_be_positive,
    ],
    [
      '23514',
      'new row for relation "tournaments" violates check constraint "tournaments_spin_has_no_fee"',
      'Could Not Create The Tournament. Its Seats, Payouts Or Prices Failed A Safety Check.',
    ],
    [
      '22023',
      'Invalid tournament blind structure: level 3 decreases the blinds',
      'The Blind Structure Was Refused. Every Level Needs A Positive Duration, And Blinds Can Never Go Down.',
    ],
    [
      '22023',
      'Invalid mystery bounty activation',
      'The Mystery Bounty Options Are Not Valid. Check The Profile, Activation And Pool Percent.',
    ],
    [
      '22023',
      'Free Buy creation options require an eligible free-entry tournament',
      'Free Buy Options Need A Free Entry Tournament With No Buy-In.',
    ],
    [
      '22023',
      'something else',
      'Could Not Create The Tournament. One Of Its Settings Is Not Valid.',
    ],
    [
      '23503',
      'insert or update on table "tournaments" violates foreign key constraint "tournaments_satellite_target_id_fkey"',
      'The Target Tournament For This Satellite No Longer Exists. Pick Another Target.',
    ],
    [
      '23503',
      'violates foreign key constraint "tournaments_club_id_fkey"',
      'Could Not Create The Tournament. The Club Or Event It Refers To No Longer Exists.',
    ],
    [
      '55000',
      'Club X cannot guarantee 500 chips: short by 20. Add chips to the bank to cover the guarantee.',
      'Club X cannot guarantee 500 chips: short by 20. Add chips to the bank to cover the guarantee.',
    ],
    [
      '55000',
      'MTT_ADMISSION_CONTRACT_DRIFT',
      'Could Not Create The Tournament Because Something It Depends On Changed. Refresh And Try Again.',
    ],
    ['0A000', 'multi-day', 'Could Not Create The Tournament. That Option Is Not Available Yet.'],
    ['42501', 'permission denied', 'You Do Not Have Permission To Create Games For This Club.'],
    ['22P02', 'invalid input syntax', TOURNAMENT_CREATE_ERRORS.invalid_configuration],
    ['22003', 'out of range', 'A Number In The Form Is Too Large. Lower It And Try Again.'],
  ])('SQLSTATE %s (%s)', (code, message, expected) => {
    const text = tournamentCreateDbErrorMessage({ code, message });
    expect(text).toBe(expected);
    expect(text).not.toMatch(/please try again/i);
    expect(text).not.toContain('—');
  });

  it('no longer blames the buy-in for a seat refusal', () => {
    const text = tournamentCreateDbErrorMessage({
      code: '23514',
      message: 'tournament guard: 5 paid places for 2 seats',
    });
    expect(text).not.toMatch(/buy-in or fee/i);
  });
});

// ── Surface 1: the service create path (the modal and the table-config page) ──

const mtt: TournamentConfig = {
  name: 'Rules Probe',
  type: 'mtt',
  buyIn: 20,
  rake: 2,
  startingStack: 10000,
  maxPlayers: null,
  minPlayers: 3,
  tableSize: 9,
  gameVariant: 'NLH',
  blindStructure: newTournamentPlayingLevels(BLIND_STRUCTURES.regular),
  payoutStructure: [{ place: 1, percentage: 100 }],
  payoutPercent: 10,
  lateRegistrationLevels: 6,
  isRebuy: false,
  addOnAvailable: false,
};
const sng: TournamentConfig = {
  ...mtt,
  type: 'sng',
  maxPlayers: 6,
  minPlayers: 6,
  tableSize: 6,
  lateRegistrationLevels: 0,
  payoutPercent: undefined,
  blindStructure: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 5 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 5 },
  ],
  payoutStructure: [
    { place: 1, percentage: 65 },
    { place: 2, percentage: 35 },
  ],
};

function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof TournamentConfigRefusedError ? err.code : String(err);
  }
}

describe('surface: TournamentService.buildRpcConfig and createTournament', () => {
  it.each([
    [
      'a zero payout total',
      { payoutStructure: [{ place: 1, percentage: 0 }] },
      'payouts_must_total_100',
    ],
    [
      'payouts 2 short',
      { payoutStructure: [{ place: 1, percentage: 98 }] },
      'payouts_must_total_100',
    ],
    ['a start in the past', { startTime: new Date(Date.now() - 3_600_000) }, 'start_time_in_past'],
    ['a satellite with no target', { type: 'satellite' as const }, 'satellite_target_required'],
    [
      'a rebuy with no late window',
      { isRebuy: true, lateRegistrationLevels: 0 },
      'rebuy_requires_late_registration',
    ],
    [
      'a re-entry with no late window',
      { isReentry: true, lateRegistrationLevels: 0 },
      'rebuy_requires_late_registration',
    ],
    [
      'PLO6 at nine seats (clamped 2-10 only)',
      { gameVariant: 'PLO6' as const, tableSize: 9 },
      'table_size_exceeds_deck',
    ],
  ])('refuses %s', (_label, patch, code) => {
    expect(refusalOf(() => tournamentService.buildRpcConfig({ ...mtt, ...patch }))).toBe(code);
  });

  it('refuses a non-positive starting stack for a Sit And Go and a Spin, not only an MTT', () => {
    expect(refusalOf(() => tournamentService.buildRpcConfig({ ...sng, startingStack: 0 }))).toBe(
      'starting_stack_must_be_positive'
    );
    expect(
      refusalOf(() =>
        tournamentService.buildRpcConfig({
          ...sng,
          type: 'spin',
          maxPlayers: 3,
          tableSize: 3,
          startingStack: -1,
        })
      )
    ).toBe('starting_stack_must_be_positive');
  });

  it('refuses a Sit And Go ladder that falls, and one with a 0 minute level', () => {
    const [a, b] = sng.blindStructure;
    expect(
      refusalOf(() => tournamentService.buildRpcConfig({ ...sng, blindStructure: [b, a] }))
    ).toBe('blind_structure_must_not_decrease');
    expect(
      refusalOf(() =>
        tournamentService.buildRpcConfig({ ...sng, blindStructure: [{ ...a, durationMinutes: 0 }] })
      )
    ).toBe('blind_level_duration_invalid');
  });

  it('accepts payouts within 1 of 100 and rebuy with re-entry together', () => {
    expect(
      refusalOf(() =>
        tournamentService.buildRpcConfig({
          ...mtt,
          payoutStructure: [{ place: 1, percentage: 99.2 }],
          isRebuy: true,
          isReentry: true,
          rebuyCost: 20,
          rebuyChips: 10000,
          lateRegistrationLevels: 6,
        })
      )
    ).toBeNull();
  });

  it('accepts a Free Buy whose late registration is 0: the event has its own rebuy levels', () => {
    expect(
      refusalOf(() =>
        tournamentService.buildRpcConfig({ ...mtt, buyIn: 0, rake: 0, lateRegistrationLevels: 0 })
      )
    ).toBeNull();
  });

  it('refuses before the round trip, with the refusal sentence', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(
      tournamentService.createTournament('club', { ...mtt, type: 'satellite' })
    ).rejects.toThrow(TOURNAMENT_CREATE_ERRORS.satellite_target_required);
    expect(rpc).not.toHaveBeenCalledWith('fn_create_tournament', expect.anything());
  });

  it('turns a server refusal code into its sentence, including the ones it used to drop', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { success: false, error: 'satellite_requires_scheduled_mtt_config' },
      error: null,
    } as never);
    await expect(tournamentService.createTournament('club', mtt)).rejects.toThrow(
      TOURNAMENT_CREATE_ERRORS.satellite_requires_scheduled_mtt_config
    );
  });

  it('turns a database error into its specific sentence', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: null,
      error: {
        code: '23514',
        message:
          'tournament guard: 5 paid places for 2 seats - more places than players who can enter',
      },
    } as never);
    await expect(tournamentService.createTournament('club', mtt)).rejects.toThrow(
      TOURNAMENT_CREATE_ERRORS.more_paid_places_than_players
    );
  });
});

// ── Surface 2: the table-config page ──

const form: TournamentFormInput = {
  name: 'Table Config Probe',
  gameMode: 'mtt',
  buyIn: 20,
  startingChips: 10000,
  blindStructure: 'regular',
  blindsUpMinutes: 10,
  payoutStructure: 'payout1',
  sngPlayerCount: 6,
  isSpins: false,
  minPlayers: 3,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};
const fromForm = (patch: Partial<TournamentFormInput>, game = 'nlh') =>
  refusalOf(() =>
    tournamentService.buildRpcConfig(buildTournamentConfig({ ...form, ...patch }, game))
  );

describe('surface: the table-config page (buildTournamentConfig)', () => {
  it('builds an acceptable default', () => {
    expect(fromForm({})).toBeNull();
  });

  it('refuses a past start instead of replacing it with now', () => {
    expect(() => buildTournamentConfig({ ...form, startTime: '2020-01-01T12:00' }, 'nlh')).toThrow(
      TOURNAMENT_CREATE_ERRORS.start_time_in_past
    );
  });

  it('refuses the satellite toggle without a target instead of building a plain MTT', () => {
    expect(() => buildTournamentConfig({ ...form, nextStepSatellite: true }, 'nlh')).toThrow(
      TOURNAMENT_CREATE_ERRORS.satellite_target_required
    );
  });

  it('refuses rebuys and re-entries with late registration at 0, accepts them with a window', () => {
    expect(fromForm({ numberOfRebuysReentries: 2, lateRegistrationLevel: 0 })).toBe(
      'rebuy_requires_late_registration'
    );
    const both = buildTournamentConfig({ ...form, numberOfRebuysReentries: 2 }, 'nlh');
    expect(both.isRebuy && both.isReentry).toBe(true);
    expect(fromForm({ numberOfRebuysReentries: 2 })).toBeNull();
  });

  it('keeps a PLO6 table inside the deck, and the result is accepted', () => {
    const c = buildTournamentConfig({ ...form, tableSize: 10 }, 'plo6');
    expect(c.tableSize).toBe(7);
    expect(fromForm({ tableSize: 10 }, 'plo6')).toBeNull();
  });

  it('refuses a zero starting stack, on the Sit And Go tab too', () => {
    expect(fromForm({ gameMode: 'sng', startingChips: 0 })).toBe('starting_stack_must_be_positive');
    // An MTT meets the new-MTT blind contract first, which refuses it as well.
    expect(fromForm({ startingChips: 0 })).toMatch(
      /starting stack must be a positive whole number/
    );
  });
});

// ── Surface 3: the schedule upsert ──

describe('surface: TournamentScheduleService.upsert', () => {
  const draft = (config: Record<string, unknown>) => ({
    clubId: 'club',
    name: 'Weekly',
    daysOfWeek: [0],
    startTimesUtc: ['18:00'],
    config,
  });

  it.each([
    ['a satellite with no target', { type: 'satellite' }, 'satellite_target_required'],
    [
      'a re-entry with late registration 0',
      { type: 'mtt', buyIn: 10, isReentry: true, lateRegistrationLevels: 0 },
      'rebuy_requires_late_registration',
    ],
    [
      'a PLO5 table of ten',
      { type: 'mtt', gameVariant: 'PLO5', tableSize: 10 },
      'table_size_exceeds_deck',
    ],
    [
      'a Sit And Go ladder that falls',
      {
        type: 'sng',
        maxPlayers: 6,
        blindStructure: [
          { smallBlind: 20, bigBlind: 40 },
          { smallBlind: 10, bigBlind: 20 },
        ],
      },
      'blind_structure_must_not_decrease',
    ],
    [
      'payouts of 90',
      { type: 'mtt', payoutStructure: [{ place: 1, percentage: 90 }] },
      'payouts_must_total_100',
    ],
    ['a starting stack of 0', { type: 'mtt', startingStack: 0 }, 'starting_stack_must_be_positive'],
  ])('refuses %s before the round trip', async (_label, config, code) => {
    const rpc = vi.spyOn(supabase, 'rpc');
    await expect(tournamentScheduleService.upsert(draft(config))).rejects.toThrow(
      TOURNAMENT_CREATE_ERRORS[code]
    );
    expect(rpc).not.toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.anything());
  });

  it('sends an acceptable schedule, and reads a server refusal with the creation sentences', async () => {
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { error: 'table_size_exceeds_deck' }, error: null } as never);
    await expect(
      tournamentScheduleService.upsert(draft({ type: 'satellite', satelliteTargetName: 'Sunday' }))
    ).rejects.toThrow(TOURNAMENT_CREATE_ERRORS.table_size_exceeds_deck);
    expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.anything());
  });

  it('does not check a start time the spawner owns', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: true, schedule_id: 'schedule' },
      error: null,
    } as never);
    await expect(
      tournamentScheduleService.upsert(draft({ type: 'mtt', startTime: '2020-01-01T00:00:00Z' }))
    ).resolves.toBe('schedule');
  });
});
