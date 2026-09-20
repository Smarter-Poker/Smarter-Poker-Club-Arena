import { horsePlanContextKey, type HorsePlanContext } from './HorsePlanHandIdentity.js';
import type { ActionRecord, HorseDecision } from '../types.js';
import type { HorseMindDecisionEffect } from './HorseMind.js';

const MAX_EFFECTS = 16;
const STREETS = new Set(['flop', 'turn', 'river']);

/** Plans are authored inside the reference layer. A later utility or variant
 * owner may choose a different wager; the earlier future-street intent then
 * has no authority even when that final wager is accepted exactly. */
export function horseReferenceWagerWasRetained(decision: HorseDecision): boolean {
  const graph = decision.policyGraph;
  const origin = Array.isArray(graph?.transitions) ? graph.transitions[0] : undefined;
  return (
    decision.policyFallback === undefined &&
    (decision.action === 'bet' || decision.action === 'raise') &&
    typeof decision.amount === 'number' &&
    Number.isFinite(decision.amount) &&
    decision.amount >= 0 &&
    graph?.version === 'horse-policy-order-v1' &&
    origin?.node === 'reference' &&
    origin.after?.action === decision.action &&
    origin.after.amount === decision.amount &&
    graph.finalAction?.action === decision.action &&
    graph.finalAction.amount === decision.amount
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function cards(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 52 &&
    value.every((card) => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card)) &&
    new Set(value).size === value.length
  );
}

/** Shared with HorseMind so validation binds the same hand identity the
 * actual plan reader uses. This legacy key is not a full ledger state ID. */
export function horseMindHandKey(history: readonly ActionRecord[] | undefined): string | null {
  if (!history?.length) return null;
  return `${history[0].timestamp}:${history[0].userId}`;
}

/** Omission is the historical direct/offline contract. An explicit current
 * context, including unavailable, never falls back to a global clock key.
 * Preserve the existing empty-history gate rather than adding first-action plans. */
export function horsePlanHandKey(
  history: readonly ActionRecord[] | undefined,
  context?: HorsePlanContext | null
): string | null {
  if (!history?.length) return null;
  return context === undefined ? horseMindHandKey(history) : horsePlanContextKey(context);
}

/** Validate the complete bounded batch before applying its first mutation. */
export function horseDecisionEffectsAreValid(value: unknown): value is HorseMindDecisionEffect[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EFFECTS &&
    value.every((effect) => {
      if (!record(effect) || !identifier(effect.handKey) || !identifier(effect.userId))
        return false;
      if (effect.type === 'plan') {
        return (
          exact(effect, ['type', 'handKey', 'userId', 'barrelIntent']) &&
          typeof effect.barrelIntent === 'boolean'
        );
      }
      if (typeof effect.street !== 'string' || !STREETS.has(effect.street)) return false;
      if (effect.type === 'raise_plan') {
        return (
          exact(effect, ['type', 'handKey', 'userId', 'street', 'plan']) &&
          ['commit', 'callOnce', 'foldToRaise'].includes(effect.plan as string)
        );
      }
      return (
        effect.type === 'outlook' &&
        exact(effect, ['type', 'handKey', 'userId', 'street', 'good', 'scare']) &&
        cards(effect.good) &&
        cards(effect.scare)
      );
    })
  );
}

/** The client binds speculative writes to its original request, never to a
 * mutable live table snapshot or identities supplied only by the response. */
export function horseDecisionEffectsMatchRequest(
  value: unknown,
  context: {
    userId: string;
    history: readonly ActionRecord[] | undefined;
    street: string;
    brainFallback: boolean;
    planContext?: HorsePlanContext | null;
  }
): value is HorseMindDecisionEffect[] {
  if (!horseDecisionEffectsAreValid(value)) return false;
  if (!value.length) return true;
  if (context.brainFallback || !STREETS.has(context.street)) return false;
  const handKey = horsePlanHandKey(context.history, context.planContext);
  return (
    handKey !== null &&
    value.every(
      (effect) =>
        effect.userId === context.userId &&
        effect.handKey === handKey &&
        (effect.type === 'plan' || effect.street === context.street)
    )
  );
}

/** Compare complete valid records independent of JSON object key order. This
 * projection is local batch equality, never controller or durability proof. */
export function horseDecisionEffectsKey(value: unknown): string | null {
  if (!horseDecisionEffectsAreValid(value)) return null;
  return JSON.stringify(
    value.map((effect) =>
      effect.type === 'plan'
        ? [effect.type, effect.handKey, effect.userId, effect.barrelIntent]
        : effect.type === 'raise_plan'
          ? [effect.type, effect.handKey, effect.userId, effect.street, effect.plan]
          : [effect.type, effect.handKey, effect.userId, effect.street, effect.good, effect.scare]
    )
  );
}
