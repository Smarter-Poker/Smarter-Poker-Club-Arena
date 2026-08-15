/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TableStateHub — in-process pub/sub for authoritative game state
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Purpose
 * -------
 * Provides the single in-process fan-out from ServerTableEngine events to every
 * subscribed WebSocket connection for a given tableId. This is the replacement
 * for the Supabase Realtime "broadcast channel" path used today.
 *
 * Responsibilities
 *   1. Maintain a set of subscribers per tableId.
 *   2. Hand each new subscriber the latest SNAPSHOT immediately (no wait for
 *      the next engine event).
 *   3. Assign a monotonic `seq` number per tableId for every publish, so the
 *      client can detect gaps and request a RESYNC.
 *   4. Compute deltas via RFC-6902 JSON Patch against the last snapshot.
 *   5. Offer cheap metrics (subscriber count, last seq, last publish time).
 *
 * Non-goals
 *   - Does not know about WebSockets directly — accepts any object implementing
 *     the minimal `HubSubscriber` interface. Keeps this class trivially unit-
 *     testable without a ws server.
 *   - Does not persist. Server restart → seq resets to 0, forced RESYNC.
 *     (See Phase 1.1 spec §10 Q2.)
 *   - Does not authenticate. EngineWebSocketServer does JWT checks before
 *     calling .subscribe().
 *   - Does not scrub per-player data (hole cards). The state published to the
 *     Hub is already the public-scrubbed shape from ServerTableEngine.
 */

// fast-json-patch ships as CommonJS; Node-ESM can only import it as a
// default import, so destructure `compare` from the default export.
import jsonPatch from 'fast-json-patch';
import type { Operation as JsonPatchOperation } from 'fast-json-patch';
const { compare } = jsonPatch;

// ─── Types ────────────────────────────────────────────────────────────────────

export type GameStateSnapshot = Record<string, unknown>;

export interface SnapshotMessage {
  type: 'SNAPSHOT';
  tableId: string;
  seq: number;
  state: GameStateSnapshot;
}

export interface DeltaMessage {
  type: 'DELTA';
  tableId: string;
  seq: number;
  prev: number;
  patch: JsonPatchOperation[];
}

export interface EventMessage {
  type: 'EVENT';
  tableId: string;
  payload: Record<string, unknown>;
}

export type HubMessage = SnapshotMessage | DeltaMessage | EventMessage;

/**
 * Minimal interface a subscriber must satisfy.
 * The ws WebSocket class already has `.send` and `.readyState`, so a real
 * ws.WebSocket object is a valid HubSubscriber as-is.
 */
export interface HubSubscriber {
  readonly id: string;
  readonly readyState: number; // ws.OPEN === 1
  /**
   * B12: bytes queued in the socket's send buffer but not yet flushed to the
   * network. `ws.WebSocket` exposes this natively; it is optional here so test
   * doubles stay trivial (an absent value is read as 0, i.e. "not backed up").
   */
  readonly bufferedAmount?: number;
  send(data: string): void;
}

/**
 * B12 — WebSocket backpressure thresholds.
 *
 * There was no backpressure at all: every publish called `send` on every
 * subscriber regardless of how far behind they were, so one slow consumer grew
 * an unbounded send buffer full of full-state deltas until the process ran out
 * of memory. Nothing anywhere read `bufferedAmount`.
 *
 * SOFT: stop sending DELTA/EVENT to a socket this far behind. Dropping a DELTA
 * is safe by design — the client sees the seq gap and asks for a RESYNC, which
 * is the same recovery path a dropped packet already triggers. SNAPSHOTs are
 * never dropped, because a snapshot is how a gapped client gets well again.
 *
 * HARD: the socket is hopeless. Evict it; the client reconnects and resubscribes
 * from a clean snapshot, which is cheaper than holding megabytes for it.
 */
const HUB_SOFT_BACKPRESSURE_BYTES = 256 * 1024;
const HUB_HARD_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/**
 * Per-tableId bookkeeping stored on the hub.
 */
