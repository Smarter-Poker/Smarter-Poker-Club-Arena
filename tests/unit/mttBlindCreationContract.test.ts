import { describe, expect, it } from 'vitest';
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
      if (valid)
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
    'preserves the complete manual %s preset',
    (_name, blindStructure) => {
      const before = JSON.stringify(blindStructure);
      expect(
        tournamentService.buildRpcConfig({ ...base, blindStructure } as TournamentConfig)
          .blindStructure
      ).toEqual(blindStructure);
      expect(JSON.stringify(blindStructure)).toBe(before);
    }
  );
});
