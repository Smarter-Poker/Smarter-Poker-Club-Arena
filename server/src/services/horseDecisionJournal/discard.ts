import {
  horseCompletedHandKey,
  horsePriorActionsDigest,
  horseJournalLeaseIdentityIsValid,
} from '../../engine/HorseDecisionHandBinding.js';
import type { HorseHandJournalContext } from '../../engine/HorseDecisionHandBinding.js';
import type { HorseDiscardControllerReceipt } from '../../engine/HandController.js';
import type {
  CompletedHandObservation,
  DecidePineappleDiscardRequest,
  PineappleDiscardJournalContext,
} from '../../engine/horseDecision/protocol.js';
import { horseJournalJson } from './record.js';
import { horseComputeMetadataIsValid } from '../../engine/horseDecision/responseValidation.js';

/** Private worker evidence. Cards must never enter public action records,
 * telemetry, review output, or the learning observation identity. */
export interface HorseDiscardDecisionCapture {
  version: 1;
  snapshot: DecidePineappleDiscardRequest;
  cardIndex: number;
  rngBefore: number;
  rngAfter: number;
  computeMs: number;
  governorScale: number;
  runtimePins: 'incomplete';
  lifecycleVersion?: 1;
}

/** Captured only by the actual private controller commit observer. A prepared
 * runout selection, returned worker result or public discard amount0 is not
 * an execution receipt. */
