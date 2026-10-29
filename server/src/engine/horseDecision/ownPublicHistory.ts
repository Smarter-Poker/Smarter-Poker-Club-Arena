import {
  HORSE_HISTORY_LOAD_FAILURES,
  type HorseOwnPublicHistoryLoader,
  type HorseHistoryLoadFailure,
  type HorseHistoryReadProvenance,
  type HorseHistoryReadReason,
} from './ownPublicHistoryProvenance.js';
import {
  HISTORY_ACTIVE_LOADS,
  HISTORY_WINDOW_MAX_BYTES,
  HISTORY_PACKET_MAX_BYTES,
  mainHorseHistoryRetentionBudget,
  type HorseHistoryRetentionBudget,
} from './ownPublicHistoryBudget.js';
import { riverPublicNode } from '../HorseMultiwayRiverRead.js';
import { createHash } from 'node:crypto';
import {
  horseObserverReadContextIsValid,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../HorseObserverReadContext.js';
import type { ActionRecord } from '../../types.js';
import {
  finalRiverCallers,
  riverCallCategoryIsUsable,
  type RiverCallSample,
} from '../HorseRiverCallEvidence.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = HISTORY_WINDOW_MAX_BYTES;
const MAX_HANDS = 64;
export const HORSE_HISTORY_RETRY_COOLDOWN_MS = 60_000;
let activeLoads = 0;
const actions = new Set([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'all_in',
  'sb',
  'bb',
  'blind',
  'ante',
  'straddle',
  'post',
  'kill_blind',
  'return',
]);
const stages = new Set(['preflop', 'flop', 'turn', 'river']);
const positions = new Set([
  'BTN',
  'SB',
  'BB',
  'UTG',
  'UTG+1',
  'UTG+2',
  'UTG+3',
  'MP',
  'LJ',
  'HJ',
  'CO',
]);
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (
  x: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) =>
  required.every((k) => Object.hasOwn(x, k)) &&
  Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clock = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Public information from a hand the observer was originally dealt into.
 * No card field (including another player's showdown) is transported here. */
export interface HorseOwnPublicHand {
  handId: string;
  tableId: string;
  handNumber: number;
  observerId: string;
  observerSeat: number;
  position: string;
  playersDealt: number;
  variant: string;
  format: string;
  playedAtMs: number;
  bigBlind: number;
  actions: Array<ActionRecord & { amount: number; userId: string; timestamp: number }>;
  results: Array<{ user_id: string; net: number }> | null;
  /** Per-hand public categories only. Absent means unavailable on older reads. */
  riverCalls?: RiverCallSample[];
  riverNodeEvidence?: 'captured' | 'unavailable';
}
export interface HorseOwnPublicHistoryWindow {
  version: 1;
  source: 'original_dealt_public_v1';
  context: HorseObserverReadContext;
  capped: boolean;
  hands: HorseOwnPublicHand[];
}
export interface HorseOwnPublicHistoryPacket extends HorseOwnPublicHistoryWindow {
  availableAtMs: number;
  digest: string;
}
function validWindow(value: unknown, availableAtMs: number): value is HorseOwnPublicHistoryWindow {
  if (
    !clock(availableAtMs) ||
    !object(value) ||
    !keys(value, ['version', 'source', 'context', 'capped', 'hands']) ||
    value.version !== 1 ||
    value.source !== 'original_dealt_public_v1' ||
    !horseObserverReadContextIsValid(value.context) ||
    typeof value.capped !== 'boolean' ||
    !Array.isArray(value.hands) ||
    value.hands.length > MAX_HANDS
  )
    return false;
  const context = value.context;
  const seen = new Set<string>();
  const coordinates = new Set<string>();
  let last = -1;
  for (const h of value.hands) {
    if (
      !object(h) ||
      !keys(
        h,
        [
          'handId',
          'tableId',
          'handNumber',
          'observerId',
          'observerSeat',
          'position',
          'playersDealt',
          'variant',
          'format',
          'playedAtMs',
          'bigBlind',
          'actions',
          'results',
        ],
        ['riverCalls', 'riverNodeEvidence']
      ) ||
      typeof h.handId !== 'string' ||
      !UUID.test(h.handId) ||
      seen.has(h.handId.toLowerCase()) ||
      coordinates.has(`${h.tableId}:${h.handNumber}`) ||
      typeof h.tableId !== 'string' ||
      !UUID.test(h.tableId) ||
      !Number.isSafeInteger(h.handNumber) ||
      (h.handNumber as number) < 1000000 ||
      h.observerId !== context.observerId ||
      !Number.isSafeInteger(h.observerSeat) ||
      (h.observerSeat as number) < 1 ||
      (h.observerSeat as number) > 10 ||
      !positions.has(h.position as string) ||
      h.playersDealt !== context.dealtCount ||
      h.variant !== context.variant ||
      h.format !== context.format ||
      !clock(h.playedAtMs) ||
      h.playedAtMs > availableAtMs ||
      h.playedAtMs < last ||
      !finite(h.bigBlind) ||
      h.bigBlind <= 0 ||
      !Array.isArray(h.actions) ||
      h.actions.length > 256
    )
      return false;
    seen.add(h.handId.toLowerCase());
    coordinates.add(`${h.tableId}:${h.handNumber}`);
    last = h.playedAtMs;
    const actorSeats = new Map<string, number>();
    const seatActors = new Map<number, string>();
    for (const a of h.actions) {
      if (
        !object(a) ||
        !keys(
          a,
          ['seat', 'userId', 'action', 'amount', 'stage', 'timestamp'],
          ['isFullRaise', 'publicNode']
        ) ||
        !Number.isSafeInteger(a.seat) ||
        (a.seat as number) < 1 ||
        (a.seat as number) > 10 ||
        typeof a.userId !== 'string' ||
        !UUID.test(a.userId) ||
        !actions.has(a.action as string) ||
        !stages.has(a.stage as string) ||
        !finite(a.amount) ||
        a.amount < 0 ||
        !clock(a.timestamp) ||
        a.timestamp > h.playedAtMs ||
        (a.publicNode !== undefined && (a.stage !== 'river' || !riverPublicNode(a.publicNode))) ||
        (a.isFullRaise !== undefined && typeof a.isFullRaise !== 'boolean')
      )
        return false;
      if (
        (actorSeats.has(a.userId) && actorSeats.get(a.userId) !== a.seat) ||
        (seatActors.has(a.seat as number) && seatActors.get(a.seat as number) !== a.userId)
      )
        return false;
      actorSeats.set(a.userId, a.seat as number);
      seatActors.set(a.seat as number, a.userId);
      if (a.userId === context.observerId && a.seat !== h.observerSeat) return false;
    }
    if (actorSeats.size > context.dealtCount) return false;
    if (
      h.riverNodeEvidence !== undefined &&
      !['captured', 'unavailable'].includes(String(h.riverNodeEvidence))
    )
      return false;
    const nodeCount = h.actions.filter((a) => a.publicNode !== undefined).length;
    if (nodeCount && (h.riverNodeEvidence !== 'captured' || ![2, 4].includes(nodeCount)))
      return false;
    if (h.riverNodeEvidence === 'captured' && ![2, 4].includes(nodeCount)) return false;
    if (h.riverCalls !== undefined) {
      if (!Array.isArray(h.riverCalls) || h.riverCalls.length > context.dealtCount) return false;
      if (
        h.riverCalls.length &&
        !riverCallCategoryIsUsable({ variant: h.variant as string, boardCount: 1 })
      )
        return false;
      const callers = finalRiverCallers(h.actions as HorseOwnPublicHand['actions']);
      const ids = new Set<string>();
      for (const sample of h.riverCalls) {
        if (
          !object(sample) ||
          !keys(sample, ['userId', 'weak']) ||
          typeof sample.userId !== 'string' ||
          !UUID.test(sample.userId) ||
          !callers.has(sample.userId) ||
          ids.has(sample.userId) ||
          typeof sample.weak !== 'boolean'
        )
          return false;
        ids.add(sample.userId);
      }
    }
    if (h.results !== null) {
      if (!Array.isArray(h.results) || h.results.length !== context.dealtCount) return false;
      const ids = new Set<string>();
      for (const r of h.results) {
        if (
          !object(r) ||
          !keys(r, ['user_id', 'net']) ||
          typeof r.user_id !== 'string' ||
          !UUID.test(r.user_id) ||
          ids.has(r.user_id) ||
          !finite(r.net)
        )
          return false;
        ids.add(r.user_id);
      }
      if (!ids.has(context.observerId) || [...actorSeats.keys()].some((id) => !ids.has(id)))
        return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES;
}
/** Journal storage orders object keys; transport insertion order is not
 * evidence. Preserve array order while binding every validated field. */
function canonicalHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHistoryValue);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalHistoryValue(value[key])])
    );
  return value;
}
const digestOf = (value: HorseOwnPublicHistoryWindow & { availableAtMs: number }) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalHistoryValue(value)))
    .digest('hex');
