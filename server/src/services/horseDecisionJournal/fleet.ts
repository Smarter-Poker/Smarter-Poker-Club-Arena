import { performance } from 'node:perf_hooks';
import { horseJournalArchiveDirectoryNames, readonlyHorseJournalStoreOptions } from './config.js';
import { HorseDecisionJournalStore } from './store.js';
import { reconcileHorseJournalHand, reviewHorsePlanEffects } from './review.js';
import {
  HorseFleetPhaseInterpreter,
  HORSE_PHASE_KEYS,
  HORSE_PHASE_STATUS_ORDER,
  type HorsePhaseCapture,
} from './phaseProof.js';
import {
  horseJournalJson,
  journalHash,
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from './record.js';
import { bindHorseDecisionToCommittedHand } from '../../engine/HorseDecisionHandBinding.js';
import type { HorseExecutionWitness } from '../../engine/HorseExecutionWitness.js';
import type {
  CompletedHandObservation,
  FastHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';

/** Selection belongs to the trusted accepted-hand owner, not this observer.
 * This packet is a finite selection, never an assertion of complete capture. */
export const HORSE_FLEET_READ_LIMITS = Object.freeze({
  shards: 32,
  hands: 10_000,
  validatedBytes: 64 * 1024 * 1024,
  elapsedMs: 30_000,
});
export interface HorseFleetPacket {
  version: 1;
  sourceSha: string;
  window: { startUtc: string; endUtc: string };
  horseIds: string[];
  handKeys: string[];
}
export function validateHorseFleetPacket(value: unknown): HorseFleetPacket {
  const p = value as HorseFleetPacket;
  const utc = (s: unknown): s is string =>
    typeof s === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === s;
  if (
    !p ||
    p.version !== 1 ||
    !/^[0-9a-f]{40}$/.test(p.sourceSha ?? '') ||
    !utc(p.window?.startUtc) ||
    !utc(p.window?.endUtc) ||
    Date.parse(p.window.endUtc) <= Date.parse(p.window.startUtc) ||
    Date.parse(p.window.endUtc) - Date.parse(p.window.startUtc) > 86_400_000 ||
    !Array.isArray(p.horseIds) ||
    p.horseIds.length !== 1000 ||
    p.horseIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ) ||
    new Set(p.horseIds).size !== 1000 ||
    !Array.isArray(p.handKeys) ||
    p.handKeys.length < 1 ||
    p.handKeys.length > HORSE_FLEET_READ_LIMITS.hands ||
    p.handKeys.some((key) => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) ||
    new Set(p.handKeys).size !== p.handKeys.length
  )
    throw Error('Invalid fleet packet');
  return p;
}

/** Read every listed shard. Exact record retries do not create another action;
 * cross-shard conflicting event IDs are refused rather than choosing a winner.
 * Per-hand record/byte bounds remain the existing reader's bounds. */
export interface HorseFleetReadBudget {
  validatedBytes: number;
  started: number;
}
/** Every validated record costs bytes, including exact retry copies in another
 * catalog. Counters survive a refusal so the caller cannot restart the budget. */
export function chargeHorseFleetReadBudget(budget: HorseFleetReadBudget, bytes: number) {
  budget.validatedBytes += bytes;
  if (
    budget.validatedBytes > HORSE_FLEET_READ_LIMITS.validatedBytes ||
    performance.now() - budget.started >= HORSE_FLEET_READ_LIMITS.elapsedMs
  )
    throw Error('bound_reached');
}
function readFleetHand(
  stores: readonly HorseDecisionJournalStore[],
  handKey: string,
  budget: HorseFleetReadBudget
) {
  const records = new Map<string, HorseJournalRecord>();
  let uniqueBytes = 0;
  for (const store of stores) {
    chargeHorseFleetReadBudget(budget, 0);
    for (const record of store.readHand(handKey)) {
      chargeHorseFleetReadBudget(budget, 0);
      validateHorseJournalRecord(record);
      const encoded = horseJournalJson(record);
      const bytes = Buffer.byteLength(encoded);
      chargeHorseFleetReadBudget(budget, bytes);
      const previous = records.get(record.eventId);
      if (previous && horseJournalJson(previous) !== encoded) throw Error('record_conflict');
      if (previous) continue;
      uniqueBytes += bytes;
      if (records.size >= 256 || uniqueBytes > 8 * 1024 * 1024) throw Error('hand_bound_reached');
      records.set(record.eventId, record);
    }
  }
  return [...records.values()];
}

export function readHorseJournalFleet(directory: string, input: unknown) {
  const packet = validateHorseFleetPacket(input);
  const start = Date.parse(packet.window.startUtc),
    end = Date.parse(packet.window.endUtc);
  const horses = new Map(
    packet.horseIds.map((horseId) => [
      horseId,
      {
        horseId,
        acceptedDecisions: 0,
        applicability: 'unobserved' as 'unobserved' | 'accepted_decision_observed',
        // Receipt presence is not qualification of a phase, strategy or source gate.
        phaseCoverage: 'unknown' as const,
        retainedReceiptCounts: {} as Record<string, number>,
        phaseStatusCounts: {} as Record<string, number[]>,
        phaseAcceptedApplications: {} as Record<string, number>,
      },
    ])
  );
  const phaseEvidence = Object.fromEntries(
    HORSE_PHASE_KEYS.map((key) => [
      key,
      {
        capability: {} as Record<string, number>,
        eligibility: {} as Record<string, number>,
        qualification: {} as Record<string, number>,
        application: {} as Record<string, number>,
        reasons: {} as Record<string, number>,
      },
    ])
  );
  const gaps: Record<string, number> = {};
  const gap = (name: string) => {
    gaps[name] = (gaps[name] ?? 0) + 1;
  };
  const stores: HorseDecisionJournalStore[] = [];
  const budget: HorseFleetReadBudget = { started: performance.now(), validatedBytes: 0 };
  const phaseInterpreter = new HorseFleetPhaseInterpreter(() =>
    chargeHorseFleetReadBudget(budget, 0)
  );
  let inspectedHands = 0,
    boundReached = false;
  let reconciledHands = 0,
    acceptedDecisions = 0;
  try {
    const names = horseJournalArchiveDirectoryNames(directory);
    if (names.length > HORSE_FLEET_READ_LIMITS.shards) {
      boundReached = true;
      throw Error('bound_reached');
    }
    for (const name of names.length ? names : ['archive'])
      stores.push(
        new HorseDecisionJournalStore(directory, readonlyHorseJournalStoreOptions(directory, name))
      );
    for (const handKey of packet.handKeys) {
      if (
        performance.now() - budget.started >= HORSE_FLEET_READ_LIMITS.elapsedMs ||
        budget.validatedBytes >= HORSE_FLEET_READ_LIMITS.validatedBytes
      ) {
        boundReached = true;
        gap('bound_reached');
        break;
      }
      let records: readonly HorseJournalRecord[];
      try {
        records = readFleetHand(stores, handKey, budget);
        inspectedHands++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        if (reason === 'bound_reached') {
          boundReached = true;
          gap('bound_reached');
          break;
        }
        inspectedHands++;
        gap(
          ['record_conflict', 'hand_bound_reached'].includes(reason)
            ? reason
            : 'capture_unavailable'
        );
        continue;
      }
      const review = reconcileHorseJournalHand(records, handKey);
      if (review.status !== 'reconciled') {
        for (const reason of review.gaps) gap(reason);
        continue;
      }
      if (records.some((r) => r.sourceRelease !== packet.sourceSha)) {
        gap('source_mismatch');
        continue;
      }
      if (records.some((r) => r.atMs < start || r.atMs >= end)) {
        gap('capture_outside_window');
        continue;
      }
      const accepted = records.find((r) => r.kind === 'accepted_hand');
      if (!accepted) {
        gap('accepted_hand_missing');
        continue;
      }
      const hand: CompletedHandObservation = JSON.parse(accepted.body);
      const seen = new Set<number>();
      for (const record of records.filter((r) => r.kind === 'decision')) {
        const capture = JSON.parse(record.body) as { snapshot: FastHorseDecisionRequest };
        const request = capture.snapshot;
        if (request.decisionTimeMs < start || request.decisionTimeMs >= end) {
          gap('decision_outside_window');
          continue;
        }
        const execution = records.find(
          (r) =>
            r.kind === 'execution' &&
            r.turnKey === record.turnKey &&
            r.producerId === record.producerId
        );
        if (!execution) continue; // existing reconciliation already reports missing joins
        const witness = JSON.parse(execution.body) as HorseExecutionWitness;
        const binding = bindHorseDecisionToCommittedHand(witness, hand);
        if (binding.status !== 'bound' || seen.has(binding.actionOrdinal)) continue;
        const action = hand.actions?.[binding.actionOrdinal];
        if (action?.origin !== 'horse_policy' || action.userId !== request.player.user_id) continue;
        seen.add(binding.actionOrdinal);
        const horse = horses.get(action.userId);
        if (!horse) {
          gap('actor_outside_roster');
          continue;
        }
        for (const [phase, receipt] of Object.entries({
          phase6: witness.phase6Attribution,
          phase7: witness.phase7Evidence,
          phase8: witness.phase8GuardAuthority ?? witness.phase8Authority,
          phase10: witness.phase10Authority,
          phase11: witness.phase11Authority,
          phase12: witness.phase12Authority,
          phase13: witness.phase13Authority,
        }))
          if (receipt)
            horse.retainedReceiptCounts[phase] = (horse.retainedReceiptCounts[phase] ?? 0) + 1;
        const phaseProof = phaseInterpreter.interpret(
          JSON.parse(record.body) as HorsePhaseCapture,
          witness,
          reviewHorsePlanEffects(
            records.filter(
              (r) =>
                r.kind === 'accepted_hand' ||
                (r.turnKey === record.turnKey && r.producerId === record.producerId)
            ),
            handKey
          ),
          records
            .filter((r) => r.kind === 'decision' && r.producerId === record.producerId)
            .map(
              (r) =>
                ({
                  ...JSON.parse(r.body),
                  recordEnvelope: {
                    producerId: r.producerId,
                    sourceRelease: r.sourceRelease,
                    handKey: r.handKey,
                    sequence: r.sequence,
                  },
                }) as HorsePhaseCapture
            ),
          {
            producerId: record.producerId,
            sourceRelease: record.sourceRelease,
            handKey: record.handKey,
            sequence: record.sequence,
          }
        );
        for (const phase of HORSE_PHASE_KEYS) {
          const proof = phaseProof[phase]!;
          const counts =
            horse.phaseStatusCounts[phase] ?? Array(HORSE_PHASE_STATUS_ORDER.length).fill(0);
          counts[HORSE_PHASE_STATUS_ORDER.indexOf(proof.status)]!++;
          horse.phaseStatusCounts[phase] = counts;
          if (proof.application === 'accepted')
            horse.phaseAcceptedApplications[phase] =
              (horse.phaseAcceptedApplications[phase] ?? 0) + 1;
          const aggregate = phaseEvidence[phase]!;
          for (const axis of ['capability', 'eligibility', 'qualification', 'application'] as const)
            aggregate[axis][proof[axis]] = (aggregate[axis][proof[axis]] ?? 0) + 1;
          aggregate.reasons[proof.reason] = (aggregate.reasons[proof.reason] ?? 0) + 1;
        }
        horse.acceptedDecisions++;
        horse.applicability = 'accepted_decision_observed';
        acceptedDecisions++;
      }
      reconciledHands++;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'bound_reached') boundReached = true;
    gap(boundReached ? 'bound_reached' : 'storage_unavailable');
  } finally {
    for (const store of stores)
      try {
        store.close();
      } catch {
        gap('storage_close_unavailable');
      }
  }
  const observedHorses = [...horses.values()].filter((h) => h.acceptedDecisions > 0).length;
  return {
    version: 1,
    scope: 'selected_accepted_decision_capture',
    packetDigest: journalHash(horseJournalJson(packet)),
    sourceSha: packet.sourceSha,
    window: packet.window,
    selectedHands: packet.handKeys.length,
    inspectedHands,
    remainingHands: packet.handKeys.length - inspectedHands,
    validatedBytes: budget.validatedBytes,
    boundReached,
    captureUnfinished: boundReached,
    limits: HORSE_FLEET_READ_LIMITS,
    rosterAuthority: 'supplied_packet',
    rosterVerified: false,
    horseCoverageScope: 'supplied_cohort_only',
    reconciledHands,
    acceptedDecisions,
    rosterHorses: 1000,
    observedHorses,
    unobservedHorses: 1000 - observedHorses,
    completeHorseCoverage: observedHorses === 1000 && Object.keys(gaps).length === 0,
    completePopulation: false,
    replayVerified: false,
    gtoVerified: false,
    activationAllowed: false,
    phaseQualification: 'unknown',
    allPhasesVerified: false,
    phaseProofSchema: {
      version: 'horse-fleet-phase-proof-v1',
      statusOrder: HORSE_PHASE_STATUS_ORDER,
      counterUnit: 'selected_accepted_decisions',
      unobservedHorseMeaning: 'no_phase_proof_without_a_selected_accepted_decision',
    },
    phaseEvidence,
    phaseGates: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`phase${i + 1}`, 'unknown'])
    ),
    gaps,
    horses: [...horses.values()],
  };
}
