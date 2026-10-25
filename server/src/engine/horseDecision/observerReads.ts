import { HorseMind, type HorseMindSandbox } from '../HorseMind.js';
import {
  horseCompletedHandKey,
  anchorHorseDecisionHand,
  horseHandAnchorKey,
} from '../HorseDecisionHandBinding.js';
import {
  horseObserverReadContextFromRequest,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../HorseObserverReadContext.js';
import { observeHandResults } from '../HorseWinnerRead.js';
import type { FastHorseDecisionRequest, ObserveCompletedHandRequest } from './protocol.js';

export interface HorseObserverReadReceipt {
  readonly version: 1;
  readonly disposition:
    | 'independent'
    | 'unknown_context'
    | 'unknown_hand'
    | 'cutoff_unavailable'
    | 'capacity_reset';
  readonly context: HorseObserverReadContext | null;
  readonly cutoffMs: number;
  readonly learnedThroughMs: number;
  readonly history: 'volatile_only';
}
type Entry = {
  readonly context: HorseObserverReadContext;
  state: HorseMindSandbox;
  observedAt: number;
};
/** Volatile individual memory. No global/durable donor fallback. A missing
 * original participation coordinate is an empty read, never another observer. */
export class HorseObserverReads {
  private readonly entries = new Map<string, Entry>();
  private readonly hands = new Map<
    string,
    { signature: string; entries: Set<Entry>; conflict: boolean }
  >();
  private readonly requests = new WeakMap<
    FastHorseDecisionRequest,
    { state: HorseMindSandbox; boundary: { observedAt: number }; receipt: HorseObserverReadReceipt }
  >();
  constructor(
    private readonly maxEntries = 2048,
    private readonly maxHands = 4096,
    private readonly now: () => number = Date.now
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxHands) ||
      maxHands < 1
    )
      throw Error('Invalid observer memory bounds');
  }
  private entry(context: HorseObserverReadContext): Entry {
    const key = horseObserverReadContextKey(context)!;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        context: Object.freeze({ ...context }),
        state: HorseMind.createSandbox(),
        observedAt: 0,
      };
      if (this.entries.size >= this.maxEntries)
        this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, entry);
    }
    return entry;
  }
  run<T>(request: FastHorseDecisionRequest, fn: () => T): T {
    const context = horseObserverReadContextFromRequest(request);
    const anchor = anchorHorseDecisionHand(request);
    let entry =
      context && anchor.status === 'anchored'
        ? this.entry(context)
        : { context: null, state: HorseMind.createSandbox(), observedAt: 0 };
    if ('observedAt' in entry && entry.observedAt > request.decisionTimeMs)
      entry = { context: null, state: HorseMind.createSandbox(), observedAt: 0 };
    let disposition: HorseObserverReadReceipt['disposition'] = !context
      ? 'unknown_context'
      : anchor.status !== 'anchored'
        ? 'unknown_hand'
        : entry.context
          ? 'independent'
          : 'cutoff_unavailable';
    // Reset an entire over-capacity individual view; never retain counters
    // while losing the dedupe keys that made those counters meaningful.
    if (
      entry.state.stats.size > 512 ||
      entry.state.seenActions.size > 8192 ||
      entry.state.handFlags.size > 8192 ||
      entry.state.pairs.size > 2048 ||
      entry.state.scoped.size > 1024 ||
      (entry.state.exploit?.size ?? 0) > 1024 ||
      entry.state.plans.size > 2048 ||
      entry.state.raisePlans.size > 2048 ||
      entry.state.outlooks.size > 2048 ||
      (entry.state.winnerReads?.rows.size ?? 0) > 512 ||
      (entry.state.winnerReads?.seen.size ?? 0) > 8192
    ) {
      entry.state = HorseMind.createSandbox();
      entry.observedAt = 0;
      disposition = 'capacity_reset';
    }
    this.requests.set(request, {
      state: entry.state,
      boundary: entry,
      receipt: Object.freeze({
        version: 1,
        disposition,
        context: entry.context,
        cutoffMs: request.decisionTimeMs,
        learnedThroughMs: entry.observedAt,
        history: 'volatile_only',
      }),
    });
    if (entry.context && anchor.status === 'anchored') {
      const key = horseHandAnchorKey(anchor);
      if (!this.hands.has(key)) {
        if (this.hands.size >= this.maxHands) this.hands.delete(this.hands.keys().next().value!);
        this.hands.set(key, {
          signature: JSON.stringify([context!.variant, context!.format, context!.dealtCount]),
          entries: new Set(),
          conflict: false,
        });
      }
      const hand = this.hands.get(key)!;
      if (
        hand.signature !== JSON.stringify([context!.variant, context!.format, context!.dealtCount])
      )
        hand.conflict = true;
      if (hand.entries.size >= 10 && !hand.entries.has(entry as Entry)) hand.conflict = true;
      else hand.entries.add(entry as Entry);
    }
    try {
      return HorseMind.runInSandbox(entry.state, fn);
    } finally {
      entry.observedAt = Math.max(entry.observedAt, request.decisionTimeMs);
    }
  }
  receipt(request: FastHorseDecisionRequest): HorseObserverReadReceipt | null {
    return this.requests.get(request)?.receipt ?? null;
  }
  runIssued<T>(request: FastHorseDecisionRequest | null, fn: () => T): T {
    const entry = request ? this.requests.get(request) : undefined;
    if (!entry) throw Error('Original independent observer view unavailable');
    try {
      return HorseMind.runInSandbox(entry.state, fn);
    } finally {
      entry.boundary.observedAt = Math.max(entry.boundary.observedAt, this.now());
    }
  }
  runContext<T>(context: HorseObserverReadContext, fn: () => T): T {
    if (!horseObserverReadContextKey(context)) throw Error('Invalid independent observer context');
    const entry = this.entry(context);
    try {
      return HorseMind.runInSandbox(entry.state, fn);
    } finally {
      entry.observedAt = Math.max(entry.observedAt, this.now());
    }
  }
  complete(
    request: ObserveCompletedHandRequest,
    observe: (request: ObserveCompletedHandRequest) => void
  ): number {
    const key = horseCompletedHandKey(request);
    if (
      !key ||
      typeof request.committedHandId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        request.committedHandId
      )
    )
      return 0;
    const entries = this.hands.get(key);
    if (!entries || entries.conflict) return 0;
    this.hands.delete(key); // duplicate completion cannot update the same admission
    let learned = 0;
    for (const entry of entries.entries) {
      HorseMind.runInSandbox(entry.state, () => {
        const mode = entry.context.format === 'cash' ? 'cash' : 'tournament';
        const size =
          entry.context.dealtCount <= 2 ? 'hu' : entry.context.dealtCount <= 5 ? 'short' : 'full';
        HorseMind.setDecisionScope(
          `${entry.context.variant.startsWith('plo') || entry.context.variant === 'flo8' ? 'omaha' : entry.context.variant === 'short_deck' ? 'sixplus' : 'holdem'}:${size}`,
          entry.context.variant,
          mode
        );
        observeHandResults(request.handKey, request.results, request.bigBlind);
        entry.observedAt = Math.max(entry.observedAt, this.now());
        const independent = { ...request, scope: HorseMind.currentScope() };
        delete independent.durableOpponentProfiles;
        observe(independent);
        learned++;
      });
    }
    return learned;
  }
  clear(): void {
    this.entries.clear();
    this.hands.clear();
  }
}
