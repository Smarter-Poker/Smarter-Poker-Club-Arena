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
 *   6. Hold a reveal-class EVENT for the few seconds it stays meaningful, so a
 *      client subscribing or resyncing inside that window still receives it
 *      (D3 — see HUB_MAX_EVENT_REPLAY_MS). Bounded and self-expiring; this is
 *      NOT an event log and nothing survives a restart.
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
import { captureAllInEquity, captureRitEvent } from '../services/supabase/handFacts.js';
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
  /**
   * SHOWDOWN POLISH 2026-08-25: monotonic per-table event sequence. Events
   * ride the same socket as snapshots but their client-side dispatch is
   * deliberately deferred a macrotask (see EngineStateClient), so relative
   * ordering between two EVENTs was observable only by arrival luck. The seq
   * makes it a fact: a consumer can order, de-duplicate, and detect a gap.
   * Optional so recorded fixtures and older payloads stay valid.
   */
  seq?: number;
  /**
   * BBJ build plan phase 1 (2026-09-05): the engine's clock at the moment
   * this frame was SENT - the live emission, or the replay. A client that
   * judges an event's freshness (a jackpot celebration must play only for a
   * hit that just happened, never for a replayed one hours old) used to
   * compare the event's `emitted_at` against the DEVICE clock, so a phone
   * running a few minutes fast silently refused every celebration, forever,
   * with nothing to report. With the engine's own "now" on the envelope the
   * comparison is engine-clock to engine-clock and the device clock is out
   * of the decision. Optional so recorded fixtures stay valid.
   */
  ts?: number;
  payload: Record<string, unknown>;
}

/**
 * 2026-09-04 (disconnect audit items 11 + 12): a frame for ONE player at a
 * table, outside the public seq chain. Hole cards and the armed pre-action
 * are per-player facts; the shared snapshot cannot carry them and the
 * Supabase Realtime + poll path they used to travel by is a second transport
 * for the one thing a seat cannot play without. Never retained, never
 * replayed: the engine re-sends on RESYNC.
 */
export interface UserEventMessage {
  type: 'USER_EVENT';
  tableId: string;
  payload: Record<string, unknown>;
}

export type HubMessage = SnapshotMessage | DeltaMessage | EventMessage | UserEventMessage;

/**
 * Minimal interface a subscriber must satisfy.
 * The ws WebSocket class already has `.send` and `.readyState`, so a real
 * ws.WebSocket object is a valid HubSubscriber as-is.
 */
