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
import { gtoChartCount, gtoChartStoreIdentity } from '../../GtoCharts.js';
import { gtoPostflopCount, gtoPostflopStoreIdentity } from '../../GtoPostflop.js';
import {
  sameSolverStoreIdentity,
  type HorseSolverStoreIdentity,
  type SolverStoreIdentity,
} from '../../../gto/SolverStoreIdentity.js';
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
  /** Content identity of the chart and open-node stores loaded into the replay. */
  identity?: HorseSolverStoreIdentity;
  /** Snapshots whose source is witnessed unchanged over a window (for count-only records). */
  pins?: { charts?: SolverStorePin; postflop?: SolverStorePin };
}

/**
 * A store snapshot pinned by identity for decisions whose record carries only
 * a row count (made before the worker journaled the store identity). The pin
 * says the source held exactly `identity` from `unchangedFromMs` through
 * `unchangedToMs`, on the evidence named in `witness`; a decision is matched
 * to it only if it was made inside that window by a release that cannot have
 * loaded its store before the window opened.
 */
export interface SolverStorePin {
  identity: SolverStoreIdentity;
  unchangedFromMs: number;
  unchangedToMs: number;
  witness: string;
}

export function currentReplaySolverStores(): ReplaySolverStores {
  return {
    charts: gtoChartCount(),
    postflop: gtoPostflopCount(),
    postflopV31: gtoPostflopV31Count(),
    postflopV31Dataset: gtoPostflopV31Dataset(),
    identity: { charts: gtoChartStoreIdentity(), postflop: gtoPostflopStoreIdentity() },
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
  /** When the original decision was made (journal atMs). */
  atMs?: number | null;
  /**
   * The earliest instant a process running the recorded release can have
   * started (its commit time); null when unknown. Only consulted for pins.
   */
  releaseNotBeforeMs?: number | null;
}

const short = (identity: SolverStoreIdentity | undefined | null): string =>
  identity ? `${identity.rows}@${identity.digest.slice(0, 12)}` : 'unknown';
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One store reference, decided by identity and never by size alone:
 *  - a record that journaled the store identity must meet a replay store with
 *    the same digest over the same entries;
 *  - a record that journaled a row count only is matched to a pinned snapshot
 *    whose window covers the decision and the release's whole lifetime;
 *  - an empty store is its own identity (0 recorded, 0 loaded).
 */
function storeReference(args: {
  ref: string;
  recordedCount: number;
  recordedIdentity: SolverStoreIdentity | undefined;
  replayCount: number;
  replayIdentity: SolverStoreIdentity | undefined;
  pin: SolverStorePin | undefined;
  atMs: number | null;
  releaseNotBeforeMs: number | null;
  recordedLoadedAt: string | null;
}): HorseReplayReference {
  const { ref } = args;
  if (args.recordedIdentity) {
    if (args.replayIdentity && sameSolverStoreIdentity(args.recordedIdentity, args.replayIdentity))
      return available(ref, `identity ${short(args.replayIdentity)}`);
    return unavailable(
      ref,
      `original identity ${short(args.recordedIdentity)}, replay ${short(args.replayIdentity)}`
    );
  }
  if (args.recordedCount === 0)
    return args.replayCount === 0
      ? available(ref, 'empty store, as recorded')
      : unavailable(ref, `original decided with an empty store; replay has ${args.replayCount}`);
  if (args.replayCount === 0)
    return unavailable(ref, `original decided with ${args.recordedCount} loaded; replay has none`);
  const pin = args.pin;
  if (!pin)
    return unavailable(
      ref,
      `original recorded a count only (${args.recordedCount}); no pinned snapshot`
    );
  if (!args.replayIdentity || !sameSolverStoreIdentity(pin.identity, args.replayIdentity))
    return unavailable(
      ref,
      `loaded store ${short(args.replayIdentity)} is not the pinned snapshot ${short(pin.identity)}`
    );
  if (pin.identity.rows !== args.recordedCount)
    return unavailable(
      ref,
      `original ${args.recordedCount} entries, pinned snapshot ${pin.identity.rows}`
    );
  if (args.atMs === null || args.atMs < pin.unchangedFromMs || args.atMs > pin.unchangedToMs)
    return unavailable(
      ref,
      `decision outside the pinned window ${iso(pin.unchangedFromMs)}..${iso(pin.unchangedToMs)}`
    );
  if (args.releaseNotBeforeMs === null || args.releaseNotBeforeMs < pin.unchangedFromMs)
    return unavailable(
      ref,
      'the recorded release may have loaded its store before the pinned window'
    );
  if (args.recordedLoadedAt !== null) {
    const loadedMs = Date.parse(args.recordedLoadedAt);
    if (
      !Number.isFinite(loadedMs) ||
      loadedMs < pin.unchangedFromMs ||
      loadedMs > pin.unchangedToMs
    )
      return unavailable(ref, `recorded load ${args.recordedLoadedAt} outside the pinned window`);
  }
  return available(ref, `pinned ${short(pin.identity)} (${pin.witness})`);
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
  const atMs = input.atMs ?? null;
  const releaseNotBeforeMs = input.releaseNotBeforeMs ?? null;
  const recordedIdentity = input.recorded.solverStoreIdentity;
  if (chartConsult) {
    const external = input.recorded.solverPolicyArtifact.external?.count ?? 0;
    if (external > 0)
      // An external policy file outranks the chart table; the replay does not load one.
      out.push(unavailable('chart_store', `original read ${external} external artifact policies`));
    else {
      const loadedAt = input.recorded.solverPolicyArtifact.charts?.loadedAt;
      out.push(
        storeReference({
          ref: 'chart_store',
          recordedCount: input.recorded.solverStores.charts,
          recordedIdentity: recordedIdentity?.charts,
          replayCount: stores.charts,
          replayIdentity: stores.identity?.charts,
          pin: stores.pins?.charts,
          atMs,
          releaseNotBeforeMs,
          recordedLoadedAt: typeof loadedAt === 'string' ? loadedAt : null,
        })
      );
    }
  }

  // Postflop stores: a hold'em heads-up open node may consult the warehouse.
  if (input.postflopStoreConsultPossible) {
    out.push(
      storeReference({
        ref: 'solver_store:postflop',
        recordedCount: input.recorded.solverStores.postflop,
        recordedIdentity: recordedIdentity?.postflop,
        replayCount: stores.postflop,
        replayIdentity: stores.identity?.postflop,
        pin: stores.pins?.postflop,
        atMs,
        releaseNotBeforeMs,
        recordedLoadedAt: null,
      })
    );
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
