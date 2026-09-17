import type { HorseExecutionWitness } from './HorseExecutionWitness.js';
import type { CompletedHandObservation } from './horseDecision/protocol.js';
import { noteFire } from './BrainTelemetry.js';
import { performance } from 'node:perf_hooks';
import {
  bindHorseDecisionToCommittedHand,
  horseCompletedHandKey,
  horseHandAnchorKey,
  type HorseDecisionHandBinding,
} from './HorseDecisionHandBinding.js';

/** Memory-only reconciliation until the private durable decision journal owns
 * these receipts. Keep this boundary explicit: observing a hand does not make
 * the decision input durable or establish a complete capture population. */
export class HorseCommittedDecisionTracker {
  private readonly entries = new Map<HorseExecutionWitness, { at: number; key: string }>();
  private readonly hands = new Map<string, Set<HorseExecutionWitness>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private lastNow = 0;
  constructor(
    private readonly deps: {
      now?: () => number;
      note?: (feature: string) => void;
      maxEntries?: number;
      ttlMs?: number;
    } = {}
  ) {
    this.maxEntries = Math.max(1, Math.min(8192, Math.floor(deps.maxEntries ?? 8192)));
    this.ttlMs = Math.max(1, Math.min(3_600_000, Math.floor(deps.ttlMs ?? 3_600_000)));
    if (!Number.isFinite(this.maxEntries) || !Number.isFinite(this.ttlMs))
      throw Error('invalid Horse binding limits');
  }

  private assign(witness: HorseExecutionWitness, next: HorseDecisionHandBinding): void {
    if (JSON.stringify(witness.committedHand) === JSON.stringify(next)) return;
    witness.committedHand = Object.freeze(next);
    try {
      (this.deps.note ?? noteFire)(
        `phase15_hand_binding_${next.status === 'unavailable' ? next.reason : next.status}`
      );
    } catch {
      /* audit counters cannot endanger a live hand */
    }
  }

  private evict(
    witness: HorseExecutionWitness,
    reason: 'tracking_expired' | 'tracking_capacity'
  ): void {
    const entry = this.entries.get(witness);
    if (!entry) return;
    this.entries.delete(witness);
    const hand = this.hands.get(entry.key);
    hand?.delete(witness);
    if (hand?.size === 0) this.hands.delete(entry.key);
    if (witness.committedHand.status === 'pending')
      this.assign(witness, { status: 'unavailable', reason });
  }

  private expire(now: number): void {
    for (const [witness, entry] of this.entries) {
      if (now - entry.at < this.ttlMs) break;
      this.evict(witness, 'tracking_expired');
    }
  }

  private now(): number {
    const value = (this.deps.now ?? (() => performance.now()))();
    if (Number.isFinite(value)) this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }

  track(witness: HorseExecutionWitness): void {
    const anchor = witness.handAnchor;
    if (anchor.status !== 'anchored') {
      this.assign(witness, anchor);
      return;
    }
    const now = this.now();
    this.expire(now);
    if (this.entries.has(witness)) return;
    while (this.entries.size >= this.maxEntries)
      this.evict(this.entries.keys().next().value!, 'tracking_capacity');
    const key = horseHandAnchorKey(anchor);
    this.entries.set(witness, { at: now, key });
    const hand = this.hands.get(key) ?? new Set<HorseExecutionWitness>();
    hand.add(witness);
    this.hands.set(key, hand);
  }

  observe(hand: CompletedHandObservation): void {
    this.expire(this.now());
    const key = horseCompletedHandKey(hand);
    if (!key) return;
    const matched = new Map<string, HorseExecutionWitness[]>();
    const proposed = new Map<HorseExecutionWitness, HorseDecisionHandBinding>();
    const ambiguousOrdinals = new Set<number>();
    for (const witness of this.hands.get(key) ?? []) {
      // A contradiction is terminal for this receipt. Do not pick the first
      // or latest of two different committed IDs for one accepted action.
      const previous = witness.committedHand;
      if (
        previous.status === 'unavailable' &&
        ['committed_identity_conflict', 'multiple_decisions_for_action'].includes(previous.reason)
      ) {
        if (
          previous.reason === 'multiple_decisions_for_action' &&
          witness.handAnchor.status === 'anchored'
        )
          ambiguousOrdinals.add(witness.handAnchor.actionOrdinal);
        continue;
      }
      const next = bindHorseDecisionToCommittedHand(witness, hand);
      if (previous.status === 'bound' && JSON.stringify(previous) !== JSON.stringify(next))
        proposed.set(witness, { status: 'unavailable', reason: 'committed_identity_conflict' });
      else proposed.set(witness, next);
      if (next.status === 'bound') {
        const id = next.observationId;
        const group = matched.get(id) ?? [];
        group.push(witness);
        matched.set(id, group);
      }
    }
    for (const group of matched.values())
      if (group.length > 1)
        for (const witness of group)
          proposed.set(witness, { status: 'unavailable', reason: 'multiple_decisions_for_action' });
    for (const [witness, next] of proposed) {
      if (next.status === 'bound' && ambiguousOrdinals.has(next.actionOrdinal))
        this.assign(witness, { status: 'unavailable', reason: 'multiple_decisions_for_action' });
      else this.assign(witness, next);
    }
  }
}
