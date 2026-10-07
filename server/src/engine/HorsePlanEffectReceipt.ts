import { createHash } from 'node:crypto';

import { horseDecisionEffectsAreValid, horseDecisionEffectsKey } from './HorseDecisionEffects.js';
import {
  horsePlanBatchBindingIsValid,
  horsePlanBatchBindingKey,
  horsePlanContextKey,
  type HorsePlanBatchBinding,
} from './HorsePlanHandIdentity.js';
import type { HorseMindDecisionEffect } from './HorseMind.js';
import type { HorseDecision } from '../types.js';

/**
 * Phase 15.1 durable accepted-effect receipt
 * (docs/horse-brain-phase15-1-durable-effects-contract-2026-10-07.md).
 *
 * The worker COMMIT ACK means volatile application in one worker epoch. This
 * receipt means durable accepted intent: the exact issued batch, the exact
 * controller-accepted wager and the application outcome the worker observed
 * in the same synchronous step. It becomes durable only when the private
 * journal writer's fsynced ACK names its record. Materialized plan state is
 * derived from receipts only through `reconstructHorsePlanEffects`.
 */
export const HORSE_PLAN_RECEIPT_VERSION = 'horse-plan-receipt-v1';
export const HORSE_PLAN_ACCEPTANCE_VERSION = 'horse-plan-acceptance-v1';
export const HORSE_PLAN_POLICY_OWNERS = [
  'phase8',
  'phase10',
  'phase11',
  'phase12',
  'phase13',
] as const;
export type HorsePlanPolicyOwner = (typeof HORSE_PLAN_POLICY_OWNERS)[number];