interface TableRoom {
  tableId: string;
  subscribers: Set<HubSubscriber>;
  lastSnapshot: GameStateSnapshot | null;
  lastSeq: number;
  lastPublishedAt: number;
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

export class TableStateHub {
  private rooms: Map<string, TableRoom> = new Map();
  /** B12: messages skipped because a socket was backed up past the soft limit. */
  private softDropped = 0;
  /** B12: subscribers evicted because a socket blew past the hard limit. */
  private hardDropped = 0;

  /**
   * Publish a new authoritative state for the table.
   * First publish for a table → sends SNAPSHOT to all subscribers.
   * Subsequent publishes → computes JSON Patch diff, sends DELTA.
   * Messages go out to every OPEN subscriber; closed subscribers are evicted.
   */
  publish(tableId: string, state: GameStateSnapshot): number {
    const room = this.getOrCreateRoom(tableId);
    const prev = room.lastSeq;
    const next = prev + 1;

    let message: HubMessage;
    if (!room.lastSnapshot) {
      message = { type: 'SNAPSHOT', tableId, seq: next, state };
    } else {
      const patch = compare(room.lastSnapshot, state) as JsonPatchOperation[];
      // ROUND 25 FIX (Bible V8 §6 reconnect FSM): no-op publishes (empty patch)
      // MUST NOT advance seq, otherwise the next real DELTA carries
      // prev=lastSeq+N which the client sees as a gap — triggering a spurious
      // resync (full snapshot resend) on every "engine ticked but state didn't
      // change" cycle. Liveness is signalled by lastPublishedAt + the next
      // real DELTA, not by seq numbers the client never sees. Just bump
      // the timestamp and bail.
      if (patch.length === 0) {
        room.lastPublishedAt = Date.now();
        return prev;
      }
      message = { type: 'DELTA', tableId, seq: next, prev, patch };
    }

    room.lastSnapshot = structuredClone(state);
    room.lastSeq = next;
    room.lastPublishedAt = Date.now();

    this.broadcast(room, message);
    return next;
  }

  /**
   * Attach a subscriber to a table. The subscriber immediately receives a
   * SNAPSHOT of the current state if one exists. If the table has never
   * published, the subscriber is held and receives the next publish.
   */
  subscribe(tableId: string, sub: HubSubscriber): void {
    const room = this.getOrCreateRoom(tableId);
    room.subscribers.add(sub);
    if (room.lastSnapshot) {
      const snap: SnapshotMessage = {
        type: 'SNAPSHOT',
        tableId,
        seq: room.lastSeq,
        state: room.lastSnapshot,
      };
      this.safeSend(sub, JSON.stringify(snap));
    }
  }

  /**
   * Remove a subscriber from a table. Safe to call with unknown ids.
   */
  unsubscribe(tableId: string, sub: HubSubscriber): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    room.subscribers.delete(sub);
  }

  /**
   * Remove a subscriber from every table it was attached to. Call on ws.close.
   */
  unsubscribeAll(sub: HubSubscriber): void {
    for (const room of this.rooms.values()) room.subscribers.delete(sub);
  }

