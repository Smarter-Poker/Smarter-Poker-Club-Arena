/**
 * Phase 6C step (b): rebuild the exact original input of one journaled Horse
 * decision from its journal record, or refuse with a named reason.
 *
 * Nothing here substitutes a default. A field the journal does not carry is a
 * refusal (`replay_input_incomplete:<field>`), because a replay of a guessed
 * input is not a replay of the decision.
 */
import type { HorseDecision } from '../../../types.js';
import type { HorseDecisionReadFrame } from '../../HorseDecisionReadFrame.js';
import type { HorsePlanContext } from '../../HorsePlanHandIdentity.js';
import {
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { buildHorseDecisionKey, type FastHorseDecisionRequest } from '../protocol.js';
import {
  isHorseSolverStoreIdentity,
  type HorseSolverStoreIdentity,
} from '../../../gto/SolverStoreIdentity.js';

export class HorseReplayRefusal extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'HorseReplayRefusal';
  }
}

export interface HorseReplaySolverReadiness {
  solverStores: {
    charts: number;
    postflop: number;
    postflopV31: number;
    postflopV31Dataset: { id: string; checksum: string } | null;
  };
  solverPolicyArtifact: {
    policyVersion?: string;
    schemaSha256?: string;
    totalPolicies?: number;
    external?: { count?: number };
    charts?: { loadedAt?: string | null };
  };
  /** Content identity of the stores, journaled by workers that carry Phase 6C G4; absent before. */
  solverStoreIdentity?: HorseSolverStoreIdentity;
}

/** The exact original input of one journaled FAST decision, plus what it produced. */
export interface HorseReplayInput {
  decisionId: string;
  recordedRelease: string | null;
  atMs: number;
  request: FastHorseDecisionRequest;
  readFrame: HorseDecisionReadFrame;
  rngBefore: number;
  rngAfter: number;
  governorScale: number;
  computeMs: number;
  original: HorseDecision;
  planContext: HorsePlanContext;
  readiness: HorseReplaySolverReadiness;
}

const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const uint32 = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
function refuse(field: string): never {
  throw new HorseReplayRefusal(`replay_input_incomplete:${field}`);
}

/** Parse a journal record; the record's own digest must hold before its body is trusted. */
export function parseHorseJournalRecord(raw: unknown): HorseJournalRecord {
  try {
    validateHorseJournalRecord(raw);
  } catch {
    return refuse('record');
  }
  return raw;
}