/** One applied candidate authority the issued wager depended on. */
export interface HorsePlanPolicyAuthority {
  readonly owner: HorsePlanPolicyOwner;
  readonly variant: string | null;
  readonly epoch: string;
  readonly generation: number;
  readonly authorityKey: string | null;
}
export interface HorsePlanPolicyGeneration {
  readonly graph: string | null;
  readonly candidates: readonly HorsePlanPolicyAuthority[];
}
/** The controller-accepted wager, bound to the original FAST witness. */
export interface HorsePlanAcceptance {
  readonly version: typeof HORSE_PLAN_ACCEPTANCE_VERSION;
  readonly action: 'bet' | 'raise';
  readonly amount: number;
  readonly witness: Readonly<{ requestId: number; decisionKey: string }> | null;
}
export type HorsePlanReceiptDisposition = 'applied' | 'failed';
export interface HorsePlanEffectReceipt {
  readonly version: typeof HORSE_PLAN_RECEIPT_VERSION;
  readonly issuedBatchDigest: string;
  readonly binding: HorsePlanBatchBinding;
  readonly effects: readonly HorseMindDecisionEffect[];
  /** The issued decision's final action, captured by the worker at issue. */
  readonly issuedAction: Readonly<{ action: string; amount: number | null }>;
  /** What the controller accepted. The engine gate makes it equal the issued
   * action; another host may record a different (coerced) wager, which is
   * kept as observed and never materialized by recovery. */
  readonly acceptance: HorsePlanAcceptance;
  readonly policy: HorsePlanPolicyGeneration;
  readonly sourceRelease: string | null;
  readonly workerEpoch: string;
  readonly disposition: HorsePlanReceiptDisposition;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uint = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Canonical JSON with sorted object keys: equality of complete receipts is
 * independent of producer property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** SHA-256 of the original issued batch: canonical binding plus canonical
 * effects. Null when either part is not a valid issued batch. */
export function horsePlanIssuedBatchDigest(binding: unknown, effects: unknown): string | null {
  const bindingKey = horsePlanBatchBindingKey(binding);
  const effectsKey = horseDecisionEffectsKey(effects);
  if (bindingKey === null || effectsKey === null) return null;
  return createHash('sha256')
    .update(JSON.stringify(['horse-plan-issued-batch-v1', bindingKey, effectsKey]))
    .digest('hex');
}

/** The batch identity the worker reserves at issue: `[generation, fence]`. */
export function horsePlanBatchIdentity(
  binding: Pick<HorsePlanBatchBinding, 'generation' | 'fence'>
) {
  return JSON.stringify([binding.generation, binding.fence]);
}

/** Every effect belongs to the binding's actor, allocated hand and street. */
export function horsePlanEffectsBindToBatch(
  effects: unknown,
  binding: HorsePlanBatchBinding
): effects is HorseMindDecisionEffect[] {
  if (!horseDecisionEffectsAreValid(effects) || effects.length === 0) return false;
  const handKey = horsePlanContextKey(binding.planContext);
  return (
    handKey !== null &&
    ['flop', 'turn', 'river'].includes(binding.street) &&
    effects.every(
      (effect) =>
        effect.userId === binding.actorId &&
        effect.handKey === handKey &&
        (effect.type === 'plan' || effect.street === binding.street)
    )
  );
}

export function horsePlanAcceptanceIsValid(
  value: unknown,
  binding?: HorsePlanBatchBinding
): value is HorsePlanAcceptance {
  if (
    !object(value) ||
    !exact(value, ['version', 'action', 'amount', 'witness']) ||
    value.version !== HORSE_PLAN_ACCEPTANCE_VERSION ||
    (value.action !== 'bet' && value.action !== 'raise') ||
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount < 0
  )
    return false;
  const witness = value.witness;
  if (witness === null) return true;
  if (
    !object(witness) ||
    !exact(witness, ['requestId', 'decisionKey']) ||
    !uint(witness.requestId) ||
    witness.requestId === 0 ||
    !text(witness.decisionKey)
  )
    return false;
  return (
    !binding ||
    (witness.requestId === binding.fastRequestId && witness.decisionKey === binding.decisionKey)
  );
}

/** The controller's own accepted record when one was observed, else the
 * submitted wager, bound to the FAST execution witness when one exists. The
 * client refuses a result that does not validate; nothing is coerced. */
export function horsePlanAcceptanceFromController(
  accepted: Readonly<{ action: string; amount?: number | null }> | null | undefined,
  submitted: Readonly<{ action: string; amount: number | null }>,
  witness: Readonly<{ requestId: number; decisionKey: string }> | null | undefined
): HorsePlanAcceptance {
  const source = accepted ?? submitted;
  return Object.freeze({
    version: HORSE_PLAN_ACCEPTANCE_VERSION,
    action: source.action as HorsePlanAcceptance['action'],
    amount: typeof source.amount === 'number' ? source.amount : Number.NaN,
    witness: witness
      ? Object.freeze({ requestId: witness.requestId, decisionKey: witness.decisionKey })
      : null,
  });
}

function issuedActionIsValid(value: unknown): boolean {
  return (
    object(value) &&
    exact(value, ['action', 'amount']) &&
    text(value.action, 16) &&
    (value.amount === null ||
      (typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0))
  );
}

function policyAuthorityIsValid(value: unknown): value is HorsePlanPolicyAuthority {
  return (
    object(value) &&
    exact(value, ['owner', 'variant', 'epoch', 'generation', 'authorityKey']) &&
    (HORSE_PLAN_POLICY_OWNERS as readonly unknown[]).includes(value.owner) &&
    (value.variant === null || text(value.variant, 64)) &&
    text(value.epoch, 64) &&
    uint(value.generation) &&
    (value.authorityKey === null || text(value.authorityKey))
  );
}

export function horsePlanPolicyGenerationIsValid(
  value: unknown
): value is HorsePlanPolicyGeneration {
  return (
    object(value) &&
    exact(value, ['graph', 'candidates']) &&
    (value.graph === null || text(value.graph, 64)) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= HORSE_PLAN_POLICY_OWNERS.length &&
    value.candidates.every(policyAuthorityIsValid)
  );
}

/** The policy graph and every applied candidate authority behind the issued
 * wager. Empty candidates while every selection is shadow / null. */
export function horsePlanPolicyGenerationFromDecision(
  decision: HorseDecision
): HorsePlanPolicyGeneration {
  const candidates: HorsePlanPolicyAuthority[] = [];
  const add = (
    owner: HorsePlanPolicyOwner,
    ledger: { applied?: boolean; authority?: unknown; variant?: unknown } | null | undefined
  ) => {
    if (!ledger?.applied) return;
    const authority = ledger.authority as
      | { epoch?: unknown; generation?: unknown; authorityKey?: unknown }
      | null
      | undefined;
    candidates.push(
      Object.freeze({
        owner,
        variant: typeof ledger.variant === 'string' ? ledger.variant : null,
        epoch: typeof authority?.epoch === 'string' ? authority.epoch : 'unavailable',
        generation: uint(authority?.generation) ? authority.generation : 0,
        authorityKey: typeof authority?.authorityKey === 'string' ? authority.authorityKey : null,
      })
    );
  };
  add('phase8', decision.tournamentPostflop as never);
  add('phase10', decision.plo4Policy as never);
  add('phase11', decision.omahaVariantPolicy as never);
  add('phase12', decision.remainingVariantPolicy as never);
  add('phase13', decision.jointPolicy as never);
  const graph = decision.policyGraph?.version;
  return Object.freeze({
    graph: typeof graph === 'string' && graph.length <= 64 ? graph : null,
    candidates: Object.freeze(candidates),
  });
}

export function horsePlanEffectReceiptIsValid(value: unknown): value is HorsePlanEffectReceipt {
  try {
    if (
      !object(value) ||
      !exact(value, [
        'version',
        'issuedBatchDigest',
        'binding',
        'effects',
        'issuedAction',
        'acceptance',
        'policy',
        'sourceRelease',
        'workerEpoch',
        'disposition',
      ]) ||
      value.version !== HORSE_PLAN_RECEIPT_VERSION ||
      typeof value.issuedBatchDigest !== 'string' ||
      !SHA256.test(value.issuedBatchDigest) ||
      !horsePlanBatchBindingIsValid(value.binding) ||
      !horsePlanEffectsBindToBatch(value.effects, value.binding) ||
      horsePlanIssuedBatchDigest(value.binding, value.effects) !== value.issuedBatchDigest ||
      !issuedActionIsValid(value.issuedAction) ||
      !horsePlanAcceptanceIsValid(value.acceptance, value.binding) ||
      !horsePlanPolicyGenerationIsValid(value.policy) ||
      (value.sourceRelease !== null &&
        (typeof value.sourceRelease !== 'string' || !/^[0-9a-f]{40}$/.test(value.sourceRelease))) ||
      typeof value.workerEpoch !== 'string' ||
      !UUID.test(value.workerEpoch) ||
      (value.disposition !== 'applied' && value.disposition !== 'failed')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Build a receipt from detached worker state; throws rather than returning
 * a receipt that would not validate. */
export function createHorsePlanEffectReceipt(input: {
  binding: HorsePlanBatchBinding;
  effects: readonly HorseMindDecisionEffect[];
  issuedAction: Readonly<{ action: string; amount: number | null }>;
  acceptance: HorsePlanAcceptance;
  policy: HorsePlanPolicyGeneration;
  sourceRelease: string | null;
  workerEpoch: string;
  disposition: HorsePlanReceiptDisposition;
}): HorsePlanEffectReceipt {
  const receipt = freeze(
    structuredClone({
      version: HORSE_PLAN_RECEIPT_VERSION,
      issuedBatchDigest: horsePlanIssuedBatchDigest(input.binding, input.effects) ?? '',
      binding: input.binding,
      effects: input.effects,
      issuedAction: { action: input.issuedAction.action, amount: input.issuedAction.amount },
      acceptance: input.acceptance,
      policy: input.policy,
      sourceRelease: input.sourceRelease,
      workerEpoch: input.workerEpoch,
      disposition: input.disposition,
    })
  );
  if (!horsePlanEffectReceiptIsValid(receipt)) throw Error('Horse plan receipt is invalid');
  return receipt;
}

/** The hand currently in play at a table, as the live owner reports it. */
export interface HorsePlanLiveHand {
  readonly tableId: string;
  readonly handNumber: number;
  readonly lease: string;
  readonly street: string;
  readonly generation: number;
}
export const HORSE_PLAN_RECOVERY_OUTCOMES = [
  'replaced',
  'invalid',
  'conflict',
  'failed_not_replayed',
  'acceptance_mismatch',
  'hand_not_live',
  'table_mismatch',
  'hand_superseded',
  'lease_superseded',
  'street_superseded',
  'generation_expired',
  'policy_withdrawn',
] as const;
export type HorsePlanRecoveryOutcome = (typeof HORSE_PLAN_RECOVERY_OUTCOMES)[number];
export interface HorsePlanRecovery {
  /** Receipts whose effects are materialized, in ascending hand and turn order. */
  readonly replaced: readonly HorsePlanEffectReceipt[];
  /** One outcome per input receipt, in input order. */
  readonly outcomes: readonly HorsePlanRecoveryOutcome[];
}

/**
 * Deterministic reconstruction of plan state from durable accepted receipts.
 * Pure: the caller applies `replaced` through HorseMind.applyDecisionEffects,
 * which is keyed replacement, so reapplying the same receipt is idempotent.
 * Never replays a failed (possibly partial) application, a conflicting batch,
 * another table, a newer hand / street / lease, an older live turn or a
 * withdrawn policy. A fresh process with a new lease reconstructs nothing.
 */
export function reconstructHorsePlanEffects(
  receipts: readonly unknown[],
  context: {
    live(tableId: string): HorsePlanLiveHand | null;
    policyUsable(authority: HorsePlanPolicyAuthority): boolean;
  }
): HorsePlanRecovery {
  const outcomes: HorsePlanRecoveryOutcome[] = receipts.map(() => 'invalid');
  const groups = new Map<string, { canonical: string; indexes: number[]; conflict: boolean }>();
  receipts.forEach((receipt, index) => {
    if (!horsePlanEffectReceiptIsValid(receipt)) return;
    const identity = horsePlanBatchIdentity(receipt.binding);
    const form = canonical(receipt);
    const group = groups.get(identity);
    if (!group) groups.set(identity, { canonical: form, indexes: [index], conflict: false });
    else {
      group.indexes.push(index);
      if (group.canonical !== form) group.conflict = true;
    }
  });
  const replaced: HorsePlanEffectReceipt[] = [];
  for (const group of groups.values()) {
    const receipt = receipts[group.indexes[0]!] as HorsePlanEffectReceipt;
    const outcome = ((): HorsePlanRecoveryOutcome => {
      if (group.conflict) return 'conflict';
      if (receipt.disposition !== 'applied') return 'failed_not_replayed';
      if (
        receipt.acceptance.action !== receipt.issuedAction.action ||
        receipt.acceptance.amount !== receipt.issuedAction.amount
      )
        return 'acceptance_mismatch';
      const hand = receipt.binding.planContext.hand!;
      const fence = receipt.binding.fence.split(':');
      let live: HorsePlanLiveHand | null;
      try {
        live = context.live(hand.tableId);
      } catch {
        live = null;
      }
      if (!live) return 'hand_not_live';
      if (String(live.tableId).toLowerCase() !== hand.tableId) return 'table_mismatch';
      if (live.handNumber !== hand.handNumber) return 'hand_superseded';
      if (live.lease !== fence[3]) return 'lease_superseded';
      if (live.street !== receipt.binding.street) return 'street_superseded';
      if (!uint(live.generation) || live.generation < receipt.binding.generation)
        return 'generation_expired';
      for (const authority of receipt.policy.candidates) {
        let usable = false;
        try {
          usable = context.policyUsable(authority) === true;
        } catch {
          usable = false;
        }
        if (!usable) return 'policy_withdrawn';
      }
      return 'replaced';
    })();
    for (const index of group.indexes) outcomes[index] = outcome;
    if (outcome === 'replaced') replaced.push(receipt);
  }
  replaced.sort((a, b) => {
    const ah = a.binding.planContext.hand!;
    const bh = b.binding.planContext.hand!;
    return ah.tableId !== bh.tableId
      ? ah.tableId < bh.tableId
        ? -1
        : 1
      : ah.handNumber - bh.handNumber || a.binding.generation - b.binding.generation;
  });
  return Object.freeze({
    replaced: Object.freeze(replaced),
    outcomes: Object.freeze(outcomes),
  });
}
