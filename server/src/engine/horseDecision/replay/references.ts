/**
 * Phase 6C step (e): every reference a journaled decision cites must exist in
 * the published source the replay runs against. A reference that is not
 * there is a refusal (`reference_unavailable:<ref>`), never a skip: a decision
 * replayed without the chart it consulted is a different decision.
 *
 * This file may import the production sources, because existence in the
 * published source is exactly what it asserts. Value qualification lives in
 * independentQualification.ts and imports none of them.
 */
import type { HorseDecision } from '../../../types.js';
import { gtoChartCount } from '../../GtoCharts.js';
import { gtoPostflopCount } from '../../GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../../GtoPostflopV31.js';
import { horsePolicyRegistration } from '../../HorsePolicyRegistry.js';
import {
  TOURNAMENT_PREFLOP_ATLAS_REVISION,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN,
  tournamentPreflopPolicy,
  type TournamentPreflopPolicyInput,
} from '../../HorseTournamentPreflop.js';
import type { HorseGameStateV2 } from '../../HorseLogic.js';
import type { HorseReplayReference } from './verdict.js';
import type { HorseReplaySolverReadiness } from './reconstruct.js';

export interface ReplaySolverStores {
  charts: number;
  postflop: number;
  postflopV31: number;
  postflopV31Dataset: { id: string; checksum: string } | null;
}

export function currentReplaySolverStores(): ReplaySolverStores {
  return {
    charts: gtoChartCount(),
    postflop: gtoPostflopCount(),
    postflopV31: gtoPostflopV31Count(),
    postflopV31Dataset: gtoPostflopV31Dataset(),
  };
}

export interface CitedReferenceInput {
  gameState: HorseGameStateV2;
  original: HorseDecision;
  recorded: HorseReplaySolverReadiness;
  /** From the independent qualifier: the routes the snapshot admits. */
  admissibleRoutes: readonly string[];
  postflopStoreConsultPossible: boolean;
  stores?: ReplaySolverStores;
}

const available = (ref: string, detail: string | null = null): HorseReplayReference => ({
  ref,
  status: 'available',
  detail,
});
const unavailable = (ref: string, detail: string | null = null): HorseReplayReference => ({
  ref,
  status: 'unavailable',
  detail,
});

export function checkCitedReferences(input: CitedReferenceInput): HorseReplayReference[] {
  const stores = input.stores ?? currentReplaySolverStores();
  const out: HorseReplayReference[] = [];
  const gs = input.gameState;
  const variant = gs.gameVariant;

  // Variant owner: the policy registry must name the variant the decision was made for.
  const ownership = input.original.policyOwnership;
  const registration = horsePolicyRegistration(variant);
  if (!registration)
    out.push(unavailable(`variant:${String(variant)}`, 'not registered in HorsePolicyRegistry'));
  else if (ownership && ownership.variant !== registration.variant)
    out.push(unavailable(`variant:${String(variant)}`, `decision names ${ownership.variant}`));
  else
    out.push(available(`variant:${registration.variant}`, `owner ${String(registration.owner)}`));

  // Atlas cell: revision and coordinate must resolve to the identical cell in the published atlas.
  const attribution = input.original.tournamentPreflopAttribution;
  if (attribution?.lookup) {
    const cell = attribution.lookup.policy.cell;
    const revision = attribution.inputSource.atlasRevision ?? null;
    if (revision !== null && revision !== TOURNAMENT_PREFLOP_ATLAS_REVISION)
      out.push(
        unavailable(
          `atlas_revision:${String(revision)}`,
          `published ${TOURNAMENT_PREFLOP_ATLAS_REVISION}`
        )
      );
    else {
      const c = attribution.lookup.coordinate;
      const domain = TOURNAMENT_PREFLOP_ATLAS_DOMAIN;
      const positions = domain.positions as readonly string[];
      const anchors = domain.depth.anchorsBB as readonly number[];
      const inDomain =
        (domain.tableSizes as readonly number[]).includes(c.tableSize) &&
        positions.includes(c.heroPosition) &&
        (c.raiserPosition === null || positions.includes(c.raiserPosition)) &&
        (domain.anteTypes as readonly string[]).includes(c.anteType) &&
        (domain.branches as readonly string[]).includes(c.branch) &&
        anchors.includes(attribution.lookup.policy.depth.lower) &&
        anchors.includes(attribution.lookup.policy.depth.upper);
      let published: ReturnType<typeof tournamentPreflopPolicy> | null = null;
      try {
        const query: TournamentPreflopPolicyInput = {
          gameFamily: c.gameFamily,
          contextStatus: c.contextStatus,
          tableSize: c.tableSize,
          heroPosition: c.heroPosition,
          raiserPosition: c.raiserPosition,
          anteType: c.anteType,
          branch: c.branch,
          stackBB: c.stackBB,
          m: gs.tournament?.m,
        };
        published = tournamentPreflopPolicy(query);
      } catch {
        published = null;
      }
      const p = attribution.lookup.policy;
      const same =
        published !== null &&
        published.cell === cell &&
        published.source === p.source &&
        published.fallbackReason === p.fallbackReason &&
        (['open', 'jam', 'call', 'threeBet', 'fourBet'] as const).every(
          (k) => published!.shifts[k] === p.shifts[k]
        );
      if (!inDomain)
        out.push(unavailable(`atlas_cell:${cell}`, 'coordinate outside the published domain'));
      else if (!same)
        out.push(
          unavailable(
            `atlas_cell:${cell}`,
            'published atlas resolves the coordinate to a different cell or shifts'
          )
        );
      else out.push(available(`atlas_cell:${cell}`, TOURNAMENT_PREFLOP_ATLAS_REVISION));
    }
  }

  // Chart store: cited by a chart route, and consulted whenever a chart route was admissible.
  const chartRoute =
    attribution?.route === 'chart_open_jam' || attribution?.route === 'chart_bb_defend';
  const chartConsult =
    chartRoute ||
    input.admissibleRoutes.some((r) => r === 'chart_open_jam' || r === 'chart_bb_defend');
  if (chartConsult) {
    const recorded = input.recorded.solverStores.charts;
    if (recorded > 0 && stores.charts === 0)
      out.push(
        unavailable(
          'chart_store',
          `original decided with ${recorded} charts loaded; replay has none`
        )
      );
    else if (recorded > 0 && stores.charts !== recorded)
      out.push(unavailable('chart_store', `original ${recorded} charts, replay ${stores.charts}`));
    else out.push(available('chart_store', `${stores.charts} charts`));
  }

  // Postflop stores: a hold'em heads-up open node may consult the warehouse.
  if (input.postflopStoreConsultPossible) {
    const recorded = input.recorded.solverStores.postflop;
    if (recorded > 0 && stores.postflop === 0)
      out.push(
        unavailable(
          'solver_store:postflop',
          `original decided with ${recorded} rows loaded; replay has none`
        )
      );
    else if (recorded > 0 && stores.postflop !== recorded)
      out.push(
        unavailable('solver_store:postflop', `original ${recorded} rows, replay ${stores.postflop}`)
      );
    else out.push(available('solver_store:postflop', `${stores.postflop} rows`));
    const dataset = input.recorded.solverStores.postflopV31Dataset;
    if (dataset) {
      const current = stores.postflopV31Dataset;
      if (!current || current.id !== dataset.id || current.checksum !== dataset.checksum)
        out.push(
          unavailable(`postflop_v31:${dataset.id}`, 'promoted dataset differs or is absent')
        );
      else out.push(available(`postflop_v31:${dataset.id}`, dataset.checksum));
    }
  }
  return out;
}
