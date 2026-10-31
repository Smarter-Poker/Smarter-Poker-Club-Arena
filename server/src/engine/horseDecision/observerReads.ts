import { riverPublicNode } from '../HorseMultiwayRiverRead.js';
import { PooledPublicProfiles, type PooledPublicProfileReceipt } from './pooledPublicProfiles.js';
import { opponentMemoryKey } from '../HorseOpponentMemory.js';
import { observerParticipantsBind } from './observerParticipants.js';
import { ownPublicHistoryIsValid, type HorseOwnPublicHistoryPacket } from './ownPublicHistory.js';
import { completedHandActionsForMind } from './completedHandActions.js';
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
  readonly version: 1 | 2 | 3;
  readonly individualVersion?: 1 | 2;
  readonly pooledPublicProfiles?: PooledPublicProfileReceipt;
  readonly disposition:
    | 'independent'
    | 'pooled_public'
    | 'unknown_context'
    | 'unknown_hand'
    | 'cutoff_unavailable'
    | 'capacity_reset'
    | 'history_unavailable';
  readonly context: HorseObserverReadContext | null;
  readonly cutoffMs: number;
  readonly learnedThroughMs: number;
  readonly history: 'volatile_only' | 'own_public_window';
  readonly historyDigest?: string;
  readonly historyAvailableAtMs?: number;
  readonly historyHands?: number;
  readonly historyCapped?: boolean;
}
type Entry = {
  readonly context: HorseObserverReadContext;
  state: HorseMindSandbox;
  observedAt: number;
  historyPhase?: 'pending' | 'loaded' | 'unavailable';
  historyError?: boolean;
  history?: { digest: string; availableAtMs: number; hands: number; capped: boolean };
  historyAckDigest?: string;
  completedHandIds?: Set<string>;
  pendingCompletions?: ObserveCompletedHandRequest[];
  historyTailCapped?: boolean;
};
/** Individual memory with owner-authorized public aggregate notes.
 * Pooled notes carry separate provenance and are never labelled independent. A missing
 * original participation coordinate is an empty read, never another observer. */
