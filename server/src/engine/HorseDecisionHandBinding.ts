import { createHash } from 'node:crypto';
import type { ActionRecord } from '../types.js';
import type { HorseExecutionWitness } from './HorseExecutionWitness.js';
import type {
  CompletedHandObservation,
  LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';

export type HorseHandBindingReason =
  | 'invalid_turn_identity'
  | 'missing_prior_actions'
  | 'invalid_prior_actions'
  | 'invalid_committed_identity'
  | 'hand_fence_mismatch'
  | 'execution_unavailable'
  | 'prior_actions_mismatch'
  | 'accepted_action_mismatch'
  | 'observation_identity_unavailable'
  | 'committed_identity_conflict'
  | 'multiple_decisions_for_action'
  | 'tracking_capacity'
  | 'tracking_expired';

export type HorseDecisionHandAnchor =
  | Readonly<{ status: 'unavailable'; reason: HorseHandBindingReason }>
  | Readonly<{
      status: 'anchored';
      tableId: string;
      handNumber: number;
      leaseGeneration: string;
      actorId: string;
      seat: number;
      actionOrdinal: number;
      priorActionsDigest: string;
      /** An original out-of-turn look may accept only an intended fold. */
      earlyLook?: true;
    }>;

export type HorseDecisionHandBinding =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'unavailable'; reason: HorseHandBindingReason }>
  | Readonly<{
      status: 'bound';
      committedHandId: string;
      observationId: string;
      actionOrdinal: number;
      sessionKey: string;
    }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ACTIONS = 4096;
const uint = (value: string): boolean =>
  /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
/** Current verified cash/tournament producers carry the exact database lease
 * UUID, using the same grammar as their claim readers. Positive int64 strings
 * remain readable for older retained evidence and fixtures only. A recognized
 * shape does not establish a current lease grant or production provenance. */
export function horseJournalLeaseIdentityIsValid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ||
      (/^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n))
  );
}
const unavailable = (reason: HorseHandBindingReason) =>
  Object.freeze({ status: 'unavailable' as const, reason });

export interface HorseHandJournalContext {
  readonly version: 1;
  readonly actionCount: number;
  readonly actionsDigest: string;
}

/** Private bookkeeping from the original host, never policy control or proof
 * of a current lease grant. The accepted producer still owns that authority. */
export interface HorseHandJournalCoordinate {
  readonly version: 1;
  readonly producer: 'lightning-v1';
  readonly tableId: string;
  readonly handNumber: number;
  readonly leaseGeneration: string;
  readonly look: 'turn' | 'early';
}

export function horseHandJournalCoordinateIsValid(
  value: unknown
): value is HorseHandJournalCoordinate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ['version', 'producer', 'tableId', 'handNumber', 'leaseGeneration', 'look'];
  return (
    Object.keys(v).length === keys.length &&
    keys.every((key) => Object.hasOwn(v, key)) &&
    v.version === 1 &&
    v.producer === 'lightning-v1' &&
    typeof v.tableId === 'string' &&
    UUID.test(v.tableId) &&
    typeof v.handNumber === 'number' &&
    Number.isSafeInteger(v.handNumber) &&
    v.handNumber > 0 &&
    typeof v.leaseGeneration === 'string' &&
    UUID.test(v.leaseGeneration) &&
    horseJournalLeaseIdentityIsValid(v.leaseGeneration) &&
    (v.look === 'turn' || v.look === 'early')
  );
}

export function captureLightningHorseJournalCoordinate(input: {
  tableId: string;
  handNumber: number;
  leaseGeneration: string | null | undefined;
  earlyLook?: boolean;
}): HorseHandJournalCoordinate | null {
  if (input.earlyLook !== undefined && typeof input.earlyLook !== 'boolean') return null;
  const coordinate = {
    version: 1,
    producer: 'lightning-v1',
    tableId: input.tableId,
    handNumber: input.handNumber,
    leaseGeneration: input.leaseGeneration,
    look: input.earlyLook ? 'early' : 'turn',
  };
  return horseHandJournalCoordinateIsValid(coordinate) ? Object.freeze(coordinate) : null;
}

export function horseHandJournalCoordinateKey(value: unknown): string | null {
  if (!horseHandJournalCoordinateIsValid(value)) return null;
  return JSON.stringify([
    value.version,
    value.producer,
    value.tableId.toLowerCase(),
    value.handNumber,
    value.leaseGeneration.toLowerCase(),
    value.look,
  ]);
}

/** Accept original Lightning transport and the canonical physical fence.
 * A later lease, turn counter or UUID cannot reconstruct absent provenance. */
