import { describe, expect, it, vi, afterEach } from 'vitest';
import { validateMttBlindStructure } from '../../server/src/domain/tournamentBlindContract';
import { supabase } from '../../src/lib/supabase';
import { readFileSync } from 'node:fs';
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
import { BLIND_STRUCTURES } from '../../src/config/blindStructures';

const vectors = JSON.parse(
  readFileSync('scripts/dev/fixtures/mtt-blind-contract/vectors.json', 'utf8')
) as Array<{ name: string; structure: unknown; stack: unknown; valid: boolean }>;
const base = {
  name: 'Structure contract',
  type: 'mtt',
  gameVariant: 'nlh',
  buyIn: 10,
  rake: 10,
  startingStack: 10000,
  maxPlayers: 100,
  minPlayers: 3,
  payoutStructure: [{ place: 1, percentage: 100 }],
};
describe('manual tournament and saved schedule configuration', () => {
  it.each(vectors)(
    'uses the engine and database validation vector $name',
    ({ structure, stack, valid }) => {
      const config = {
        ...base,
        blindStructure: structure,
        startingStack: stack,
      } as TournamentConfig;
      const containsBreak =
        Array.isArray(structure) && structure.some((row) => row?.isBreak === true);
      if (valid && containsBreak) {
        expect(() => validateMttBlindStructure(structure, stack)).not.toThrow();
        expect(() => tournamentService.buildRpcConfig(config)).toThrow(
          'Custom Level Breaks Are Not Supported'
        );
      } else if (valid)
        expect(tournamentService.buildRpcConfig(config)).toMatchObject({
          blindStructure: structure,
          startingStack: stack,
        });
      else
        expect(() => tournamentService.buildRpcConfig(config)).toThrow(
          'Invalid tournament blind structure'
        );
    }
  );
  it.each(Object.entries(BLIND_STRUCTURES))(
    'retains the historical %s preset but refuses to author unsupported break rows',
    (_name, blindStructure) => {
      const before = JSON.stringify(blindStructure);
      expect(() => validateMttBlindStructure(blindStructure, base.startingStack)).not.toThrow();
      const serialize = () =>
        tournamentService.buildRpcConfig({ ...base, blindStructure } as TournamentConfig);
      if (blindStructure.some((row) => row.isBreak))
        expect(serialize).toThrow('Custom Level Breaks Are Not Supported');
      else expect(serialize().blindStructure).toEqual(blindStructure);
      expect(JSON.stringify(blindStructure)).toBe(before);
    }
  );

  it.each(['mtt', 'bounty', 'progressive_bounty', 'mystery_bounty', 'satellite'])(
    'refuses an authored %s break even with a legacy two-entry capacity',
    (type) => {
      const config = {
        ...base,
        type,
        maxPlayers: 2,
        blindStructure: BLIND_STRUCTURES.regular,
      } as TournamentConfig;
      expect(() => tournamentService.buildRpcConfig(config)).toThrow(
        'Custom Level Breaks Are Not Supported'
      );
    }
  );

  it('rejects the actual create caller before any RPC or authorization read', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    const from = vi.spyOn(supabase, 'from');
    await expect(
      tournamentService.createTournament('synthetic-club', {
        ...base,
        blindStructure: BLIND_STRUCTURES.regular,
      } as TournamentConfig)
    ).rejects.toThrow('Custom Level Breaks Are Not Supported');
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.restoreAllMocks());

describe('schedule authoring refusal reaches the real caller', () => {
  afterEach(() => vi.restoreAllMocks());
  it('explains the database break-row refusal without claiming the schedule was saved', async () => {
    const { tournamentScheduleService } =
      await import('../../src/services/TournamentScheduleService');
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { error: 'custom_level_breaks_not_supported' },
      error: null,
    } as never);
    await expect(
      tournamentScheduleService.upsert({
        clubId: 'synthetic-club',
        name: 'Unsupported Break Draft',
        daysOfWeek: [1],
        startTimesUtc: ['18:00'],
        config: { type: 'mtt', blindStructure: BLIND_STRUCTURES.regular },
      })
    ).rejects.toThrow('Custom Level Breaks Are Not Supported');
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      'fn_upsert_tournament_schedule',
      expect.objectContaining({
        p_schedule: expect.objectContaining({
          config: {
            type: 'mtt',
            blindStructure: BLIND_STRUCTURES.regular,
            maxPlayers: null,
            max_players: null,
          },
        }),
      })
    );
  });
});
