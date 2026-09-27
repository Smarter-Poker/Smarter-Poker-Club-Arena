import { describe, expect, it } from 'vitest';
import { checkCitedReferences, type ReplaySolverStores } from './references.js';
import { qualifyHorseDecisionIndependently } from './independentQualification.js';
import { reconstructHorseReplayInput } from './reconstruct.js';
import { PHASE6C_FIXTURE_IDS as IDS, phase6cFixtureRecord } from './fixtures/index.js';

const empty: ReplaySolverStores = {
  charts: 0,
  postflop: 0,
  postflopV31: 0,
  postflopV31Dataset: null,
};
function referencesFor(
  id: string,
  stores: ReplaySolverStores,
  mutate?: (input: ReturnType<typeof reconstructHorseReplayInput>) => void
) {
  const input = structuredClone(reconstructHorseReplayInput(phase6cFixtureRecord(id)));
  mutate?.(input);
  const q = qualifyHorseDecisionIndependently({
    player: input.request.player,
    gameState: input.request.gameState as never,
    opts: null,
    attribution: (input.original.tournamentPreflopAttribution as never) ?? null,
  });
  return checkCitedReferences({
    gameState: input.request.gameState,
    original: input.original,
    recorded: input.readiness,
    admissibleRoutes: q.admissibleRoutes,
    postflopStoreConsultPossible: q.postflopStoreConsultPossible,
    stores,
  });
}
const unavailable = (refs: ReturnType<typeof referencesFor>) =>
  refs.filter((r) => r.status === 'unavailable').map((r) => r.ref);

describe('Phase 6C cited references must exist in the published source', () => {
  it('finds the atlas cell and the variant owner of an atlas-evaluated decision', () => {
    const refs = referencesFor(IDS.tournamentAtlasEvaluated, empty);
    expect(unavailable(refs)).toEqual([]);
    expect(refs.map((r) => r.ref)).toEqual([
      'variant:nlh',
      'atlas_cell:phase6-v1:nlh:deterministic_baseline:5:CO:HJ:big_blind:multiway_all_in:20-25@0.07853333333333339:velocity=0.216',
    ]);
  });

  it('refuses an atlas cell the published atlas does not resolve to', () => {
    const refs = referencesFor(IDS.tournamentAtlasEvaluated, empty, (input) => {
      input.original.tournamentPreflopAttribution!.lookup!.policy.shifts.jam += 0.01;
    });
    expect(unavailable(refs)).toEqual([
      'atlas_cell:phase6-v1:nlh:deterministic_baseline:5:CO:HJ:big_blind:multiway_all_in:20-25@0.07853333333333339:velocity=0.216',
    ]);
  });

  it('refuses a chart-route decision when the chart store the original consulted is not loaded', () => {
    expect(unavailable(referencesFor(IDS.tournamentChartOpenJam, empty))).toEqual(['chart_store']);
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, { ...empty, charts: 240 }))
    ).toEqual([]);
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, { ...empty, charts: 239 }))
    ).toEqual(['chart_store']);
  });

  it('refuses an unregistered variant', () => {
    const refs = referencesFor(IDS.cashNlhPreflop, empty, (input) => {
      (input.request.gameState as { gameVariant: string }).gameVariant = 'holdem_x';
    });
    expect(unavailable(refs)).toEqual(['variant:holdem_x']);
  });

  it('does not demand a chart store for a decision no chart route could have owned', () => {
    expect(unavailable(referencesFor(IDS.cashPlo4Preflop, empty))).toEqual([]);
  });
});