export function horseDecisionHandCoordinates(snapshot: {
  fence: string;
  generation: number;
  player: { seat: number };
  handJournalCoordinate?: HorseHandJournalCoordinate | null;
}): { tableId: string; handNumber: number; leaseGeneration: string; earlyLook: boolean } | null {
  const parts = typeof snapshot.fence === 'string' ? snapshot.fence.split(':') : [];
  const [tableId, hand, seat, fourth, fifth] = parts;
  if (
    !UUID.test(tableId ?? '') ||
    !uint(hand ?? '') ||
    Number(hand) <= 0 ||
    !uint(seat ?? '') ||
    Number(seat) < 1 ||
    Number(seat) > 10 ||
    Number(seat) !== snapshot.player?.seat ||
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation < 0
  )
    return null;
  const coordinate = snapshot.handJournalCoordinate;
  if (coordinate !== undefined) {
    if (
      !horseHandJournalCoordinateIsValid(coordinate) ||
      coordinate.tableId.toLowerCase() !== tableId!.toLowerCase() ||
      coordinate.handNumber !== Number(hand)
    )
      return null;
    const original = uint(fourth ?? '') && Number(fourth) === snapshot.generation;
    const early =
      coordinate.look === 'early' && parts.length === 5 && fifth === 'early' && original;
    const turn =
      coordinate.look === 'turn' &&
      ((parts.length === 4 && original) ||
        (parts.length === 5 &&
          fourth?.toLowerCase() === coordinate.leaseGeneration.toLowerCase() &&
          uint(fifth ?? '') &&
          Number(fifth) === snapshot.generation));
    if (!early && !turn) return null;
    return {
      tableId: tableId!.toLowerCase(),
      handNumber: Number(hand),
      leaseGeneration: coordinate.leaseGeneration.toLowerCase(),
      earlyLook: early,
    };
  }
  if (
    parts.length !== 5 ||
    !horseJournalLeaseIdentityIsValid(fourth) ||
    !uint(fifth ?? '') ||
    Number(fifth) !== snapshot.generation
  )
    return null;
  return {
    tableId: tableId!.toLowerCase(),
    handNumber: Number(hand),
    leaseGeneration: fourth,
    earlyLook: false,
  };
}

/** The engine's accepted-history log also includes posts, antes and returns.
 * Capture its unfiltered prefix, not HandController.actionHistory.length. */
export function captureHorseHandJournalContext(
  actions: readonly unknown[]
): HorseHandJournalContext | null {
  const digest = horsePriorActionsDigest(actions);
  return digest
    ? Object.freeze({ version: 1, actionCount: actions.length, actionsDigest: digest })
    : null;
}

/** Only controller fields are compared. Public nodes, origin and observation
 * identity are attached by the accepted-hand producer after the live snapshot.
 * No card, hand-key guess, filtered action ordinal or wall-clock join is used. */
export function horsePriorActionsDigest(actions: readonly unknown[]): string | null {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return null;
  const material: unknown[] = [];
  for (const raw of actions) {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Partial<ActionRecord>;
    if (
      !Number.isInteger(a.seat) ||
      a.seat! < 1 ||
      a.seat! > 10 ||
      typeof a.userId !== 'string' ||
      !UUID.test(a.userId) ||
      typeof a.action !== 'string' ||
      a.action.length === 0 ||
      a.action.length > 32 ||
      typeof a.stage !== 'string' ||
      a.stage.length === 0 ||
      a.stage.length > 32 ||
      typeof a.amount !== 'number' ||
      !Number.isFinite(a.amount) ||
      a.amount < 0 ||
      !Number.isSafeInteger(a.timestamp) ||
      a.timestamp! < 0 ||
      (a.isFullRaise !== undefined && typeof a.isFullRaise !== 'boolean')
    )
      return null;
    const dead = (raw as { dead?: unknown }).dead;
    if (dead !== undefined && typeof dead !== 'boolean') return null;
    material.push([
      a.seat,
      a.userId.toLowerCase(),
      a.action,
      a.amount,
      a.stage,
      a.timestamp,
      a.isFullRaise ?? null,
      dead ?? null,
    ]);
  }
  return createHash('sha256')
    .update(JSON.stringify(['horse-action-prefix-v1', material]))
    .digest('hex');
}

/** Bind the exact live producer fence without changing it or the policy seed.
 * An unverified lease or legacy fixture is explicitly unavailable evidence. */
export function anchorHorseDecisionHand(
  snapshot: LiveHorseDecisionSnapshot
): HorseDecisionHandAnchor {
  const coordinate = horseDecisionHandCoordinates(snapshot);
  if (
    !coordinate ||
    typeof snapshot.player?.user_id !== 'string' ||
    !UUID.test(snapshot.player.user_id)
  )
    return unavailable('invalid_turn_identity');
  const context = snapshot.handJournalContext;
  if (!context) return unavailable('missing_prior_actions');
  if (
    Object.keys(context).sort().join(',') !== 'actionCount,actionsDigest,version' ||
    context.version !== 1 ||
    !Number.isSafeInteger(context.actionCount) ||
    context.actionCount < 0 ||
    context.actionCount > MAX_ACTIONS ||
    !SHA256.test(context.actionsDigest)
  )
    return unavailable('invalid_prior_actions');
  return Object.freeze({
    status: 'anchored',
    tableId: coordinate.tableId,
    handNumber: coordinate.handNumber,
    leaseGeneration: coordinate.leaseGeneration,
    actorId: snapshot.player.user_id.toLowerCase(),
    seat: snapshot.player.seat,
    actionOrdinal: context.actionCount,
    priorActionsDigest: context.actionsDigest,
    ...(coordinate.earlyLook ? { earlyLook: true as const } : {}),
  });
}

