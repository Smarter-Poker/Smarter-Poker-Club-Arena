import {
  anchorHorseDecisionHand,
  horseCompletedHandKey,
  horseHandAnchorKey,
} from '../HorseDecisionHandBinding.js';
import {
  horseObserverReadContextFromRequest,
  horseObserverReadContextIsValid,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../HorseObserverReadContext.js';
import type { CompletedHandObservation, LiveHorseDecisionSnapshot } from './protocol.js';

/** Private routing metadata from validated original FASTs, never a Phase 14
 * accepted roster, private-card channel or permission to activate a policy. */
export interface HorseObserverParticipants {
  version: 1;
  handKey: string;
  status: 'bound' | 'unknown' | 'conflict';
  contexts: HorseObserverReadContext[];
}
const signature = (c: HorseObserverReadContext) =>
  JSON.stringify([c.variant, c.format, c.dealtCount]);
export function observerParticipantsBind(
  value: unknown,
  hand: CompletedHandObservation
): value is HorseObserverParticipants {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as HorseObserverParticipants;
  if (
    Object.keys(v).length !== 4 ||
    !['version', 'handKey', 'status', 'contexts'].every((k) => Object.hasOwn(v, k)) ||
    v.version !== 1 ||
    typeof v.handKey !== 'string' ||
    v.handKey !== horseCompletedHandKey(hand) ||
    !['bound', 'unknown', 'conflict'].includes(v.status) ||
    !Array.isArray(v.contexts) ||
    v.contexts.length > 10 ||
    (v.status === 'bound' ? v.contexts.length === 0 : v.contexts.length !== 0)
  )
    return false;
  const ids = new Set<string>();
  let scope: string | undefined;
  for (const context of v.contexts) {
    if (!horseObserverReadContextIsValid(context) || ids.has(context.observerId)) return false;
    const sig = signature(context);
    if (scope !== undefined && scope !== sig) return false;
    ids.add(context.observerId);
    scope = sig;
  }
  return true;
}
export class HorseObserverParticipantRegistry {
  private readonly hands = new Map<
    string,
    { scope: string; contexts: Map<string, HorseObserverReadContext>; conflict: boolean }
  >();
  constructor(private readonly maxHands = 4096) {
    if (!Number.isSafeInteger(maxHands) || maxHands < 1 || maxHands > 4096)
      throw Error('Invalid original observer hand bound');
  }
  capture(snapshot: LiveHorseDecisionSnapshot): void {
    const context = horseObserverReadContextFromRequest(snapshot);
    const anchor = anchorHorseDecisionHand(snapshot);
    if (!context || anchor.status !== 'anchored' || anchor.actorId !== context.observerId) return;
    const key = horseHandAnchorKey(anchor);
    let hand = this.hands.get(key);
    if (!hand) {
      if (this.hands.size >= this.maxHands) this.hands.delete(this.hands.keys().next().value!);
      hand = { scope: signature(context), contexts: new Map(), conflict: false };
      this.hands.set(key, hand);
    }
    if (
      hand.scope !== signature(context) ||
      (hand.contexts.size >= 10 && !hand.contexts.has(context.observerId))
    )
      hand.conflict = true;
    else hand.contexts.set(context.observerId, Object.freeze({ ...context }));
  }
  take(observation: CompletedHandObservation): HorseObserverParticipants {
    const key = horseCompletedHandKey(observation);
    const hand = key ? this.hands.get(key) : undefined;
    const committed =
      typeof observation.committedHandId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        observation.committedHandId
      );
    if (!committed) return { version: 1, handKey: key ?? '', status: 'unknown', contexts: [] };
    if (key) this.hands.delete(key);
    return {
      version: 1,
      handKey: key ?? '',
      status: !hand ? 'unknown' : hand.conflict ? 'conflict' : 'bound',
      contexts: !hand || hand.conflict ? [] : structuredClone([...hand.contexts.values()]),
    };
  }
}