  /**
   * Emit a transient event (e.g. time bank timeout, insurance offer) to all subscribers.
   */
  emitEvent(tableId: string, payload: Record<string, unknown>): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    this.broadcast(room, { type: 'EVENT', tableId, payload });
  }

  /**
   * Re-send the latest snapshot to a single subscriber. Used when the client
   * sends RESYNC after detecting a gap.
   */
  resync(tableId: string, sub: HubSubscriber): boolean {
    const room = this.rooms.get(tableId);
    if (!room || !room.lastSnapshot) return false;
    const snap: SnapshotMessage = {
      type: 'SNAPSHOT',
      tableId,
      seq: room.lastSeq,
      state: room.lastSnapshot,
    };
    this.safeSend(sub, JSON.stringify(snap));
    return true;
  }

  /**
   * Drop all state for a table. Call when the engine shuts down a table.
   */
  /**
   * 2026-08-15 CRITICAL FIX. This used to `rooms.delete(tableId)` outright.
   *
   * It is called on every engine teardown — watchdog kill, zombie rebuild,
   * failed start, tournament table break — all of which happen while players
   * are still connected. Deleting the room destroyed its subscriber Set, and
   * there is exactly ONE `hub.subscribe` call site in the server: a NEW
   * WebSocket upgrade. Nothing re-subscribes an existing socket. So the rebuilt
   * engine published into a fresh, empty room while every player's socket
   * stayed open and perfectly healthy — the server PINGs, the client PONGs, and
   * the client receives no SNAPSHOT, no DELTA and no EVENT ever again.
   *
   * That is why a table could look frozen to players even after the server had
   * fully recovered. Keep the room and its subscribers; reset only the sequence
   * state so the next publish is a full SNAPSHOT rather than a DELTA against a
   * pre-restart baseline, and tell the clients why they are about to see a
   * sequence reset.
   */
  dropTable(tableId: string): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    if (room.subscribers.size === 0) {
      this.rooms.delete(tableId);
      return;
    }
    room.lastSnapshot = null;
    room.lastSeq = 0;
    try {
      this.broadcast(room, {
        type: 'EVENT',
        tableId,
        payload: { type: 'engine_restarting' },
      } as HubMessage);
    } catch {
      /* delivery is best-effort; the room reset is the point */
    }
  }

  // ─── Metrics helpers — used by /health and tests ───────────────────────────

  subscriberCount(tableId: string): number {
    return this.rooms.get(tableId)?.subscribers.size ?? 0;
  }

  totalSubscribers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.subscribers.size;
    return n;
  }

  lastSeq(tableId: string): number {
    return this.rooms.get(tableId)?.lastSeq ?? 0;
  }

  hasSnapshot(tableId: string): boolean {
    return !!this.rooms.get(tableId)?.lastSnapshot;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private getOrCreateRoom(tableId: string): TableRoom {
    let room = this.rooms.get(tableId);
    if (!room) {
      room = {
        tableId,
        subscribers: new Set(),
        lastSnapshot: null,
        lastSeq: 0,
        lastPublishedAt: 0,
      };
      this.rooms.set(tableId, room);
    }
    return room;
  }

  /**
   * 2026-08-15: JSON.stringify is done ONCE for the whole room (C16 perf opt),
   * so a throw here took down delivery for every subscriber AND propagated
   * synchronously into broadcastCurrentState's ~16 mostly-unguarded call sites.
   * Delivery is best-effort; the engine is not.
   */
  private broadcast(room: TableRoom, message: HubMessage): void {
    // C16: serialize ONCE for the whole room. This used to sit inside safeSend,
    // i.e. inside the per-subscriber loop, so a table with a dozen spectators
    // re-stringified the same full-state payload a dozen times per publish. The
    // message is identical for every subscriber — the Hub publishes the already
    // public-scrubbed shape — so there is nothing per-subscriber to serialize.
    const payload = JSON.stringify(message);

    // B12: a SNAPSHOT is the recovery path for a client that has missed
    // messages, so it is never dropped. DELTA and EVENT are catch-up-able.
    const droppable = message.type !== 'SNAPSHOT';

    const dead: HubSubscriber[] = [];
    for (const sub of room.subscribers) {
      if (sub.readyState !== 1 /* ws.OPEN */) {
        dead.push(sub);
        continue;
      }
      const buffered = sub.bufferedAmount ?? 0;
      if (buffered > HUB_HARD_BACKPRESSURE_BYTES) {
        // Beyond saving — evict rather than keep buffering for it.
        this.hardDropped++;
        dead.push(sub);
        continue;
      }
      if (droppable && buffered > HUB_SOFT_BACKPRESSURE_BYTES) {
        this.softDropped++;
        continue;
      }
      this.safeSend(sub, payload);
    }
    for (const d of dead) room.subscribers.delete(d);
  }

  private safeSend(sub: HubSubscriber, payload: string): void {
    try {
      sub.send(payload);
    } catch {
      // Swallow — next publish will evict this sub if still closed.
    }
  }

  /**
   * B12 counters, for the metrics endpoint. A steadily climbing softDropped is
   * the early warning that clients cannot keep up with the publish rate; any
   * hardDropped means a socket was evicted mid-session.
   */
  backpressureStats(): { softDropped: number; hardDropped: number } {
    return { softDropped: this.softDropped, hardDropped: this.hardDropped };
  }
}

// Singleton — the server uses one global hub. Tests construct fresh instances.
export const tableStateHub = new TableStateHub();
