/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CrossNodeBus — cross-worker / cross-node pub-sub abstraction
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A thin, transport-agnostic pub-sub seam for platform-wide events that must
 * fan out across every compute worker and (eventually) every node:
 *
 *   - lobby updates (table lists, seat counts)
 *   - club presence (online / at_table / away)
 *   - waitlists (a seat opened at table X)
 *   - tournament coordination (registration, hand-for-hand pause/resume,
 *     table-balancing directives, break sync)
 *
 * Today the whole platform runs in one process, so events are delivered in-
 * memory via an EventEmitter (`InMemoryCrossNodeBus`) — this is real, working
 * code used now. The point of the interface is that the day we move to multi-
 * node, we swap in a `RedisCrossNodeBus` / `NatsCrossNodeBus` that implements
 * the SAME `CrossNodeBus` interface and nothing above it changes. The existing
 * `ChannelHub` (/ws/channel) becomes a *consumer* of this bus rather than the
 * source of truth: a node publishes a presence change to the bus, every node
 * receives it and pushes to its locally-connected WebSocket clients.
 *
 * Delivery semantics (in-memory impl): synchronous, at-most-once, best-effort,
 * ordered per topic. Handlers are isolated — a throwing handler is reported via
 * the onError hook and does not stop other handlers. A distributed adapter
 * would provide at-least-once fan-out and MUST use `nodeId` / `BusEnvelope.
 * senderId` to drop self-echoes (see the RedisBusTransport seam below).
 *
 * Standalone by design: imports nothing from the engine/server.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Envelope wrapping every published payload. */
export interface BusEnvelope<T = unknown> {
  topic: string;
  payload: T;
  /** ms epoch when published. */
  publishedAt: number;
  /** nodeId of the publisher — used by distributed adapters to drop echoes. */
  senderId: string;
  /** unique id per message (dedupe key for at-least-once transports). */
  messageId: string;
}

export type BusHandler<T = unknown> = (payload: T, envelope: BusEnvelope<T>) => void;

export interface Subscription {
  readonly topic: string;
  unsubscribe(): void;
}

export interface CrossNodeBus {
  /** This node's stable id. Distributed adapters use it to ignore self-echo. */
  readonly nodeId: string;

  /** Publish a payload to a topic. May be async on network transports. */
  publish<T>(topic: string, payload: T): void | Promise<void>;

  /** Subscribe to an exact topic. Returns a handle to unsubscribe. */
  subscribe<T>(topic: string, handler: BusHandler<T>): Subscription;

  /**
   * Subscribe to every topic beginning with `prefix` (e.g. "presence.").
   * Enables one handler to watch a whole family of topics.
   */
  subscribePattern<T>(prefix: string, handler: BusHandler<T>): Subscription;

  /** Tear down all subscriptions and release transport resources. */
  close(): Promise<void>;
}

/**
 * Canonical topic names / builders. Keeping these in one place stops workers
 * from disagreeing on channel strings once they're in separate processes.
 */
export const Topics = {
  lobby: 'lobby.update',
  presence: (clubId: string) => `presence.${clubId}`,
  presenceAll: 'presence.',
  waitlist: (tableId: string) => `waitlist.${tableId}`,
  waitlistAll: 'waitlist.',
  tournament: (tournamentId: string) => `tournament.${tournamentId}`,
  tournamentAll: 'tournament.',
} as const;

// ─── In-memory implementation (works today, single process) ──────────────────

export interface InMemoryBusOptions {
  nodeId?: string;
  /** Called when a subscriber handler throws. Defaults to console.error. */
  onError?: (err: unknown, envelope: BusEnvelope) => void;
}

export class InMemoryCrossNodeBus implements CrossNodeBus {
  readonly nodeId: string;
  private readonly emitter = new EventEmitter();
  private readonly patternHandlers = new Map<string, Set<BusHandler>>();
  private readonly onError: (err: unknown, envelope: BusEnvelope) => void;
  private closed = false;