export function horseHandAnchorKey(
  anchor: Extract<HorseDecisionHandAnchor, { status: 'anchored' }>
): string {
  return `${anchor.tableId}:${anchor.handNumber}:${anchor.leaseGeneration}`;
}

export function horseCompletedHandKey(hand: CompletedHandObservation): string | null {
  const p = typeof hand.fence === 'string' ? hand.fence.split(':') : [];
  if (
    p.length !== 4 ||
    !UUID.test(p[0]!) ||
    !uint(p[1]!) ||
    Number(p[1]) <= 0 ||
    !horseJournalLeaseIdentityIsValid(p[2]) ||
    p[3] !== 'observe' ||
    hand.generation !== Number(p[1]) ||
    hand.handKey !== `${p[0]}:${p[1]}`
  )
    return null;
  return `${p[0]!.toLowerCase()}:${p[1]}:${p[2]}`;
}

/** Reconcile against the already accepted producer observation. A successful
 * result identifies an executed action, not its poker quality, durability of
 * this receipt, complete source coverage or authority to activate learning. */
export function bindHorseDecisionToCommittedHand(
  witness: HorseExecutionWitness,
  hand: CompletedHandObservation
): Exclude<HorseDecisionHandBinding, { status: 'pending' }> {
  const anchor = witness.handAnchor;
  if (anchor.status !== 'anchored') return anchor;
  if (
    typeof hand.committedHandId !== 'string' ||
    !UUID.test(hand.committedHandId) ||
    !horseCompletedHandKey(hand)
  )
    return unavailable('invalid_committed_identity');
  if (horseHandAnchorKey(anchor) !== horseCompletedHandKey(hand))
    return unavailable('hand_fence_mismatch');
  if (
    !['intended', 'coerced'].includes(witness.executionStatus) ||
    witness.acceptedActions.length !== 1
  )
    return unavailable('execution_unavailable');
  if (
    !Array.isArray(hand.actions) ||
    hand.actions.length > MAX_ACTIONS ||
    hand.actions.length <= anchor.actionOrdinal ||
    horsePriorActionsDigest(hand.actions.slice(0, anchor.actionOrdinal)) !==
      anchor.priorActionsDigest
  )
    return unavailable('prior_actions_mismatch');
  const accepted = witness.acceptedActions[0]!.record;
  let actionOrdinal = anchor.actionOrdinal;
  if (anchor.earlyLook) {
    if (
      witness.executionStatus !== 'intended' ||
      witness.selected.action !== 'fold' ||
      !witness.acceptedActions[0]!.intended ||
      accepted.action !== 'fold' ||
      witness.executedAction !== 'fold' ||
      accepted.amount !== 0
    )
      return unavailable('execution_unavailable');
    // Other players can act between an out-of-turn look and its actual fold.
    // The first subsequent action by this actor must be the exact acceptance;
    // never skip a contradictory own action to find a later matching one.
    actionOrdinal = hand.actions.findIndex(
      (candidate, ordinal) =>
        ordinal >= anchor.actionOrdinal && candidate.userId?.toLowerCase() === anchor.actorId
    );
    if (actionOrdinal < 0) return unavailable('accepted_action_mismatch');
    const matches = hand.actions.filter(
      (candidate, ordinal) =>
        ordinal >= anchor.actionOrdinal &&
        horsePriorActionsDigest([candidate]) === horsePriorActionsDigest([accepted])
    );
    if (matches.length !== 1) return unavailable('accepted_action_mismatch');
    if (
      hand.actions
        .slice(anchor.actionOrdinal, actionOrdinal)
        .some((candidate) => candidate.stage !== accepted.stage)
    )
      return unavailable('prior_actions_mismatch');
  }
  const action = hand.actions[actionOrdinal]!;
  const digest = horsePriorActionsDigest([accepted]);
  if (
    !digest ||
    digest !== horsePriorActionsDigest([action]) ||
    accepted.userId?.toLowerCase() !== anchor.actorId ||
    accepted.seat !== anchor.seat ||
    accepted.stage !== witness.identity.stage ||
    action.origin !== 'horse_policy'
  )
    return unavailable('accepted_action_mismatch');
  const identity = action.observationIdentity;
  const node = action.publicNode;
  const handId = hand.committedHandId.toLowerCase();
  if (
    !identity ||
    identity.status !== 'bound' ||
    identity.version !== 1 ||
    identity.handId !== handId ||
    identity.actionOrdinal !== actionOrdinal ||
    identity.observationId !== `${handId}:${actionOrdinal}` ||
    !SHA256.test(identity.sessionKey) ||
    !node ||
    node.status !== 'captured' ||
    node.actorSeat !== anchor.seat ||
    node.street !== accepted.stage
  )
    return unavailable('observation_identity_unavailable');
  return Object.freeze({
    status: 'bound',
    committedHandId: handId,
    observationId: identity.observationId,
    actionOrdinal: identity.actionOrdinal,
    sessionKey: identity.sessionKey,
  });
}
