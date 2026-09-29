import { describe, expect, it } from 'vitest';
import { checkCitedReferences, type ReplaySolverStores } from './references.js';
import { qualifyHorseDecisionIndependently } from './independentQualification.js';
import { reconstructHorseReplayInput } from './reconstruct.js';
import { PHASE6C_FIXTURE_IDS as IDS, phase6cFixtureRecord } from './fixtures/index.js';
import { solverStoreIdentity } from '../../../gto/SolverStoreIdentity.js';

const empty: ReplaySolverStores = {
  charts: 0,
  postflop: 0,
  postflopV31: 0,
  postflopV31Dataset: null,
  identity: {
    charts: solverStoreIdentity(new Map(), null),
    postflop: solverStoreIdentity(new Map(), null),
  },
};
/** A store of `rows` entries whose content is named by `tag`. */
const storeOf = (tag: string, rows: number) =>
  solverStoreIdentity(new Map(Array.from({ length: rows }, (_, i) => [`k${i}`, tag])), null);
const chartsLoaded = (tag: string, rows = 240, pins?: ReplaySolverStores['pins']) => ({
  ...empty,
  charts: rows,
  identity: { ...empty.identity!, charts: storeOf(tag, rows) },
  pins,
});
type ReplayInput = ReturnType<typeof reconstructHorseReplayInput>;
function referencesFor(
  id: string,
  stores: ReplaySolverStores,
  mutate?: (input: ReplayInput) => void,
  timing: { atMs?: number; releaseNotBeforeMs?: number | null } = {}
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
    atMs: timing.atMs ?? input.atMs,
    releaseNotBeforeMs: timing.releaseNotBeforeMs === undefined ? null : timing.releaseNotBeforeMs,
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
    expect(unavailable(referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('a', 239)))).toEqual([
      'chart_store',
    ]);
  });

  it('planted red: a count-only record is never matched to a store merely of the same size', () => {
    // Before 2026-09-27 this returned [] because 240 equalled 240.
    const refs = referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('any 240 charts'));
    expect(unavailable(refs)).toEqual(['chart_store']);
    expect(refs.find((r) => r.ref === 'chart_store')?.detail).toMatch(/no pinned snapshot/);
  });

  describe('a count-only record meets a pinned snapshot', () => {
    const input = reconstructHorseReplayInput(phase6cFixtureRecord(IDS.tournamentChartOpenJam));
    const loadedAt = Date.parse(String(input.readiness.solverPolicyArtifact.charts?.loadedAt));
    const from = Math.min(input.atMs, Number.isFinite(loadedAt) ? loadedAt : input.atMs) - 60_000;
    const pin = (tag: string, rows = 240, window = { from, to: input.atMs + 60_000 }) => ({
      charts: {
        identity: storeOf(tag, rows),
        unchangedFromMs: window.from,
        unchangedToMs: window.to,
        witness: 'test',
      },
    });
    const refs = (
      stores: ReplaySolverStores,
      timing: { atMs?: number; releaseNotBeforeMs?: number | null } = {
        releaseNotBeforeMs: from,
      }
    ) => unavailable(referencesFor(IDS.tournamentChartOpenJam, stores, undefined, timing));

    it('is available only when the loaded store is the pinned one and the window covers the release', () => {
      expect(refs(chartsLoaded('pinned', 240, pin('pinned')))).toEqual([]);
    });

    it('planted red: a loaded store of the same size that is not the pinned snapshot is refused', () => {
      expect(refs(chartsLoaded('tampered', 240, pin('pinned')))).toEqual(['chart_store']);
    });

    it('refuses a pin of a different size than the original recorded', () => {
      expect(refs(chartsLoaded('pinned', 239, pin('pinned', 239)))).toEqual(['chart_store']);
    });

    it('refuses a decision made outside the pinned window', () => {
      const early = pin('pinned', 240, { from: input.atMs + 1, to: input.atMs + 60_000 });
      expect(
        refs(chartsLoaded('pinned', 240, early), { releaseNotBeforeMs: input.atMs + 1 })
      ).toEqual(['chart_store']);
    });

    it('refuses a release that may have loaded its store before the window opened', () => {
      const stores = chartsLoaded('pinned', 240, pin('pinned'));
      expect(refs(stores, { releaseNotBeforeMs: from - 1 })).toEqual(['chart_store']);
      expect(refs(stores, { releaseNotBeforeMs: null })).toEqual(['chart_store']);
    });

    it('refuses a recorded chart load outside the pinned window', () => {
      if (!Number.isFinite(loadedAt)) return;
      const late = pin('pinned', 240, { from: loadedAt + 1, to: input.atMs + 60_000 });
      expect(
        refs(chartsLoaded('pinned', 240, late), {
          releaseNotBeforeMs: loadedAt + 1,
          atMs: input.atMs,
        })
      ).toEqual(['chart_store']);
    });
  });

  it('matches a record that journaled the store identity by digest, and refuses a same-size impostor', () => {
    const recorded = (input: ReplayInput) => {
      input.readiness.solverStoreIdentity = {
        charts: storeOf('live', 240),
        postflop: solverStoreIdentity(new Map(), null),
      };
    };
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('live'), recorded))
    ).toEqual([]);
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('other'), recorded))
    ).toEqual(['chart_store']);
  });

  it('planted red: an original that decided with no charts is not replayed with charts loaded', () => {
    const noCharts = (input: ReplayInput) => {
      input.readiness.solverStores.charts = 0;
    };
    // Before 2026-09-27 a recorded 0 skipped the comparison and this was available.
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('a'), noCharts))
    ).toEqual(['chart_store']);
    expect(unavailable(referencesFor(IDS.tournamentChartOpenJam, empty, noCharts))).toEqual([]);
  });

  it('refuses a chart decision made while an external policy artifact outranked the chart table', () => {
    const external = (input: ReplayInput) => {
      input.readiness.solverPolicyArtifact.external = { count: 3 };
    };
    expect(
      unavailable(referencesFor(IDS.tournamentChartOpenJam, chartsLoaded('a'), external))
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