  constructor(opts: InMemoryBusOptions = {}) {
    this.nodeId = opts.nodeId ?? `node-${randomUUID().slice(0, 8)}`;
    this.onError =
      opts.onError ??
      ((err, env) => console.error(`[CrossNodeBus] handler error on "${env.topic}":`, err));
    // Presence/waitlist/tournament fan-out can legitimately have many workers.
    this.emitter.setMaxListeners(0);
  }

  publish<T>(topic: string, payload: T): void {
    if (this.closed) return;
    const envelope: BusEnvelope<T> = {
      topic,
      payload,
      publishedAt: Date.now(),
      senderId: this.nodeId,
      messageId: randomUUID(),
    };
    this.emitter.emit(topic, payload, envelope);
    // Pattern subscribers whose prefix matches this topic.
    for (const [prefix, handlers] of this.patternHandlers) {
      if (topic.startsWith(prefix)) {
        for (const h of handlers) this.safeInvoke(h as BusHandler<T>, payload, envelope);
      }
    }
  }

  subscribe<T>(topic: string, handler: BusHandler<T>): Subscription {
    const wrapped = (payload: T, envelope: BusEnvelope<T>) =>
      this.safeInvoke(handler, payload, envelope);
    this.emitter.on(topic, wrapped as (...args: unknown[]) => void);
    return {
      topic,
      unsubscribe: () => this.emitter.off(topic, wrapped as (...args: unknown[]) => void),
    };
  }

  subscribePattern<T>(prefix: string, handler: BusHandler<T>): Subscription {
    let set = this.patternHandlers.get(prefix);
    if (!set) {
      set = new Set();
      this.patternHandlers.set(prefix, set);
    }
    set.add(handler as BusHandler);
    return {
      topic: `${prefix}*`,
      unsubscribe: () => {
        const s = this.patternHandlers.get(prefix);
        if (s) {
          s.delete(handler as BusHandler);
          if (s.size === 0) this.patternHandlers.delete(prefix);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.removeAllListeners();
    this.patternHandlers.clear();
  }

  private safeInvoke<T>(handler: BusHandler<T>, payload: T, envelope: BusEnvelope<T>): void {
    try {
      handler(payload, envelope);
    } catch (err) {
      this.onError(err, envelope as BusEnvelope);
    }
  }
}

// ─── Distributed adapter seam (future — needs infra provisioning) ────────────

/**
 * The one interface a distributed adapter needs to satisfy. A `RedisCrossNodeBus`
 * or `NatsCrossNodeBus` is a small class that:
 *
 *   1. On publish → serialize BusEnvelope to JSON and PUBLISH to `topic`
 *      (Redis pub/sub or NATS subject). For pattern subs use Redis PSUBSCRIBE
 *      (`prefix*`) or NATS wildcard subjects (`prefix.>`).
 *   2. On receive → JSON.parse, and **drop the message if envelope.senderId ===
 *      this.nodeId** (self-echo) so a node doesn't reprocess its own publishes.
 *   3. Fan the payload out to the matching local handlers (identical to the
 *      in-memory impl's dispatch).
 *
 * Nothing above this line changes when the adapter is swapped in. The transport
 * below is the ONLY thing that touches the network; keeping it this thin is what
 * makes the swap a config change rather than a rewrite.
 *
 * NOTE: intentionally NOT implemented here — it requires a provisioned Redis or
 * NATS cluster (see README "Infra decisions"). Provide a factory like:
 *
 *   export function createRedisCrossNodeBus(opts): CrossNodeBus { ... }
 *
 * that constructs the transport, then reuses the exact dispatch logic above.
 */
export interface BusTransport {
  /** Publish raw bytes/string to the wire for `topic`. */
  publishRaw(topic: string, data: string): Promise<void>;
  /** Subscribe to an exact wire topic; invoke cb with raw data. */
  subscribeRaw(topic: string, cb: (data: string) => void): Promise<() => void>;
  /** Subscribe to a wire pattern (prefix); invoke cb with (topic, data). */
  subscribePatternRaw(
    prefix: string,
    cb: (topic: string, data: string) => void
  ): Promise<() => void>;
  close(): Promise<void>;
}