export function makeOwnPublicHistoryPacket(
  value: unknown,
  availableAtMs: number
): HorseOwnPublicHistoryPacket | null {
  if (!validWindow(value, availableAtMs)) return null;
  const body = { ...structuredClone(value), availableAtMs };
  return { ...body, digest: digestOf(body) };
}
export function ownPublicHistoryIsValid(
  value: unknown,
  context: HorseObserverReadContext,
  cutoffMs: number
): value is HorseOwnPublicHistoryPacket {
  if (
    !object(value) ||
    !keys(value, ['version', 'source', 'context', 'capped', 'hands', 'availableAtMs', 'digest']) ||
    !clock(value.availableAtMs) ||
    value.availableAtMs > cutoffMs ||
    !clock(cutoffMs) ||
    horseObserverReadContextKey(value.context) !== horseObserverReadContextKey(context) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    return false;
  const { availableAtMs, digest, ...window } = value;
  const packet = makeOwnPublicHistoryPacket(window, availableAtMs);
  return packet !== null && packet.digest === digest;
}

/** A finite cache loaded by actual requests. The current turn never waits for
 * I/O; a response can enter only a later original snapshot. No timer or repair. */
export interface HorseOwnPublicHistoryCacheStatus {
  owner: 'main';
  entries: number;
  maxEntries: number;
  decodedPacketCount: number;
  serializedPacketCount: number;
  acknowledgedCount: number;
  pendingCount: number;
  retainedSerializedUtf8Bytes: number;
}

export class HorseOwnPublicHistoryCache {
  private disposed = false;
  private readonly entries = new Map<
    string,
    {
      packet?: HorseOwnPublicHistoryPacket;
      serialized?: { json: string; digest: string; availableAtMs: number; utf8Bytes: number };
      acknowledged: boolean;
      settled: boolean;
      retryAfterMs: number;
      reason: HorseHistoryReadReason;
    }
  >();

  constructor(
    private readonly load: HorseOwnPublicHistoryLoader,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2048,
    private readonly retentionBudget: HorseHistoryRetentionBudget = mainHorseHistoryRetentionBudget
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2048)
      throw Error('Invalid individual history cache bound');
  }
  forSnapshot(
    context: HorseObserverReadContext,
    cutoffMs: number
  ): HorseOwnPublicHistoryPacket | undefined {
    if (this.disposed) return undefined;
    const key = horseObserverReadContextKey(context);
    if (!key || !clock(cutoffMs)) return undefined;
    const known = this.entries.get(key);
    if (
      known &&
      (!known.settled || known.packet || known.serialized || cutoffMs < known.retryAfterMs)
    ) {
      if (known.acknowledged) return undefined;
      if (known.packet && known.packet.availableAtMs <= cutoffMs)
        return structuredClone(known.packet);
      if (known.serialized && known.serialized.availableAtMs <= cutoffMs)
        return JSON.parse(known.serialized.json) as HorseOwnPublicHistoryPacket;
      return undefined;
    }
    if (activeLoads >= HISTORY_ACTIVE_LOADS) {
      if (known) known.reason = 'retry_load_capacity';
      return undefined;
    }
    if (!known && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.retentionBudget.release(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
    if (known) this.retentionBudget.release(known);
    const entry: {
      packet?: HorseOwnPublicHistoryPacket;
      serialized?: { json: string; digest: string; availableAtMs: number; utf8Bytes: number };
      acknowledged: boolean;
      settled: boolean;
      retryAfterMs: number;
      reason: HorseHistoryReadReason;
    } = {
      acknowledged: false,
      settled: false,
      reason: 'loading',
      retryAfterMs: cutoffMs + HORSE_HISTORY_RETRY_COOLDOWN_MS,
    };
    const evict = () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      entry.packet = undefined;
      entry.serialized = undefined;
    };
    const reserve = (bytes: number) =>
      this.retentionBudget.reserve(entry, bytes, evict, (reason) => {
        entry.reason =
          reason === 'retention_capacity' ? 'retention_capacity' : `retention_${reason}`;
      });
    if (!reserve(HISTORY_PACKET_MAX_BYTES)) {
      entry.settled = true;
      entry.retryAfterMs = this.now() + HORSE_HISTORY_RETRY_COOLDOWN_MS;
      this.entries.set(key, entry);
      return undefined;
    }
    this.entries.set(key, entry);
    activeLoads++;
    const settle = () => {
      if (entry.settled) return;
      entry.settled = true;
      activeLoads--;
      try {
        entry.retryAfterMs = this.now() + HORSE_HISTORY_RETRY_COOLDOWN_MS;
      } catch {
        /* retain request boundary */
      }
    };
    try {
      void this.load(Object.freeze({ ...context }), (reason: HorseHistoryLoadFailure) => {
        if (HORSE_HISTORY_LOAD_FAILURES.includes(reason)) entry.reason = reason;
      })
        .then((value) => {
          if (this.entries.get(key) !== entry) return;
          const packet = makeOwnPublicHistoryPacket(value, this.now());
          if (packet && horseObserverReadContextKey(packet.context) === key) {
            const bytes = Buffer.byteLength(JSON.stringify(packet));
            if (bytes <= HISTORY_PACKET_MAX_BYTES && reserve(bytes)) {
              entry.packet = packet;
              entry.reason = 'packet_ready';
            } else {
              if (bytes > HISTORY_PACKET_MAX_BYTES) entry.reason = 'packet_size_refused';
              this.retentionBudget.release(entry);
            }
          } else {
            if (entry.reason === 'loading')
              entry.reason = packet ? 'context_mismatch' : 'invalid_window';
            this.retentionBudget.release(entry);
          }
        })
        .catch(() => {
          // Both transport rejection and response-processing failure leave
          // this observer explicitly unavailable, never a partial history.
          entry.packet = undefined;
          if (entry.reason === 'loading') entry.reason = 'load_rejected';
          this.retentionBudget.release(entry);
        })
        .finally(settle);
    } catch {
      if (entry.reason === 'loading') entry.reason = 'load_thrown';
      this.retentionBudget.release(entry);
      settle();
    }
    return undefined;
  }
  /** Only bounded scalar entry metadata is visited; payloads are not serialized here. */
  status(): HorseOwnPublicHistoryCacheStatus {
    const result: HorseOwnPublicHistoryCacheStatus = {
      owner: 'main',
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      decodedPacketCount: 0,
      serializedPacketCount: 0,
      acknowledgedCount: 0,
      pendingCount: 0,
      retainedSerializedUtf8Bytes: 0,
    };
    for (const entry of this.entries.values()) {
      if (entry.packet) result.decodedPacketCount++;
      if (entry.serialized) {
        result.serializedPacketCount++;
        result.retainedSerializedUtf8Bytes += entry.serialized.utf8Bytes;
      }
      if (entry.acknowledged) result.acknowledgedCount++;
      if (!entry.settled) result.pendingCount++;
    }
    return result;
  }
  /** Terminal client close only. A worker's null ACK is NOT cache disposal. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.retentionBudget.release(entry);
      entry.packet = undefined;
      entry.serialized = undefined;
    }
    this.entries.clear();
  }
  state(context: HorseObserverReadContext): 'pending' | 'available' | 'unavailable' {
    if (this.disposed) return 'unavailable';
    const key = horseObserverReadContextKey(context);
    const entry = key ? this.entries.get(key) : undefined;
    return entry?.packet || entry?.serialized
      ? 'available'
      : entry?.settled
        ? 'unavailable'
        : 'pending';
  }
  /** Called immediately after forSnapshot on the same synchronous request boundary.
   * This describes the cache path, never worker hydration or durable persistence. */
  provenance(context: HorseObserverReadContext, cutoffMs: number): HorseHistoryReadProvenance {
    const key = horseObserverReadContextKey(context);
    if (!key || !clock(cutoffMs)) throw Error('Invalid individual history provenance context');
    const entry = this.entries.get(key);
    const state = this.state(context);
    const availableAt = entry?.packet?.availableAtMs ?? entry?.serialized?.availableAtMs;
    const reason: HorseHistoryReadReason = this.disposed
      ? 'cache_disposed'
      : availableAt !== undefined
        ? entry?.acknowledged
          ? 'worker_acknowledged'
          : availableAt > cutoffMs
            ? 'packet_after_cutoff'
            : 'packet_ready'
        : entry?.settled
          ? entry.reason
          : entry
            ? 'loading'
            : 'load_capacity';
    return Object.freeze({
      version: 1,
      context: Object.freeze({ ...context }),
      decisionTimeMs: cutoffMs,
      state,
      reason,
    });
  }
  acknowledge(context: HorseObserverReadContext, digest: string | null): void {
    const key = horseObserverReadContextKey(context);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) return;
    entry.acknowledged =
      digest !== null && digest === (entry.packet?.digest ?? entry.serialized?.digest);
    if (entry.acknowledged && entry.packet) {
      // Keep the exact original window for a worker's later null ACK (eviction
      // or restart), but stop retaining its decoded graph after delivery.
      // Each client owns its ACK; another worker never acknowledges this one.
      const json = JSON.stringify(entry.packet);
      entry.serialized = {
        json,
        utf8Bytes: Buffer.byteLength(json),
        digest: entry.packet.digest,
        availableAtMs: entry.packet.availableAtMs,
      };
      entry.packet = undefined;
    }
  }
}