export class HorseObserverReads {
  private readonly publicProfiles: PooledPublicProfiles;
  private readonly entries = new Map<string, Entry>();
  private readonly completed = new Set<string>();
  private readonly hands = new Map<
    string,
    { signature: string; entries: Set<Entry>; conflict: boolean }
  >();
  private readonly requests = new WeakMap<
    FastHorseDecisionRequest,
    {
      state: HorseMindSandbox;
      boundary: { observedAt: number };
      receipt: HorseObserverReadReceipt;
      historyAckDigest: string | null;
    }
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
    this.publicProfiles = new PooledPublicProfiles(now);
  }
  bootstrapPublicProfiles(snapshot: {
    availableAtMs: number;
    profiles: import('../HorseOpponentMemory.js').DurableOpponentProfile[];
  }): boolean {
    return this.publicProfiles.bootstrap(snapshot);
  }
  private scope(context: HorseObserverReadContext): import('../HorseMind.js').ReadScope {
    const size = context.dealtCount <= 2 ? 'hu' : context.dealtCount <= 5 ? 'short' : 'full';
    return `${context.variant.startsWith('plo') || context.variant === 'flo8' ? 'omaha' : context.variant === 'short_deck' ? 'sixplus' : 'holdem'}:${size}`;
  }
  private learnPublic(
    entry: Entry,
    state: HorseMindSandbox,
    hand: ObserveCompletedHandRequest
  ): void {
    HorseMind.runInSandbox(state, () => {
      const scope = this.scope(entry.context);
      HorseMind.setDecisionScope(
        scope,
        entry.context.variant,
        entry.context.format === 'cash' ? 'cash' : 'tournament'
      );
      const actions = completedHandActionsForMind(hand.actions, scope);
      const parts = hand.handKey.split(':');
      if (actions)
        HorseMind.observe(
          actions.actions,
          [],
          {
            version: 1,
            tableId: parts[0]!,
            handNumber: Number(parts[1]),
          },
          entry.context.dealtCount
        );
      HorseMind.observeHandComplete(
        hand.handKey,
        hand.actions,
        hand.bigBlind,
        hand.showdown,
        scope,
        false,
        hand.riverCallContext,
        hand.retainedRiverCalls
      );
      observeHandResults(hand.handKey, hand.results, hand.bigBlind);
    });
  }
  /** Keep only public learning fields. No accepted roster, donor packet,
   * private cards or policy/financial authority is copied. Only the first four
   * explicitly projected public river structural snapshots may accompany actions. */
  private publicCopy(hand: ObserveCompletedHandRequest): ObserveCompletedHandRequest {
    let riverCount = 0;
    return {
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: hand.requestId,
      generation: hand.generation,
      fence: hand.fence,
      handKey: hand.handKey,
      committedHandId: hand.committedHandId,
      bigBlind: hand.bigBlind,
      riverCallContext: hand.riverCallContext ? { ...hand.riverCallContext } : undefined,
      retainedRiverCalls: hand.retainedRiverCalls?.map((s) => ({ ...s })),
      scope: hand.scope,
      actions: hand.actions?.map((a) => {
        const publicNode =
          a.stage === 'river' && riverCount++ < 4 ? riverPublicNode(a.publicNode, true) : null;
        return {
          seat: a.seat,
          userId: a.userId,
          action: a.action,
          amount: a.amount,
          stage: a.stage,
          timestamp: a.timestamp,
          ...(a.isFullRaise === undefined ? {} : { isFullRaise: a.isFullRaise }),
          ...(publicNode ? { publicNode } : {}),
        };
      }),
      results: hand.results?.map((r) => ({ user_id: r.user_id, net: r.net })),
      showdown:
        hand.showdown?.map((r) => ({
          user_id: r.user_id,
          mucked: r.mucked,
          ...(r.hand_name === undefined ? {} : { hand_name: r.hand_name }),
        })) ?? null,
    };
  }
  private mergeObservations(target: HorseMindSandbox, staged: HorseMindSandbox): void {
    Object.assign(target, {
      stats: staged.stats,
      seenActions: staged.seenActions,
      handFlags: staged.handFlags,
      dirty: staged.dirty,
      pairs: staged.pairs,
      dirtyPairs: staged.dirtyPairs,
      scoped: staged.scoped,
      dirtyScoped: staged.dirtyScoped,
      exploit: staged.exploit,
      winnerReads: staged.winnerReads,
    });
  }
  private flushPending(entry: Entry): void {
    try {
      const staged = structuredClone(entry.state);
      for (const hand of entry.pendingCompletions ?? []) this.learnPublic(entry, staged, hand);
      this.mergeObservations(entry.state, staged);
    } catch {
      entry.historyError = true;
    }
  }
  private hydrate(entry: Entry, packet: HorseOwnPublicHistoryPacket): void {
    entry.historyAckDigest = packet.digest; // acknowledgement is not a loaded-history claim
    if (
      entry.historyPhase === 'loaded' ||
      !ownPublicHistoryIsValid(packet, entry.context, packet.availableAtMs)
    )
      return;
    // Pending turns retain plans in the real entry, but observe into temporary
    // views. Historical observations therefore precede live tails, and no
    // already-counted recent hand is reclassified as older data arriving last.
    // Rebuild observations in chronological order after a failed initial load.
    // Plans remain on the original state; only public observation fields merge.
    const staged = HorseMind.createSandbox();
    const ids = new Set<string>();
    const observations: Array<{ at: number; hand: ObserveCompletedHandRequest }> = [];
    const pending = new Map(
      (entry.pendingCompletions ?? []).map((hand) => [hand.committedHandId!.toLowerCase(), hand])
    );
    for (const h of packet.hands) {
      ids.add(h.handId);
      const live = pending.get(h.handId);
      // Preserve the original bound live showdown evidence at its historical
      // position; optional history categories can contain less information.
      if (live?.handKey === `${h.tableId}:${h.handNumber}`) {
        observations.push({ at: h.playedAtMs, hand: live });
        continue;
      }
      observations.push({
        at: h.playedAtMs,
        hand: {
          type: 'OBSERVE_COMPLETED_HAND',
          requestId: 0,
          generation: h.handNumber,
          // Historical learning has no current lease or plan authority.
          fence: '',
          handKey: `${h.tableId}:${h.handNumber}`,
          committedHandId: h.handId,
          bigBlind: h.bigBlind,
          actions: h.actions,
          results: h.results ?? undefined,
          showdown: null,
          ...(h.riverCalls === undefined
            ? {}
            : {
                riverCallContext: { variant: h.variant, boardCount: 1 },
                retainedRiverCalls: h.riverCalls,
              }),
        },
      });
    }
    for (const hand of entry.pendingCompletions ?? []) {
      if (!ids.has(hand.committedHandId!))
        observations.push({
          at: Math.max(0, ...(hand.actions ?? []).map((a) => a.timestamp ?? 0)),
          hand,
        });
      ids.add(hand.committedHandId!);
    }
    observations.sort(
      (a, b) => a.at - b.at || a.hand.committedHandId!.localeCompare(b.hand.committedHandId!)
    );
    for (const { hand } of observations) this.learnPublic(entry, staged, hand);
    if (
      staged.stats.size > 512 ||
      staged.seenActions.size > 8192 ||
      staged.handFlags.size > 8192 ||
      staged.pairs.size > 2048 ||
      staged.scoped.size > 1024 ||
      staged.exploit.size > 1024 ||
      (staged.winnerReads?.rows.size ?? 0) > 512 ||
      (staged.winnerReads?.seen.size ?? 0) > 8192
    ) {
      if (entry.historyPhase === 'pending') this.flushPending(entry);
      entry.historyPhase = 'unavailable';
      return;
    }
    // Preserve the object and plan maps held by earlier issued requests.
    this.mergeObservations(entry.state, staged);
    entry.completedHandIds = ids;
    entry.pendingCompletions = [];
    entry.historyPhase = 'loaded';
    entry.historyError = false;
    entry.history = {
      digest: packet.digest,
      availableAtMs: packet.availableAtMs,
      hands: packet.hands.length,
      capped: packet.capped || entry.historyTailCapped === true,
    };
    entry.observedAt = Math.max(entry.observedAt, packet.availableAtMs);
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
    const historyEntry = entry.context ? (entry as Entry) : null;
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
      (entry.state.winnerReads?.seen.size ?? 0) > 8192 ||
      (historyEntry?.completedHandIds?.size ?? 0) > 4096
    ) {
      entry.state = HorseMind.createSandbox();
      entry.observedAt = 0;
      if (historyEntry) {
        historyEntry.history = undefined;
        historyEntry.historyPhase = undefined;
        historyEntry.historyAckDigest = undefined;
        historyEntry.historyError = false;
        historyEntry.historyTailCapped = false;
        historyEntry.completedHandIds = new Set();
        historyEntry.pendingCompletions = [];
      }
      disposition = 'capacity_reset';
    }
    if (historyEntry) {
      if (historyEntry.historyPhase === undefined) {
        const empty =
          historyEntry.state.stats.size === 0 && historyEntry.state.handFlags.size === 0;
        historyEntry.historyPhase =
          request.ownPublicHistoryState && request.ownPublicHistoryState !== 'unavailable' && empty
            ? 'pending'
            : 'unavailable';
      }
      if (
        request.ownPublicHistoryState === 'unavailable' &&
        historyEntry.historyPhase === 'pending'
      ) {
        this.flushPending(historyEntry);
        historyEntry.historyPhase = 'unavailable';
      }
      if (
        request.ownPublicHistory &&
        ownPublicHistoryIsValid(
          request.ownPublicHistory,
          historyEntry.context,
          request.decisionTimeMs
        )
      ) {
        try {
          this.hydrate(historyEntry, request.ownPublicHistory);
        } catch {
          if (historyEntry.historyPhase === 'pending') this.flushPending(historyEntry);
          historyEntry.historyError = true;
          historyEntry.historyPhase = 'unavailable';
        }
      }
      if (historyEntry.historyError) disposition = 'history_unavailable';
    }
    const history = historyEntry?.history;
    const pooled = entry.context ? this.publicProfiles.read(request) : null;
    // Public counters use a detached map. Individual observations, dedupe
    // and private plans retain this horse's original ownership.
    const executionState = pooled
      ? { ...entry.state, exploit: new Map(entry.state.exploit) }
      : entry.state;
    if (pooled)
      for (const row of pooled.rows)
        executionState.exploit!.set(
          opponentMemoryKey(row.user_id, row.variant, row.mode, row.size),
          { ...row.counters }
        );
    this.requests.set(request, {
      state: executionState,
      boundary: entry,
      receipt: Object.freeze({
        version: pooled ? 3 : history ? 2 : 1,
        ...(pooled
          ? {
              individualVersion: history ? (2 as const) : (1 as const),
              pooledPublicProfiles: pooled.receipt,
            }
          : {}),
        disposition: pooled && disposition === 'independent' ? 'pooled_public' : disposition,
        context: entry.context,
        cutoffMs: request.decisionTimeMs,
        learnedThroughMs: entry.observedAt,
        history: history ? 'own_public_window' : 'volatile_only',
        ...(history
          ? {
              historyDigest: history.digest,
              historyAvailableAtMs: history.availableAtMs,
              historyHands: history.hands,
              historyCapped: history.capped,
            }
          : {}),
      }),
      historyAckDigest: historyEntry?.historyAckDigest ?? null,
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
      if (historyEntry?.historyPhase === 'pending') {
        const temporary = structuredClone(executionState);
        for (const hand of historyEntry.pendingCompletions ?? [])
          this.learnPublic(historyEntry, temporary, hand);
        return HorseMind.runInSandbox(temporary, fn);
      }
      return HorseMind.runInSandbox(executionState, fn);
    } finally {
      entry.observedAt = Math.max(entry.observedAt, request.decisionTimeMs);
    }
  }
  receipt(request: FastHorseDecisionRequest): HorseObserverReadReceipt | null {
    return this.requests.get(request)?.receipt ?? null;
  }
  historyAcknowledgement(request: FastHorseDecisionRequest): string | null {
    return this.requests.get(request)?.historyAckDigest ?? null;
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
    if (this.completed.has(key)) return 0;
    const entries = this.hands.get(key);
    if (entries?.conflict) return 0;
    const pooledLearned = this.publicProfiles.observe(request);
    const targets = new Set<Entry>();
    if (request.observerParticipants !== undefined) {
      if (
        !observerParticipantsBind(request.observerParticipants, request) ||
        request.observerParticipants.status !== 'bound'
      )
        return 0;
      for (const context of request.observerParticipants.contexts) {
        const entry = this.entries.get(horseObserverReadContextKey(context)!);
        if (entry) targets.add(entry); // no creation of floor-wide observer banks
      }
    } else if (entries) for (const entry of entries.entries) targets.add(entry);
    if (!targets.size) return pooledLearned;
    this.hands.delete(key);
    if (this.completed.size >= this.maxHands)
      this.completed.delete(this.completed.values().next().value!);
    this.completed.add(key);
    let learned = 0;
    for (const entry of targets) {
      const id = request.committedHandId.toLowerCase();
      if (entry.completedHandIds?.has(id)) continue;
      (entry.completedHandIds ??= new Set()).add(id);
      if (entry.historyPhase !== 'loaded') {
        const tail = this.publicCopy(request);
        (entry.pendingCompletions ??= []).push(tail);
        const wasPending = entry.historyPhase === 'pending';
        if (
          entry.pendingCompletions.length > 64 ||
          Buffer.byteLength(JSON.stringify(entry.pendingCompletions)) > 256 * 1024
        ) {
          if (entry.historyPhase === 'pending') this.flushPending(entry);
          entry.historyPhase = 'unavailable';
          while (
            entry.pendingCompletions.length > 64 ||
            Buffer.byteLength(JSON.stringify(entry.pendingCompletions)) > 256 * 1024
          )
            entry.pendingCompletions.shift();
          entry.historyTailCapped = true;
        }
        if (wasPending) {
          entry.observedAt = Math.max(entry.observedAt, this.now());
          learned++;
          continue;
        }
      }
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
    return learned + pooledLearned;
  }
  clear(): void {
    this.publicProfiles.clear();
    this.entries.clear();
    this.hands.clear();
    this.completed.clear();
  }
}
