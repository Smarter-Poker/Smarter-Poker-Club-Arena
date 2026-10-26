/** Full finite accepted-commit/immutable-played intersection census. Caller
 * cases, page JSON, digests and qualification flags cannot mint this brand. */
import { createHash } from 'node:crypto';
import { horseCompletedHandKey } from '../../engine/HorseDecisionHandBinding.js';
import {
  horseJournalJson,
  journalHash,
  validateHorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../horseDecisionJournal/review.js';
import { createAcceptedSourceRowsReader } from '../horseDailyCorrectiveReview/source.js';
import { acceptedSourceHandKey } from '../horseDailyCorrectiveReview/mapping.js';
import {
  readAcceptedRosterReturn,
  ACCEPTED_ROSTER_PRODUCER_VERSION,
} from '../horseAcceptedRoster/acceptance.js';
import { createRiverAcceptedWindowReader } from './riverAcceptedWindow.js';
import { rebuildCorrectiveSourceCustody } from './kernelReviewInput.js';
import {
  isAuthenticatedCorrectivePredeclaration,
  type CorrectivePredeclaration,
} from './kernelPredeclaration.js';
import {
  correctiveDecisionDomain,
  correctiveDomainIsValid,
  type CorrectiveReferenceDomain,
} from './domain.js';
import { correctiveRiverSnapshotRefusal } from './kernelEligibility.js';
import {
  resolveKernelOriginalInput,
  kernelReconciledExecutionDisposition,
} from './kernelOriginalInput.js';
import { buildFunctionalRiverDecision as buildOriginalRiverDecision } from './kernelModel.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelObjectiveIsKnown,
  tournamentKernelDefinitionFor,
} from './kernelTournamentDefinition.js';
import { classifyTournamentRiverSnapshot } from './kernelTournamentEligibility.js';
import type { RiverAcceptedOracleRequest } from './riverAcceptedOracle.js';
import { evidenceDigest } from './authority.js';
import {
  createAuthenticatedHorseJournalReader,
  isAuthenticatedHorseJournalBatch,
} from './journalTransport.js';
import {
  currentHorseDecisionRuntime,
  sameHorseDecisionRuntime,
} from '../../engine/horseDecision/replayState.js';

const verified = new WeakSet<object>();
export const RIVER_SOURCE_POPULATION_VERSION = 'horse-river-source-population-v1' as const;
export interface RiverSourcePopulation {
  version: typeof RIVER_SOURCE_POPULATION_VERSION;
  status: 'source_population_verified';
  predeclarationDigest: string;
  planDigest: string;
  censusDigest: string;
  windowDigest: string;
  requestsDigest: string;
  sourceRelease: string;
  acceptedHands: number;
  eligibleCases: number;
  exclusions: Readonly<Record<string, number>>;
  requests: readonly RiverAcceptedOracleRequest[];
  sourcePopulationVerified: true;
  qualified: false;
  completePopulation: false;
  activationAllowed: false;
}
export type RiverSourcePopulationResult =
  | Readonly<RiverSourcePopulation>
  | Readonly<{
      version: typeof RIVER_SOURCE_POPULATION_VERSION;
      status: 'unavailable';
      reason: string;
      acceptedHands: number;
      eligibleCases: number;
      exclusions: Readonly<Record<string, number>>;
      qualified: false;
      completePopulation: false;
      activationAllowed: false;
    }>;
export function isVerifiedRiverSourcePopulation(
  value: unknown
): value is Readonly<RiverSourcePopulation> {
  return !!value && typeof value === 'object' && verified.has(value);
}
/** Ordered exact request commitment without treating a whole case as one
 * single journal record. Validated record digests bind their full bytes. */
