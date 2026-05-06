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
  send(data: string): void;
}

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
      this.safeSend(sub, snap);
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
    this.safeSend(sub, snap);
    return true;
  }

  /**
   * Drop all state for a table. Call when the engine shuts down a table.
   */
  dropTable(tableId: string): void {
    this.rooms.delete(tableId);
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

  private broadcast(room: TableRoom, message: HubMessage): void {
    const dead: HubSubscriber[] = [];
    for (const sub of room.subscribers) {
      if (sub.readyState !== 1 /* ws.OPEN */) {
        dead.push(sub);
        continue;
      }
      this.safeSend(sub, message);
    }
    for (const d of dead) room.subscribers.delete(d);
  }

  private safeSend(sub: HubSubscriber, msg: HubMessage): void {
    try {
      sub.send(JSON.stringify(msg));
    } catch {
      // Swallow — next publish will evict this sub if still closed.
    }
  }
}

// Singleton — the server uses one global hub. Tests construct fresh instances.
export const tableStateHub = new TableStateHub();