export interface HubSubscriber {
  readonly id: string;
  readonly readyState: number; // ws.OPEN === 1
  /** 2026-09-04: who is behind this socket, so sendToUser can find them. */
  readonly userId?: string;
  /**
   * B12: bytes queued in the socket's send buffer but not yet flushed to the
   * network. `ws.WebSocket` exposes this natively; it is optional here so test
   * doubles stay trivial (an absent value is read as 0, i.e. "not backed up").
   */
  readonly bufferedAmount?: number;
  send(data: string): void;
  /**
   * 2026-08-24: optional transport-supplied eviction. When the hub hard-drops
   * a hopeless subscriber (bufferedAmount past HARD), it used to only remove
   * it from the room — the SOCKET STAYED OPEN, receiving nothing, and the
   * client sat blind until its own staleness watchdog fired up to 60s later.
   * The transport knows how to end its connection cleanly (close the single
   * socket / unsubscribe the mux table), which routes the client into its
   * reconnect ladder IMMEDIATELY and gets a fresh snapshot in seconds.
   */
  evict?(): void;
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
 * D3 (2026-08-25) — REVEAL RETENTION. A tiny, self-expiring hold for the
 * handful of events a client must not silently lose.
 *
 * THE DEFECT. `emitEvent` opened with `const room = this.rooms.get(tableId);
 * if (!room) return;` and nothing anywhere kept the message. An EVENT was
 * therefore a single un-replayed packet: a client whose socket was down for
 * the one instant the event was emitted — reconnecting, mid-upgrade, or
 * soft-dropped by the backpressure rule above — never saw it and never could.
 * `resync` did not close the hole either, because it re-sends only the
 * SNAPSHOT, and the snapshot carries no multiplier.
 *
 * For a Spin & Go that is not a cosmetic loss. The wheel is emitted ONCE, by
 * TournamentManagerBase.start(), inside a `catch { reportError }` — miss it
 * and the player never learns what the table is playing for.
 *
 * WHY THIS IS NOT AN EVENT LOG. Only an event that ASKS to be retained is
 * retained, by carrying a numeric `replay_until` (the instant after which it
 * is meaningless — for the Spin sequence, the moment the engine is allowed to
 * deal). Retention is capped three ways: per event by its own deadline, hard-
 * capped at HUB_MAX_EVENT_REPLAY_MS regardless of what the emitter asks for;
 * per table at HUB_MAX_RETAINED_EVENTS_PER_TABLE; and globally at
 * HUB_MAX_RETAINED_TABLES. Expired entries are dropped on every touch. There
 * is no history, no persistence, and nothing survives a restart.
 *
 * WHY NOT PUT IT IN THE SNAPSHOT. Law 1.16: a snapshot must never trigger an
 * animation. A replay is therefore the SAME discrete named EVENT, re-sent to
 * one subscriber, tagged `replayed: true` so the client can tell a catch-up
 * from a live beat and animate against `reveal_at` rather than its own clock.
 */
const HUB_MAX_EVENT_REPLAY_MS = 60_000;
/**
 * FOUR WAS TOO FEW THE MOMENT THE JACKPOT GREW A SECOND BEAT (2026-09-06).
 *
 * MEASURED, not guessed. Every emit on a cash table that asks to be retained
 * is a Bad Beat Jackpot beat, and one jackpot hand can now produce five:
 *
 *     bbj_hit                ServerTableEngineSettlement (detection)
 *     bbj_payout_pending     the money could not land now (BBJ phase 2.2)
 *     bbj_payout_complete    the celebration
 *     bbj_hit_global         the club-wide card
 *     bbj_payout_paid        FeeReconciler, when the drain lands it late
 *
 * Three of those existed when the cap was written, so four had a whole beat of
 * headroom. Phase 2 added two and did not revisit it, which made the splice
 * below drop the OLDEST - `bbj_hit`, the one carrying the hand names the
 * celebration is built from, and the one whose own retention comment says it
 * exists so a player reconnecting through the hit still gets them.
 *
 * Eight is five plus a beat of headroom for the next one, and it is still a
 * per-table bound on a map already capped at HUB_MAX_RETAINED_TABLES, so the
 * worst case is 512 * 8 short-lived entries that expire on their own deadline
 * within HUB_MAX_EVENT_REPLAY_MS. `aJackpotIsNeverLost` pins the arithmetic so
 * the NEXT retained event has to come and read this.
 *
 * AND THE NEXT ONE CAME (2026-09-09, must-move audit). `seat_moved` is now
 * retained too: it is the one packet that tells a hero's client their chair is
 * at another table now, and fired once it was lost by any client that happened
 * to be between reconnects at that instant. A BREAKING table emits one per
 * seat AT A SINGLE HAND BOUNDARY - nine on a 9-max - so the arithmetic is no
 * longer five:
 *
 *     5 jackpot beats + 9 seat_moved on a breaking 9-max = 14
 *
 * Sixteen is that plus a beat of headroom. Under the old eight the per-table
 * splice below would have dropped the OLDEST, which is `bbj_hit` - the beat
 * whose own comment above says it must survive. Still bounded: 512 * 16
 * entries that expire on their own deadline within HUB_MAX_EVENT_REPLAY_MS.
 */
const HUB_MAX_RETAINED_EVENTS_PER_TABLE = 16;
const HUB_MAX_RETAINED_TABLES = 512;

/**
 * One retained event. `delivered` is a WeakSet so a subscriber that already
 * received the event live is never handed it twice by a subsequent resync —
 * replaying a wheel a client is already animating would restart it.
 */
interface RetainedEvent {
  payload: Record<string, unknown>;
  replayUntil: number;
  delivered: WeakSet<HubSubscriber>;
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
  /** B12: messages skipped because a socket was backed up past the soft limit. */
  private softDropped = 0;
  /** B12: subscribers evicted because a socket blew past the hard limit. */
  private hardDropped = 0;
  /** D3: reveal-class events still inside their own replay window, per table. */
  private retained: Map<string, RetainedEvent[]> = new Map();
  /** D3: how many retained events have been handed to a late/reconnecting sub. */
  private replayedEvents = 0;

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
    // D3: a client that connects DURING the reveal window still gets the
    // reveal. The snapshot above cannot carry it (Law 1.16 — a snapshot must
    // never trigger an animation), so it arrives as the same discrete EVENT.
    this.replayRetained(tableId, sub);
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
    // STATS FACT LAYER 2026-08-21 — capture all-in equity on its way past.
    //
    // ServerTableEngineRunout.broadcastAllInEquity() computes EXACT all-in
    // equity (every hand is known at an all-in, so it prices each holding
    // against the known others rather than a random range) and then discards
    // it: the number goes to clients and a Prometheus histogram, and nowhere
    // else. It is the whole basis of an EV-vs-actual "luck" graph and it was
    // being thrown away on every all-in.
    //
    // Runout.ts is above the deploy channel's per-file size ceiling, so we
    // intercept here instead of editing it. This MUST sit above the
    // `if (!room) return` below: that early return fires on tables with no
    // subscribers, and a hand nobody is watching still counts.
    captureAllInEquity(tableId, payload);
    // RIT/insurance lifecycle telemetry - see handFacts.captureRitEvent for
    // why this exists. Same placement rationale: above the `if (!room) return`,
    // because an offer nobody is subscribed to still happened.
    captureRitEvent(tableId, payload);