export function riverSourceRequestsDigest(requests: readonly RiverAcceptedOracleRequest[]): string {
  const hash = createHash('sha256').update('source-population-requests-v1\0');
  for (const request of requests)
    hash.update('\n').update(
      evidenceDigest({
        handKey: request.handKey,
        inputDigest: evidenceDigest({
          ...request.input,
          original: {
            snapshotDigest: evidenceDigest(request.input.original.snapshot),
            readFrameDigest: evidenceDigest(request.input.original.readFrame),
          },
        }),
        recordDigests: request.records.map((record) => record.sha256),
      })
    );
  return hash.digest('hex');
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function milliseconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
/** Builds its own configured readers, including the authenticated remote canonical
 * journal owner. No injected case/page list or source access override exists. */
export function createRiverSourcePopulationReviewer(
  environment: Readonly<Record<string, string | undefined>>
) {
  const windows = createRiverAcceptedWindowReader(environment),
    source = createAcceptedSourceRowsReader(environment),
    journal = createAuthenticatedHorseJournalReader(environment);
  let busy = false;
  return async (
    predeclaration: Readonly<CorrectivePredeclaration>
  ): Promise<RiverSourcePopulationResult> => {
    let acceptedHands = 0,
      eligibleCases = 0;
    const exclusions: Record<string, number> = {};
    const no = (reason: string): RiverSourcePopulationResult =>
      Object.freeze({
        version: RIVER_SOURCE_POPULATION_VERSION,
        status: 'unavailable',
        reason,
        acceptedHands,
        eligibleCases,
        exclusions: Object.freeze({ ...exclusions }),
        qualified: false,
        completePopulation: false,
        activationAllowed: false,
      });
    if (busy) return no('population_already_running');
    if (!isAuthenticatedCorrectivePredeclaration(predeclaration))
      return no('population_predeclaration_or_journal_refused');
    const plan = predeclaration.plan,
      tournament = tournamentKernelObjectiveIsKnown(plan.objective),
      domain = (plan as typeof plan & { domain?: CorrectiveReferenceDomain }).domain;
    if (
      plan.populationBasis !== 'accepted-commit-and-immutable-played-v1' ||
      !correctiveDomainIsValid(domain) ||
      (tournament
        ? !tournamentKernelDefinitionFor(plan.objective, domain)
        : domain.mode !== 'cash' || domain.format !== 'cash') ||
      plan.evidenceClass !== 'reviewed_reference' ||
      plan.familySize < 45
    )
      return no('population_locked_domain_refused');
    const exclude = (reason: string) => {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    };
    const starts = Date.parse(plan.holdoutStartsAt),
      ends = Date.parse(plan.holdoutEndsAt);
    const census = createHash('sha256')
        .update(RIVER_SOURCE_POPULATION_VERSION + '\0')
        .update(predeclaration.custodyDigest),
      chain = createHash('sha256').update('accepted-window-chain-v1\0');
    const requests: RiverAcceptedOracleRequest[] = [];
    const seenHands = new Set<string>(),
      seenDecisions = new Set<string>();
    let bytes = 0;
    busy = true;
    try {
      let after: null | { committedAt: string; handId: string } = null,
        exhausted = false;
      for (let pageIndex = 0; pageIndex < 79; pageIndex++) {
        const page = await windows({
          startsAt: plan.holdoutStartsAt,
          endsAt: plan.holdoutEndsAt,
          after,
        });
        if (
          page.status !== 'accepted_window_page' ||
          page.startsAt !== plan.holdoutStartsAt ||
          page.endsAt !== plan.holdoutEndsAt ||
          horseJournalJson(page.after) !== horseJournalJson(after)
        )
          return no('population_window_unavailable');
        chain.update('\n').update(page.pageDigest);
        const requestedJournalKeys: string[] = [];
        const prepared: Array<{
          coordinate: (typeof page.keys)[number];
          raw: import('../horseDailyCorrectiveReview/selection.js').AcceptedSourceRow;
          key: { coordinate: string; handKey: string };
          actors: import('../horseAcceptedRoster/contract.js').AcceptedRosterActor[];
          horses: Set<string>;
        }> = [];
        // Authenticate and classify EVERY accepted key before asking for any
        // private journal. Outside-intersection rows cannot poison that batch.
        for (const coordinate of page.keys) {
          acceptedHands++;
          if (acceptedHands > 10000 || seenHands.has(coordinate.handId))
            return no('population_window_bound_or_duplicate');
          seenHands.add(coordinate.handId);
          census.update('\n').update(evidenceDigest(coordinate));
          if (coordinate.gaps.length) return no('population_accepted_key_gap');
          const fetched = await source([
            { handId: coordinate.handId, tableId: coordinate.tableId },
          ]);
          const found = fetched.get(coordinate.handId);
          if (fetched.size !== 1 || !found) return no('population_source_missing_or_pruned');
          const raw = found.row;
          if (
            raw.hand_id !== coordinate.handId ||
            raw.table_id !== coordinate.tableId ||
            raw.hand_number !== coordinate.handNumber ||
            raw.atomic_hand_id !== coordinate.handId ||
            raw.atomic_table_id !== coordinate.tableId ||
            raw.atomic_hand_number !== coordinate.handNumber ||
            raw.payload_digest !== coordinate.payloadDigest ||
            raw.core_payload_digest !== coordinate.coreDigest ||
            milliseconds(raw.committed_at) !== milliseconds(coordinate.committedAt) ||
            typeof raw.payload_text !== 'string' ||
            journalHash(raw.payload_text) !== coordinate.payloadDigest ||
            typeof raw.roster_text !== 'string' ||
            journalHash(raw.roster_text) !== coordinate.rosterDigest ||
            raw.roster_status !== 'captured' ||
            raw.roster_producer_version !== ACCEPTED_ROSTER_PRODUCER_VERSION ||
            raw.roster_payload_digest !== coordinate.payloadDigest
          )
            return no('population_source_pin_mismatch');
          const roster = readAcceptedRosterReturn(
            {
              version: 1,
              status: 'captured',
              reasons: [],
              payloadDigest: raw.payload_digest,
              producerVersion: raw.roster_producer_version,
              roster: JSON.parse(raw.roster_text),
            },
            {
              tableId: coordinate.tableId,
              handNumber: Number(coordinate.handNumber),
              historyId: coordinate.handId,
              payloadDigest: raw.payload_digest!,
            }
          );
          if (
            roster.status !== 'captured' ||
            roster.transport.roster.actors.some((a) => a.classification === 'unknown')
          )
            return no('population_roster_unknown');
          const actors = roster.transport.roster.actors,
            horses = new Set(
              actors.filter((a) => a.classification === 'horse').map((a) => a.userId)
            );
          // Scope exclusions are derived from authenticated acceptance, not outcomes.
          if (tournament ? raw.tournament_id === null : raw.tournament_id !== null) {
            exclude(tournament ? 'cash_hand' : 'non_cash_hand');
            continue;
          }
          if (raw.game_variant !== domain.variant) {
            exclude('other_variant');
            continue;
          }
          if (horses.size === 0) {
            exclude('human_only_hand');
            continue;
          }
          if (actors.length !== 2) {
            exclude('non_heads_up_hand');
            continue;
          }
          const payload: unknown = JSON.parse(raw.payload_text);
          const stats =
            object(payload) && object(payload.accepted_hand_facts)
              ? payload.accepted_hand_facts.stats_facts
              : null;
          if (
            !object(stats) ||
            ![1, 2].includes(Number(stats.version)) ||
            typeof stats.version !== 'number' ||
            !Array.isArray(stats.facts) ||
            stats.facts.length < 1 ||
            stats.facts.length > 10
          )
            return no('population_immutable_played_time_missing');
          const factActors = new Set<string>();
          for (const fact of stats.facts) {
            if (!object(fact) || typeof fact.user_id !== 'string' || factActors.has(fact.user_id))
              return no('population_stats_scope_conflict');
            factActors.add(fact.user_id);
            const actor = actors.find((a) => a.userId === fact.user_id);
            if (
              !actor ||
              fact.hand_id !== coordinate.handId ||
              fact.table_id !== coordinate.tableId ||
              fact.seat !== actor.seat ||
              fact.game_variant !== raw.game_variant ||
              fact.big_blind !== Number(raw.big_blind) ||
              fact.tournament_id !== raw.tournament_id
            )
              return no('population_stats_scope_conflict');
          }
          if (
            factActors.size !== actors.length ||
            actors.some((actor) => !factActors.has(actor.userId))
          )
            return no('population_stats_actor_coverage_gap');
          const times = stats.facts.map((f) => (object(f) ? milliseconds(f.played_at) : null));
          if (times.some((t) => t === null || t !== times[0]))
            return no('population_immutable_played_time_conflict');
          if (times[0]! < starts || times[0]! >= ends) {
            exclude('outside_immutable_played_interval');
            continue;
          }
          const key = acceptedSourceHandKey(
            coordinate.tableId,
            raw.hand_number,
            found.leaseGeneration
          );
          if ('reason' in key) return no('population_submission_lease_unavailable');
          if (plan.selectionHandKeys.includes(key.handKey))
            return no('population_training_overlap');
          requestedJournalKeys.push(key.handKey);
          prepared.push({ coordinate, raw, key, actors, horses });
        }
        const journalRecords = new Map<
          string,
          readonly import('../horseDecisionJournal/record.js').HorseJournalRecord[]
        >();
        if (requestedJournalKeys.length) {
          if (new Set(requestedJournalKeys).size !== requestedJournalKeys.length)
            return no('population_duplicate_journal_key');
          const batch = await journal(requestedJournalKeys);
          if (
            !isAuthenticatedHorseJournalBatch(batch) ||
            batch.sourceRelease !== plan.sourceRelease ||
            !sameHorseDecisionRuntime(batch.runtime, currentHorseDecisionRuntime()) ||
            batch.recordsByHand.length !== requestedJournalKeys.length
          )
            return no('population_authenticated_journal_unavailable');
          for (let i = 0; i < requestedJournalKeys.length; i++) {
            const hand = batch.recordsByHand[i];
            if (hand.handKey !== requestedJournalKeys[i] || journalRecords.has(hand.handKey))
              return no('population_authenticated_journal_join_mismatch');
            journalRecords.set(hand.handKey, hand.records);
          }
          census.update('\n').update(batch.batchDigest);
        }
        for (const { coordinate, raw, key, actors, horses } of prepared) {
          const read = journalRecords.get(key.handKey) ?? [];
          if (read.length < 1 || read.length > 256) return no('population_journal_bounds');
          const journalEvents = new Map<string, string>();
          const records = [
            ...new Map(
              read.map((r) => {
                validateHorseJournalRecord(r);
                const prior = journalEvents.get(r.eventId);
                if (prior && prior !== r.sha256) throw Error('journal_event_conflict');
                journalEvents.set(r.eventId, r.sha256);
                if (r.handKey !== key.handKey || r.sourceRelease !== plan.sourceRelease)
                  throw Error();
                return [r.eventId, r] as const;
              })
            ).values(),
          ];
          bytes += records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
          if (bytes > 256 * 1024 * 1024) return no('population_journal_budget');
          const accepted = records.filter((r) => r.kind === 'accepted_hand');
          if (accepted.length !== 1) return no('population_accepted_journal_ambiguous');
          const observation = JSON.parse(accepted[0].body);
          if (
            observation.committedHandId !== coordinate.handId ||
            horseCompletedHandKey(observation) !== key.coordinate
          )
            return no('population_accepted_journal_mismatch');
          const custody = rebuildCorrectiveSourceCustody(records, key.handKey, accepted[0].sha256, [
            raw,
          ]);
          if (custody.status !== 'reconstructed_unsigned')
            return no('population_source_custody_refused');
          const reconciled = reconcileHorseJournalHand(records, key.handKey);
          if (
            reconciled.status !== 'reconciled' ||
            !reconciled.requestLifecycleVerified ||
            reconciled.gaps.length
          )
            return no('population_journal_coverage_gap');
          let handCases = 0;
          for (const decision of records.filter((r) => r.kind === 'decision')) {
            const executions = records.filter(
              (r) =>
                r.kind === 'execution' &&
                r.turnKey === decision.turnKey &&
                r.producerId === decision.producerId
            );
            if (executions.length !== 1) return no('population_execution_ambiguous');
            const disposition = kernelReconciledExecutionDisposition(executions[0]);
            if (disposition === 'retired') {
              exclude('retired_not_executed_decision');
              continue;
            }
            if (disposition !== 'accepted') return no('population_execution_not_intended');
            const resolved = resolveKernelOriginalInput(
              records,
              decision,
              executions[0],
              accepted[0]
            );
            if (resolved.status !== 'resolved')
              return no('population_kernel_original_unavailable:' + resolved.reason);
            const capture = resolved.original;
            if (!capture.snapshot || !capture.snapshot.player || !capture.snapshot.gameState)
              return no('population_original_snapshot_missing');
            if (
              !Array.isArray(capture.snapshot.gameState.players) ||
              capture.snapshot.gameState.players.length !== actors.length ||
              capture.snapshot.gameState.players.some(
                (p) => !actors.some((a) => a.userId === p.user_id && a.seat === p.seat)
              )
            )
              return no('population_original_roster_mismatch');
            const actor = actors.find((a) => a.userId === capture.snapshot.player.user_id);
            if (!actor || actor.seat !== capture.snapshot.player.seat)
              return no('population_original_actor_mismatch');
            if (!horses.has(actor.userId)) {
              exclude('human_decision');
              continue;
            }
            const originalDomain = correctiveDecisionDomain(capture.snapshot.gameState);
            if (!originalDomain || originalDomain.variant !== domain.variant)
              return no('population_original_domain_mismatch');
            if (
              tournament &&
              capture.snapshot.gameState.tournament?.tournamentId !== raw.tournament_id
            )
              return no('population_original_tournament_mismatch');
            if (tournament && originalDomain.format !== domain.format) {
              exclude('other_tournament_format');
              continue;
            }
            if (evidenceDigest(originalDomain) !== evidenceDigest(domain))
              return no('population_original_domain_mismatch');
            const classified = tournament
              ? classifyTournamentRiverSnapshot(capture.snapshot)
              : null;
            if (classified?.status === 'gap')
              return no('population_original_model_gap:' + classified.reason);
            const refusal =
              classified?.status === 'excluded'
                ? classified.reason
                : tournament
                  ? null
                  : correctiveRiverSnapshotRefusal(capture.snapshot);
            if (refusal === 'original_model_metadata_unavailable')
              return no('population_original_model_gap');
            if (refusal) {
              exclude(refusal);
              continue;
            }
            const model = buildOriginalRiverDecision({
              snapshot: capture.snapshot,
              readFrame: capture.readFrame,
            });
            if (model.status !== 'built') return no('population_original_model_gap');
            if (model.input.domain.variant !== domain.variant)
              return no('population_original_domain_mismatch');
            if (seenDecisions.has(decision.sha256)) return no('population_duplicate_decision');
            seenDecisions.add(decision.sha256);
            handCases++;
            eligibleCases++;
            if (handCases > 1 || eligibleCases > 10000)
              return no('population_multiple_eligible_hand_or_bound');
            const input = {
              ...model.input,
              finalRake: model.prices.finalRake,
              evidenceClass: plan.evidenceClass,
              sourceId: 'accepted-window:' + coordinate.handId,
              qualificationId: plan.qualificationId,
              producerDigest: plan.producerDigest,
              binding: resolved.binding,
            };
            const request = { records, handKey: key.handKey, input };
            requests.push(request);
            census.update('\n').update(
              evidenceDigest({
                decision: decision.sha256,
                execution: executions[0].sha256,
                accepted: accepted[0].sha256,
                custody: custody.custodyDigest,
                input,
              })
            );
          }
          if (handCases === 0) exclude('no_original_family_decision');
        }
        if (!page.hasMore) {
          exhausted = true;
          break;
        }
        if (!page.next || horseJournalJson(page.next) === horseJournalJson(after))
          return no('population_cursor_gap');
        after = { ...page.next };
      }
      if (!exhausted) return no('population_page_budget');
      if (eligibleCases < plan.minimumSamples) return no('population_sample_count');

      const result = freeze({
        version: RIVER_SOURCE_POPULATION_VERSION,
        status: 'source_population_verified' as const,
        predeclarationDigest: predeclaration.custodyDigest,
        planDigest: evidenceDigest(plan),
        sourceRelease: plan.sourceRelease,
        censusDigest: census.digest('hex'),
        windowDigest: chain.digest('hex'),
        requestsDigest: riverSourceRequestsDigest(requests),
        acceptedHands,
        eligibleCases,
        exclusions,
        requests,
        sourcePopulationVerified: true as const,
        qualified: false as const,
        completePopulation: false as const,
        activationAllowed: false as const,
      });
      verified.add(result);
      return result;
    } catch {
      return no('population_source_or_journal_unavailable');
    } finally {
      busy = false;
    }
  };
}
