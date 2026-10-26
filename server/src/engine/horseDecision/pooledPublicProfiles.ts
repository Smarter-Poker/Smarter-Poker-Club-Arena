import { createHash } from 'node:crypto';
import {
  opponentMemoryKey,
  opponentProfileVersion,
  validOpponentProfile,
  type DurableOpponentProfile,
} from '../HorseOpponentMemory.js';
import { horseCompletedHandKey } from '../HorseDecisionHandBinding.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import { observerParticipantsBind } from './observerParticipants.js';
import type { FastHorseDecisionRequest, ObserveCompletedHandRequest } from './protocol.js';

export interface PooledPublicProfileReceipt {
  version: 1;
  source: 'accepted_hand_public_profiles';
  availableAtMs: number;
  digest: string;
  profiles: number;
}
/** Owner-authorized herd notes. Public aggregate counters only; no card,
 * decision-plan, wager or caller-authored FAST packet enters this cache.
 * The existing accepted-hand broadcaster supplies every worker. No IO,
 * timer, donor inference or private observer state is needed on the turn. */
export class PooledPublicProfiles {
  private readonly rows = new Map<string, { profile: DurableOpponentProfile; at: number }>();
  private readonly seen = new Set<string>();
  private lastAt = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 20000
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 20000)
      throw Error('Invalid public profile capacity');
  }
  observe(hand: ObserveCompletedHandRequest): number {
    const key = horseCompletedHandKey(hand);
    const participants = hand.observerParticipants;
    const at = this.now();
    const profiles = hand.durableOpponentProfiles;
    if (
      !key ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        hand.committedHandId ?? ''
      ) ||
      !Number.isSafeInteger(at) ||
      at < this.lastAt ||
      this.seen.has(key) ||
      !observerParticipantsBind(participants, hand) ||
      participants.status !== 'bound' ||
      !Array.isArray(hand.actions) ||
      hand.actions.length > 4096 ||
      !Array.isArray(profiles) ||
      profiles.length > 10 ||
      new Set(profiles.map((p) => p?.user_id)).size !== profiles.length
    )
      return 0;
    const context = participants.contexts[0]!;
    const mode = context.format === 'cash' ? 'cash' : 'tournament';
    const size = context.dealtCount <= 2 ? 'hu' : context.dealtCount <= 5 ? 'short' : 'full';
    const actors = new Set(hand.actions?.map((a) => a.userId));
    if (
      profiles.some(
        (p) =>
          !validOpponentProfile(p) ||
          p.variant !== context.variant ||
          p.mode !== mode ||
          p.size !== size ||
          !actors.has(p.user_id)
      )
    )
      return 0;
    this.lastAt = at;
    this.seen.add(key);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!);
    let learned = 0;
    for (const p of profiles) {
      const k = opponentMemoryKey(p.user_id, p.variant, p.mode, p.size);
      const previous = this.rows.get(k);
      if (previous && opponentProfileVersion(previous.profile) >= opponentProfileVersion(p))
        continue;
      this.rows.delete(k);
      this.rows.set(k, {
        profile: {
          user_id: p.user_id,
          variant: p.variant,
          mode: p.mode,
          size: p.size,
          observed_hands: p.observed_hands,
          initialized: p.initialized,
          counters: { ...p.counters },
        },
        at,
      });
      learned++;
    }
    while (this.rows.size > this.capacity) this.rows.delete(this.rows.keys().next().value!);
    return learned;
  }
  read(
    request: FastHorseDecisionRequest
  ): { rows: DurableOpponentProfile[]; receipt: PooledPublicProfileReceipt } | null {
    const context = horseObserverReadContextFromRequest(request);
    if (!context || !Number.isSafeInteger(request.decisionTimeMs) || request.decisionTimeMs < 0)
      return null;
    const mode = context.format === 'cash' ? 'cash' : 'tournament';
    const size = context.dealtCount <= 2 ? 'hu' : context.dealtCount <= 5 ? 'short' : 'full';
    const rows: DurableOpponentProfile[] = [];
    let availableAtMs = 0;
    for (const player of request.gameState.players) {
      if (
        !request.gameState.dealtSeatIds?.includes(player.seat) ||
        player.user_id === context.observerId
      )
        continue;
      const found = this.rows.get(
        opponentMemoryKey(
          player.user_id,
          context.variant as DurableOpponentProfile['variant'],
          mode,
          size
        )
      );
      // A newer receipt is unavailable to an older queued snapshot. Never
      // substitute it or relabel its availability with the decision clock.
      if (!found || found.at > request.decisionTimeMs) continue;
      rows.push(structuredClone(found.profile));
      availableAtMs = Math.max(availableAtMs, found.at);
    }
    if (!rows.length) return null;
    rows.sort((a, b) => a.user_id.localeCompare(b.user_id));
    return {
      rows,
      receipt: {
        version: 1,
        source: 'accepted_hand_public_profiles',
        availableAtMs,
        digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        profiles: rows.length,
      },
    };
  }
  clear(): void {
    this.rows.clear();
    this.seen.clear();
    this.lastAt = 0;
  }
}