    // D3: retain BEFORE the `if (!room) return` below, for the same reason the
    // two captures above sit there — the early return fires while a table has
    // no room at all (nobody has ever subscribed, or every socket is currently
    // between reconnects), and that is precisely the case this exists for. An
    // event nobody could receive still happened, and for the reveal window it
    // is still worth receiving.
    const retention = this.retainIfReplayable(tableId, payload);

    const room = this.rooms.get(tableId);
    if (!room) return;
    // SHOWDOWN POLISH 2026-08-25: stamp the per-table event sequence.
    const seq = (this.eventSeqs.get(tableId) ?? 0) + 1;
    this.eventSeqs.set(tableId, seq);
    // The delivered set records who actually got it live, so a later resync
    // from the SAME socket does not replay a beat it already animated.
    this.broadcast(
      room,
      { type: 'EVENT', tableId, seq, ts: Date.now(), payload },
      retention?.delivered
    );
  }

  /** SHOWDOWN POLISH 2026-08-25: per-table monotonic EVENT sequence. */
  private eventSeqs = new Map<string, number>();

  /**
   * Deliver a private frame to every open socket ONE user holds on a table
   * (a player may have the table open in two tabs). Returns how many sockets
   * took it; 0 means the player is not subscribed right now, and the caller
   * relies on the RESYNC re-send when they are.
   */
  sendToUser(tableId: string, userId: string, payload: Record<string, unknown>): number {
    const room = this.rooms.get(tableId);
    if (!room || !userId) return 0;
    const message: UserEventMessage = { type: 'USER_EVENT', tableId, payload };
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const sub of room.subscribers) {
      if (sub.userId !== userId) continue;
      if (sub.readyState !== 1 /* ws.OPEN */) continue;
      try {
        sub.send(data);
        delivered++;
      } catch {
        /* the dead-subscriber sweep in broadcast() collects it */
      }
    }
    return delivered;
  }

  /**
   * Re-send the latest snapshot to a single subscriber. Used when the client
   * sends RESYNC after detecting a gap.
   */
  resync(tableId: string, sub: HubSubscriber): boolean {
    const room = this.rooms.get(tableId);
    const snapshot = room?.lastSnapshot ?? null;
    if (snapshot) {
      const snap: SnapshotMessage = {
        type: 'SNAPSHOT',
        tableId,
        seq: room?.lastSeq ?? 0,
        state: snapshot,
      };
      this.safeSend(sub, JSON.stringify(snap));
    }
    // D3: a RESYNC is the recovery path for a client that MISSED messages, and
    // until now it recovered only state. The snapshot carries no multiplier, so
    // a client that gapped across the reveal used to come back fully caught up
    // on the felt and permanently blind to the wheel. Replay runs whether or
    // not a snapshot existed to send; the return value still means "a snapshot
    // went out", so callers are unaffected.
    this.replayRetained(tableId, sub);
    return !!snapshot;
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
      // Review fix 2026-08-25: the event-seq counter goes with the room, or
      // long-lived processes accumulate one entry per dead table forever.
      this.eventSeqs.delete(tableId);
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

  /**
   * D3 counters. `retainedTables` above zero for longer than a reveal window
   * means something is asking for retention it does not need; `replayedEvents`
   * counts reveals that would have been lost outright before this existed.
   */
  replayStats(): { retainedTables: number; replayedEvents: number } {
    this.pruneRetained(Date.now());
    return { retainedTables: this.retained.size, replayedEvents: this.replayedEvents };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * D3: hold an event only if it declares its own expiry, and only for as long
   * as it declares — never longer than HUB_MAX_EVENT_REPLAY_MS. An emitter that
   * says nothing gets the old behaviour exactly: fire once, keep nothing.
   */
  private retainIfReplayable(
    tableId: string,
    payload: Record<string, unknown>
  ): RetainedEvent | null {
    const asked = Number(payload?.replay_until);
    if (!Number.isFinite(asked)) return null;

    const now = Date.now();
    // The emitter's deadline is a ceiling request, not a grant. A bad or
    // far-future value must not be able to pin an event in memory.
    const replayUntil = Math.min(asked, now + HUB_MAX_EVENT_REPLAY_MS);
    if (replayUntil <= now) return null;

    this.pruneRetained(now);

    let list = this.retained.get(tableId);
    if (!list) {
      // Global ceiling. Retention is best-effort theatre insurance; it must
      // never become a memory commitment the hub cannot bound.
      if (this.retained.size >= HUB_MAX_RETAINED_TABLES) return null;
      list = [];
      this.retained.set(tableId, list);
    }

    const entry: RetainedEvent = { payload, replayUntil, delivered: new WeakSet() };
    list.push(entry);
    if (list.length > HUB_MAX_RETAINED_EVENTS_PER_TABLE) {
      list.splice(0, list.length - HUB_MAX_RETAINED_EVENTS_PER_TABLE);
    }
    return entry;
  }

  /**
   * D3: hand one subscriber every still-live retained event for its table, in
   * emission order, marked `replayed` so the client can distinguish a catch-up
   * from a live beat. Never sends an event that same subscriber already got.
   */
  private replayRetained(tableId: string, sub: HubSubscriber): void {
    if (this.retained.size === 0) return;
    this.pruneRetained(Date.now());
    const list = this.retained.get(tableId);
    if (!list || list.length === 0) return;

    for (const entry of list) {
      if (entry.delivered.has(sub)) continue;
      const message: EventMessage = {
        type: 'EVENT',
        tableId,
        // `ts` is the REPLAY instant, so a freshness check on the client sees
        // the event's true age rather than believing a retained hit is new.
        ts: Date.now(),
        payload: { ...entry.payload, replayed: true },
      };
      if (this.safeSend(sub, JSON.stringify(message))) {
        entry.delivered.add(sub);
        this.replayedEvents++;
      }
    }
  }

  /** Drop everything past its own deadline, and any table left with nothing. */
  private pruneRetained(now: number): void {
    if (this.retained.size === 0) return;
    for (const [tableId, list] of this.retained) {
      const live = list.filter((e) => e.replayUntil > now);
      if (live.length === 0) this.retained.delete(tableId);
      else if (live.length !== list.length) this.retained.set(tableId, live);
    }
  }

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
  private broadcast(
    room: TableRoom,
    message: HubMessage,
    /**
     * D3: when the message is being retained for replay, record who genuinely
     * received it. A subscriber that was soft-dropped here (or whose send
     * threw) is deliberately NOT recorded, so its resync replays the event.
     */
    delivered?: WeakSet<HubSubscriber>
  ): void {
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
        // Beyond saving — evict rather than keep buffering for it, and TELL
        // the transport so the client reconnects now instead of sitting on an
        // open-but-silent socket until its watchdog gives up (2026-08-24).
        this.hardDropped++;
        dead.push(sub);
        try {
          sub.evict?.();
        } catch {
          /* eviction is best-effort; removal from the room is the point */
        }
        continue;
      }
      if (droppable && buffered > HUB_SOFT_BACKPRESSURE_BYTES) {
        this.softDropped++;
        continue;
      }
      if (this.safeSend(sub, payload)) delivered?.add(sub);
    }
    for (const d of dead) room.subscribers.delete(d);
  }

  /** Returns whether the payload actually reached the socket (D3 uses this). */
  private safeSend(sub: HubSubscriber, payload: string): boolean {
    try {
      sub.send(payload);
      return true;
    } catch {
      // Swallow — next publish will evict this sub if still closed.
      return false;
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