export function reconstructHorseReplayInput(raw: unknown): HorseReplayInput {
  const record = parseHorseJournalRecord(raw);
  if (record.kind !== 'decision') refuse('kind');
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch {
    refuse('body');
  }
  if (!obj(body)) refuse('body');
  const b = body as Record<string, unknown>;
  if (b.lifecycleVersion !== 1) refuse('lifecycle_version');
  const snapshot = b.snapshot;
  if (!obj(snapshot)) refuse('snapshot');
  if (snapshot.type !== 'DECIDE_FAST') {
    // A DEEP second look borrows the FAST decision's stream and read frame; it
    // is not an original decision and this protocol does not replay it.
    throw new HorseReplayRefusal(`replay_unsupported:${String(snapshot.type)}`);
  }
  if (!Number.isSafeInteger(snapshot.requestId) || (snapshot.requestId as number) <= 0)
    refuse('request_id');
  if (!Number.isSafeInteger(snapshot.generation) || typeof snapshot.fence !== 'string')
    refuse('fence');
  if (!Number.isFinite(snapshot.decisionTimeMs)) refuse('decision_time');
  if (
    typeof snapshot.decisionKey !== 'string' ||
    !/^phase5-v1:[0-9a-f]{64}$/.test(snapshot.decisionKey)
  )
    refuse('decision_key');
  // Actor
  const player = snapshot.player;
  if (
    !obj(player) ||
    !Number.isInteger(player.seat) ||
    typeof player.user_id !== 'string' ||
    !Array.isArray(player.cards)
  )
    refuse('actor');
  // Persona and profile: the journal carries both as the worker received them.
  if (typeof snapshot.style !== 'string') refuse('persona');
  if (!obj(snapshot.mods)) refuse('profile');
  // Public history and field
  const gs = snapshot.gameState;
  if (!obj(gs) || gs.stateSchemaVersion !== 1) refuse('state');
  if (!Array.isArray(gs.actionHistory)) refuse('public_history');
  if (!Array.isArray(gs.players) || gs.players.length === 0 || !Array.isArray(gs.dealtSeatIds))
    refuse('field');
  const tournamentMode = gs.gameMode === 'tournament';
  if (tournamentMode) {
    const t = gs.tournament;
    if (!obj(t) || t.schemaVersion !== 1) refuse('field');
    const provenance = t.contextProvenance;
    // Source: the exact cache generation the decision read (a null source is a
    // recorded fact of the read; a missing provenance record is not).
    if (!obj(provenance) || provenance.version !== 1 || !('source' in provenance)) refuse('source');
    if (gs.stage === 'preflop') {
      const m = t.m;
      if (
        !obj(m) ||
        m.schemaVersion !== 1 ||
        typeof t.contextStatus !== 'string' ||
        typeof t.anteType !== 'string'
      )
        refuse('atlas');
    }
  }
  // Solver store identity the worker reported beside the decision.
  const readiness = b.readiness;
  if (
    !obj(readiness) ||
    !obj(readiness.solverStores) ||
    !obj(readiness.solverPolicyArtifact) ||
    !Number.isSafeInteger(readiness.solverStores.charts) ||
    !Number.isSafeInteger(readiness.solverStores.postflop) ||
    !Number.isSafeInteger(readiness.solverStores.postflopV31) ||
    // Absent on records made before the identity was journaled; malformed is never trusted.
    (readiness.solverStoreIdentity !== undefined &&
      !isHorseSolverStoreIdentity(readiness.solverStoreIdentity))
  )
    refuse('solver_stores');
  // RNG stream
  if (!uint32(b.rngBefore) || !uint32(b.rngAfter)) refuse('rng');
  if (typeof b.governorScale !== 'number' || !(b.governorScale > 0) || b.governorScale > 1)
    refuse('governor');
  if (typeof b.computeMs !== 'number' || !Number.isFinite(b.computeMs)) refuse('compute_ms');
  // Opponent reads the decision saw (private read frame captured beside it).
  const frame = b.readFrame;
  if (
    !obj(frame) ||
    typeof frame.version !== 'string' ||
    !frame.version.startsWith('horse-decision-reads-') ||
    typeof frame.json !== 'string' ||
    typeof frame.sha256 !== 'string' ||
    !Number.isSafeInteger(frame.bytes)
  )
    refuse('read_frame');
  const decision = b.decision;
  if (!obj(decision) || typeof decision.action !== 'string') refuse('decision');
  if (!obj(b.planContext)) refuse('plan_context');
  // The digest that bound the worker's validation must bind this exact input.
  const request = snapshot as unknown as FastHorseDecisionRequest;
  let expectedKey: string;
  try {
    expectedKey = buildHorseDecisionKey(request);
  } catch {
    return refuse('decision_key');
  }
  if (expectedKey !== request.decisionKey) refuse('decision_key');
  return {
    decisionId: record.eventId,
    recordedRelease: record.sourceRelease,
    atMs: record.atMs,
    request,
    readFrame: frame as unknown as HorseDecisionReadFrame,
    rngBefore: b.rngBefore as number,
    rngAfter: b.rngAfter as number,
    governorScale: b.governorScale as number,
    computeMs: b.computeMs as number,
    original: decision as unknown as HorseDecision,
    planContext: b.planContext as unknown as HorsePlanContext,
    readiness: readiness as unknown as HorseReplaySolverReadiness,
  };
}