export interface HorseDiscardExecutionObservation {
  version: 1;
  request: DecidePineappleDiscardRequest;
  selectedIndex: number;
  controller: HorseDiscardControllerReceipt;
  acceptedActionOrdinal: number;
  priorActions: HorseHandJournalContext;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
const uint = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const cardsKey = (cards: readonly { rank: string; suit: string }[]) =>
  cards.map((card) => `${card.rank}:${card.suit}`).join('|');
const same = (a: unknown, b: unknown): boolean => horseJournalJson(a) === horseJournalJson(b);

export function horseDiscardJournalContextValid(
  value: unknown
): value is PineappleDiscardJournalContext {
  try {
    const c = value as PineappleDiscardJournalContext;
    return (
      !!c &&
      c.version === 1 &&
      uuid.test(c.tableId) &&
      uuid.test(c.actorId) &&
      uint(c.handNumber) &&
      c.handNumber >= 1 &&
      uint(c.seat) &&
      c.seat >= 1 &&
      c.seat <= 10 &&
      horseJournalLeaseIdentityIsValid(c.leaseGeneration) &&
      uint(c.requestedAtMs) &&
      ['choice', 'forced_runout'].includes(c.lane) &&
      !!c.priorActions &&
      c.priorActions.version === 1 &&
      uint(c.priorActions.actionCount) &&
      c.priorActions.actionCount <= 4096 &&
      sha.test(c.priorActions.actionsDigest)
    );
  } catch {
    return false;
  }
}

/** Reconstruct the actual producer fence. Card keys themselves contain ':',
 * so splitting this fence into fixed positional fields is not valid. */
export function horseDiscardHandKey(request: DecidePineappleDiscardRequest): string | null {
  try {
    const c = request.journalContext;
    if (
      !horseDiscardJournalContextValid(c) ||
      request.type !== 'DECIDE_DISCARD' ||
      !uint(request.requestId) ||
      request.requestId < 1 ||
      !uint(request.generation) ||
      request.gameVariant !== 'pineapple' ||
      !Array.isArray(request.cards) ||
      request.cards.length !== 3 ||
      !Array.isArray(request.communityCards) ||
      request.communityCards.length !== 3
    )
      return null;
    const cards = [...request.cards, ...request.communityCards];
    if (
      cards.some(
        (card) =>
          !card ||
          !['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'].includes(card.rank) ||
          !['clubs', 'diamonds', 'hearts', 'spades'].includes(card.suit)
      ) ||
      new Set(cards.map((card) => `${card.rank}:${card.suit}`)).size !== 6
    )
      return null;
    const expectedFence = [
      c.tableId,
      c.handNumber,
      'pineapple-discard',
      c.seat,
      c.leaseGeneration,
      request.generation,
      cardsKey(request.cards),
      cardsKey(request.communityCards),
    ].join(':');
    if (request.fence !== expectedFence) return null;
    return `${c.tableId.toLowerCase()}:${c.handNumber}:${c.leaseGeneration}`;
  } catch {
    return null;
  }
}

/** Include the entire immutable request in the private turn identity. This is
 * a journal key only: it never changes the policy fence or RNG seed. */
export const horseDiscardTurnKey = (request: DecidePineappleDiscardRequest): string =>
  horseJournalJson(['horse-discard-turn-v1', request]);

export function validateHorseDiscardDecision(
  value: unknown
): asserts value is HorseDiscardDecisionCapture {
  const d = value as HorseDiscardDecisionCapture;
  if (
    !d ||
    d.version !== 1 ||
    !horseDiscardHandKey(d.snapshot) ||
    !uint(d.cardIndex) ||
    d.cardIndex > 2 ||
    !uint(d.rngBefore) ||
    d.rngBefore > 0xffffffff ||
    !uint(d.rngAfter) ||
    d.rngAfter > 0xffffffff ||
    !horseComputeMetadataIsValid(d) ||
    d.runtimePins !== 'incomplete' ||
    (d.lifecycleVersion !== undefined && d.lifecycleVersion !== 1)
  )
    throw Error('Invalid private Horse discard decision');
}

/** The requested public action prefix can be independently revalidated after
 * persistence. It proves a hand coordinate, not controller acceptance of a card. */
export function horseDiscardRequestMatchesHand(
  request: DecidePineappleDiscardRequest,
  hand: CompletedHandObservation
): boolean {
  const coordinate = horseDiscardHandKey(request);
  const context = request.journalContext;
  return (
    !!coordinate &&
    coordinate === horseCompletedHandKey(hand) &&
    !!context &&
    Array.isArray(hand.actions) &&
    hand.actions.length >= context.priorActions.actionCount &&
    horsePriorActionsDigest(hand.actions.slice(0, context.priorActions.actionCount)) ===
      context.priorActions.actionsDigest
  );
}

export function validateHorseDiscardExecution(
  value: unknown
): asserts value is HorseDiscardExecutionObservation {
  const e = value as HorseDiscardExecutionObservation;
  if (
    !e ||
    e.version !== 1 ||
    !horseDiscardHandKey(e.request) ||
    !uint(e.selectedIndex) ||
    e.selectedIndex > 2
  )
    throw Error('Invalid private Horse discard execution');
  const context = e.request.journalContext!;
  const c = e.controller;
  const p = e.priorActions;
  if (
    !c ||
    c.seat !== context.seat ||
    typeof c.actorId !== 'string' ||
    c.actorId.toLowerCase() !== context.actorId.toLowerCase() ||
    c.chosenIndex !== e.selectedIndex ||
    !same(c.originalCards, e.request.cards) ||
    !same(c.communityCards, e.request.communityCards) ||
    !same(c.discardedCard, e.request.cards[e.selectedIndex]) ||
    !same(
      c.retainedCards,
      e.request.cards.filter((_, i) => i !== e.selectedIndex)
    ) ||
    !c.acceptedRecord ||
    !horsePriorActionsDigest([c.acceptedRecord]) ||
    c.acceptedRecord.seat !== context.seat ||
    c.acceptedRecord.userId.toLowerCase() !== context.actorId.toLowerCase() ||
    c.acceptedRecord.action !== 'discard' ||
    c.acceptedRecord.amount !== 0 ||
    c.acceptedRecord.stage !== (context.lane === 'choice' ? 'pineapple_discard' : 'flop') ||
    c.acceptedRecord.timestamp < context.requestedAtMs ||
    !p ||
    p.version !== 1 ||
    !uint(p.actionCount) ||
    p.actionCount > 4095 ||
    p.actionCount < context.priorActions.actionCount ||
    !sha.test(p.actionsDigest) ||
    e.acceptedActionOrdinal !== p.actionCount
  )
    throw Error('Invalid private Horse discard controller receipt');
}

/** Recheck persisted private evidence against the completed accepted hand.
 * Discard nodes intentionally have no betting observation identity: this join
 * proves the physical choice and accepted action, never GTO/replay/learning. */
export function bindHorseDiscardExecutionToHand(
  execution: HorseDiscardExecutionObservation,
  hand: CompletedHandObservation
): number | null {
  try {
    validateHorseDiscardExecution(execution);
    if (
      !uuid.test(hand.committedHandId ?? '') ||
      !horseDiscardRequestMatchesHand(execution.request, hand)
    )
      return null;
    const ordinal = execution.acceptedActionOrdinal;
    if (
      !Array.isArray(hand.actions) ||
      ordinal >= hand.actions.length ||
      horsePriorActionsDigest(hand.actions.slice(0, ordinal)) !==
        execution.priorActions.actionsDigest ||
      horsePriorActionsDigest([hand.actions[ordinal]]) !==
        horsePriorActionsDigest([execution.controller.acceptedRecord])
    )
      return null;
    return ordinal;
  } catch {
    return null;
  }
}
