/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EngineStateClient — native WebSocket client for authoritative game state
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Opens a WebSocket to the Hetzner game engine at /ws/table/:tableId, using
 * Sec-WebSocket-Protocol: bearer, <supabase-jwt> for authentication.
 * Receives SNAPSHOT / DELTA (RFC-6902 JSON Patch) messages and maintains a
 * local authoritative snapshot. Responds to server PING with PONG. Handles
 * reconnect with exponential backoff, seq-gap RESYNC requests, and token
 * refresh if the server closes with 4401.
 *
 * Phase 2 (2026-05-18): Extended with a second connection path at
 * /ws/channel for non-table channels (club presence, tournament events,
 * lobby, hand replay, financials, table meta). The EngineChannelClient
 * class below handles those. RealtimeChannelService uses EngineChannelClient
 * as its transport, eliminating all Supabase Realtime connections.
 *
 * This file does NOT depend on any React or Zustand code so it can be unit-
 * tested with jsdom. The React binding lives in hooks/useEngineTableState.
 */

import jsonPatch from 'fast-json-patch';
import { engineSocketMux, isMuxEnabled, CLOSE_MUX_SUPERSEDED } from './EngineSocketMux';
import type { Operation } from 'fast-json-patch';
const { applyPatch } = jsonPatch;

// ─── Protocol types — mirror server/src/transport/TableStateHub.ts ────────────

export type EngineSnapshot = Record<string, unknown>;

export interface ServerSnapshotMessage {
  type: 'SNAPSHOT';
  tableId: string;
  seq: number;
  state: EngineSnapshot;
}
export interface ServerDeltaMessage {
  type: 'DELTA';
  tableId: string;
  seq: number;
  prev: number;
  patch: Operation[];
}
export interface ServerPingMessage {
  type: 'PING';
  ts: number;
}
/**
 * Phase 1.1 PR-5: transient EVENT messages for insurance_offers, rit_*,
 * time_bank_*, bbj_*, all_in_equity, rabbit_hunt_available, etc. Emitted
 * by TableStateHub.emitEvent from the server. Payload shape matches the
 * old Supabase broadcast payload (drop-in for existing TablePage handlers).
 */
export interface ServerEventMessage {
  type: 'EVENT';
  tableId: string;
  /**
   * Review fix 2026-08-25: the hub's per-table monotonic event sequence,
   * consumed for same-connection de-duplication. Optional — legacy frames
   * and recorded fixtures omit it.
   */
  seq?: number;
  payload: Record<string, unknown>;
}
/**
 * 2026-09-04 (disconnect audit items 11 + 12): a frame for THIS player only,
 * outside the public sequence. Hole cards and the engine's copy of the armed
 * pre-action arrive this way; the engine re-sends both on RESYNC.
 */
export interface ServerUserEventMessage {
  type: 'USER_EVENT';
  tableId: string;
  payload: Record<string, unknown>;
}
export type ServerMessage =
  | ServerSnapshotMessage
  | ServerDeltaMessage
  | ServerPingMessage
  | ServerEventMessage
  | ServerUserEventMessage;

// WS close codes the server emits (mirrors CLOSE_* constants on server).
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_TABLE_NOT_FOUND = 4404;
export const CLOSE_RATE_LIMITED = 4429;
export const CLOSE_SERVER_ERROR = 4500;
export const CLOSE_BAD_REQUEST = 4400;

export type EngineConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'auth_failed';

export interface EngineStateClientOptions {
  /** Base URL, e.g. https://engine.smarter.poker. Scheme is rewritten to ws(s). */
  baseUrl: string;
  tableId: string;
  /** Called every time fresh auth is needed — on initial connect and on 4401 close. */
  getToken: () => Promise<string | null>;
  /** Called whenever the local snapshot changes. */
  onSnapshot: (snap: EngineSnapshot, seq: number) => void;
  /** Called when connection status changes. */
  onStatus?: (status: EngineConnectionStatus) => void;
  /** Called on non-recoverable errors (invalid token, server close with 4500). */
  onError?: (err: { code?: number; reason?: string }) => void;
  /**
   * Called when a transient EVENT message arrives (insurance_offers,
   * rit_*, time_bank_*, bbj_*, etc). Payload is forwarded verbatim.
   */
  onEvent?: (payload: Record<string, unknown>) => void;
  /**
   * Called when a private USER_EVENT frame arrives (hole cards, pre-action).
   * Delivered immediately, never queued or de-duplicated: the payload is
   * idempotent by construction (a full statement of the player's cards or
   * armed action) and the recipient's own guards decide what to do with it.
   */
  onUserEvent?: (payload: Record<string, unknown>) => void;
  /** Maximum reconnect attempts. Default: 10. */
  maxRetries?: number;
  /** Initial backoff ms. Default: 1000. */
  initialDelay?: number;
  /** Max backoff ms. Default: 30000. */
  maxDelay?: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class EngineStateClient {
  private opts: Required<EngineStateClientOptions>;
  private ws: WebSocket | null = null;
  private status: EngineConnectionStatus = 'idle';
  private retryCount = 0;
  /**
   * 2026-09-04: the engine said 4404 for this table and we are on the slow
   * ladder. While this is true the ladder announces 'idle', not
   * 'reconnecting' - see scheduleReconnect and openOnceInner. Cleared on open.
   */
  private tableMissing = false;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  private snapshot: EngineSnapshot | null = null;
  private seq: number = 0;

  // ─── Dan 2026-08-15 — INBOUND STALENESS WATCHDOG (item 6) ────────────────
  //
  // "Games can never just freeze." Every recovery path in this client is
  // driven by `ws.onclose`. That covers a dropped connection, but it is blind
  // to the failure that actually strands players: the socket stays OPEN while
  // the server stops sending. readyState reads 1, status reads 'connected',
  // the UI looks healthy, and nothing ever fires — no close, no error, no
  // reconnect. The table sits dead indefinitely with no way back.
  //
  // The server pings every 25s unconditionally (EngineWebSocketServer
  // HEARTBEAT_INTERVAL_MS), so on a healthy link we hear *something* at least
  // that often. Prolonged silence means the far end is gone no matter what
  // readyState claims. Two tiers:
  //   SOFT — request a RESYNC. Cheap, and recovers the case where frames were
  //          lost but the socket is genuinely still alive.
  //   HARD — force the socket closed, routing into the existing
  //          onclose -> scheduleReconnect backoff ladder. This is the escape
  //          hatch that did not exist before.
  private lastInboundAt = 0;
  private watchdogTimer: number | null = null;
  /**
   * 2026-08-22: consecutive watchdog RESYNCs sent with NO inbound frame in
   * between. A half-open socket answers nothing, so unanswered resyncs are
   * the reliable dead-link signal even when tab switching keeps resetting the
   * silence clock (the old hole: multi-tablers who alt-tabbed more than once
   * per 60s could keep a dead socket looking alive forever). Reset on every
   * inbound frame; at 3 unanswered we escalate to the HARD teardown.
   */
  private unansweredResyncs = 0;
  /** 2026-08-22: bounds the CONNECTING state — see openOnce. */
  private handshakeTimer: number | null = null;
  /**
   * 2026-08-22 review: single-flight guard for openOnce. openOnce awaits
   * getToken() BEFORE assigning this.ws, so during that window this.ws is
   * null and a late onclose from a detached socket could schedule a second
   * reconnect — two live sockets, one orphaned OPEN forever (which also
   * defeated the server's last-socket disconnect detection).
   */
  private opening = false;
  private onVisibility: (() => void) | null = null;
  /** Dan 2026-08-21: browser 'online' hook for instant post-outage reconnect. */
  private onOnline: (() => void) | null = null;

  /** How often the watchdog samples. */
  private static readonly WATCHDOG_TICK_MS = 5_000;
  /** Silence beyond this requests a RESYNC (server pings every 25s). */
  private static readonly STALE_SOFT_MS = 35_000;
  /** Silence beyond this tears the socket down and reconnects. */
  private static readonly STALE_HARD_MS = 60_000;
  /** Unanswered watchdog RESYNCs before escalating to HARD teardown. */
  private static readonly MAX_UNANSWERED_RESYNCS = 3;
  /** A socket stuck in CONNECTING longer than this is torn down. */
  private static readonly HANDSHAKE_TIMEOUT_MS = 15_000;

  constructor(opts: EngineStateClientOptions) {
    this.opts = {
      onStatus: () => undefined,
      onEvent: () => undefined,
      onUserEvent: () => undefined,
      onError: () => undefined,
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30_000,
      ...opts,
    };
  }

  /** Open the connection. Call once from the owning hook. */
  async connect(): Promise<void> {
    // P2-1: guard against concurrent connects (React StrictMode double-invoke,
    // rapid re-mounts / tableId switches). If a socket is already OPEN or
    // CONNECTING, do nothing — otherwise we'd leak a second zombie socket.
    // Mirrors EngineChannelClient.connect().
    if (this.ws !== null && this.ws.readyState <= 1 /* OPEN or CONNECTING */) return;
    this.intentionalClose = false;
    this.retryCount = 0;
    // Dan 2026-08-21 (never-die failsafe): the instant the browser reports
    // the network is back, skip whatever backoff is pending and reconnect NOW.
    if (this.onOnline === null && typeof window !== 'undefined') {
      this.onOnline = () => {
        if (this.intentionalClose) return;
        // Healthy OPEN socket — nothing to do.
        if (this.ws !== null && this.ws.readyState === 1) return;
        // 2026-08-22: a socket wedged in CONNECTING (captive portal, TCP
        // blackhole, network transition) used to BLOCK this recovery path —
        // the guard treated CONNECTING as healthy, no timer was pending, and
        // the table sat at 'connecting' forever. Tear it down and start over.
        if (this.ws !== null && this.ws.readyState === 0) {
          try {
            this.ws.close();
          } catch {
            /* ignore */
          }
          this.ws = null;
        }
        if (this.reconnectTimer !== null) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.retryCount = 0;
        void this.openOnce();
      };
      window.addEventListener('online', this.onOnline);
    }
    await this.openOnce();
  }

  /** Close the connection permanently. */
  disconnect(): void {
    this.intentionalClose = true;
    // Review fix 2026-08-25: no queued frame may fire onSnapshot/onEvent
    // against a page that has moved on (the CA-22 class).
    this.resetInbox();
    if (this.onOnline !== null && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      this.onOnline = null;
    }
    // Dan 2026-08-15 (item 6): tear the watchdog down here or its interval and
    // visibilitychange listener outlive the client. In MultiTablePage, where
    // up to four of these exist and tabs open/close freely, that leaks a timer
    // per closed table and keeps firing against a dead socket.
    this.stopWatchdog();
    this.clearHandshakeTimer();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'intentional');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus('idle');
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** Current snapshot, or null if no snapshot has arrived yet. */
  getSnapshot(): EngineSnapshot | null {
    return this.snapshot;
  }

  getSeq(): number {
    return this.seq;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async openOnce(): Promise<void> {
    // Single-flight + live-socket guard (see `opening`). scheduleReconnect's
    // timer, the online handler and connect() can all race into here.
    if (this.opening) return;
    if (this.ws !== null && this.ws.readyState <= 1 /* OPEN or CONNECTING */) return;
    this.opening = true;
    try {
      await this.openOnceInner();
    } finally {
      this.opening = false;
    }
  }

  private async openOnceInner(): Promise<void> {
    if (!this.tableMissing) {
      this.setStatus(this.retryCount === 0 ? 'connecting' : 'reconnecting');
    }
    // 2026-08-22: getToken (supabase.auth.getSession) can REJECT — network
    // error, storage error, auth-js internal throw. This await used to be
    // unguarded, and because scheduleReconnect nulls its timer before calling
    // us, a single rejection ended the reconnect ladder PERMANENTLY with the
    // status stuck at 'connecting' — the single worst frozen-table path in
    // the client. A rejection is now just another retry.
    let token: string | null = null;
    try {
      token = await this.opts.getToken();
    } catch {
      if (!this.intentionalClose) this.scheduleReconnect();
      return;
    }
    // P2-1: disconnect() may have fired while getToken() was in flight
    // (tableId switch / unmount / StrictMode double-invoke). If so, abort before
    // creating the socket — opening one now would spawn a zombie WS the owning
    // hook's cleanup can never reach (clientRef already points at a new client),
    // leaking a server table-slot and flip-flopping cross-table snapshots.
    if (this.intentionalClose) return;
    if (!token) {
      // No token available. Retry on backoff — the auth layer may be warming up.
      this.scheduleReconnect();
      return;
    }

    const wsUrl = this.opts.baseUrl.replace(/^http/, 'ws') + '/ws/table/' + this.opts.tableId;
    // Subprotocol carries auth. Two entries: the literal "bearer", then the JWT.
    //
    // Roadmap batch 6 (2026-08-21), DEFAULT ON since 2026-08-24: all tables
    // share ONE physical socket to /ws/multi via a WebSocket-shaped facade
    // (see EngineSocketMux; kill switch localStorage ca_ws_mux='0').
    // Everything below — seq/RESYNC, watchdog, reconnect backoff — runs
    // unchanged on top of it.
    let ws: WebSocket;
    if (isMuxEnabled()) {
      ws = engineSocketMux.acquire(
        this.opts.baseUrl,
        this.opts.tableId,
        token
      ) as unknown as WebSocket;
    } else {
      try {
        ws = new WebSocket(wsUrl, ['bearer', token]);
      } catch (err) {
        this.scheduleReconnect();
        return;
      }
    }
    this.ws = ws;

    // 2026-08-22: bound the CONNECTING state. A socket that never completes
    // the handshake (captive portal, TCP blackhole, mid-transition mobile
    // network) fires NEITHER onopen NOR onclose — no timer was pending, the
    // online-event guard refused to help, and the table wedged at
    // 'connecting' forever. If we are not OPEN within the timeout, tear the
    // attempt down and route into the normal backoff ladder.
    this.clearHandshakeTimer();
    this.handshakeTimer = window.setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws !== ws) return;
      if (ws.readyState === 0 /* CONNECTING */) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
        if (!this.intentionalClose) this.scheduleReconnect();
      }
    }, EngineStateClient.HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      // Stale-socket guard: a superseded socket's late events must not touch
      // the live connection's state.
      if (this.ws !== ws) return;
      this.clearHandshakeTimer();
      this.tableMissing = false;
      // 2026-09-04: read BEFORE resetInbox(), which zeroes `seq`. Read after
      // it, the `seq > 0` test below was always false and the RESYNC on
      // reconnect had been dead code since 2026-08-25 - harmless only
      // because the hub sends a SNAPSHOT on subscribe, and a hub that ever
      // stopped would have frozen every reconnected table silently.
      const hadState = this.seq > 0;
      // Review fix 2026-08-25: a fresh connection starts with an empty
      // inbound queue and a fresh event-seq epoch — the dead socket's
      // frames must not precede (or dedupe against) this connection's.
      this.resetInbox();
      this.retryCount = 0;
      this.unansweredResyncs = 0;
      this.setStatus('connected');
      // Dan 2026-08-15 (item 6): arm the staleness watchdog for this socket.
      this.startWatchdog();
      // Server sends SNAPSHOT on subscribe — no explicit RESYNC needed on
      // first connect. On reconnect after a gap, we explicitly request one.
      if (hadState) {
        try {
          ws.send(JSON.stringify({ type: 'RESYNC' }));
        } catch {
          /* will be covered by next onclose → reconnect */
        }
      }
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      // Dan 2026-08-15 (item 6): stamp BEFORE parsing, and for every frame
      // including PING. Any byte from the server proves the link is alive;
      // gating this on a successful parse would let a malformed frame look
      // like silence and trip the watchdog on a healthy connection.
      this.lastInboundAt = Date.now();
      this.unansweredResyncs = 0;
      let msg: ServerMessage | null = null;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof (msg as { type?: string }).type !== 'string') return;
      this.handleMessage(msg);
    };

    ws.onclose = (e) => {
      // Stale-socket guard: only the CURRENT socket's close drives recovery.
      // Without this, a superseded socket's late close could schedule a
      // second reconnect against a live connection.
      if (this.ws !== null && this.ws !== ws) return;
      this.clearHandshakeTimer();
      // Clean intentional close
      if (this.intentionalClose) return;

      // Auth failure — bubble up to the host; do not retry with the same token
      if (e.code === CLOSE_AUTH_FAILED) {
        this.setStatus('auth_failed');
        this.opts.onError({ code: e.code, reason: e.reason });
        // Still schedule a reconnect — getToken may return a refreshed token next
        this.scheduleReconnect();
        return;
      }

      // 2026-08-22: 4404 used to be TERMINAL — but the engine returns it for
      // ~2 minutes after every restart while tables rehydrate, and for a
      // first player at an empty table. Giving up permanently turned every
      // engine deploy into a page of dead tables. Dan previously added a slow
      // retry ladder here, but announcing 'failed' triggered TablePage's
      // auto-reload, turning a missing table into a 5-second reload loop.
      // Announce 'idle' instead so the UI stays usable (e.g. for empty tables
      // or during engine restarts) while we keep retrying on the slow ladder.
      if (e.code === CLOSE_TABLE_NOT_FOUND) {
        /* 2026-09-04: the 'idle' below was stomped one line later - every
           scheduleReconnect() sets 'reconnecting', so a table the engine had
           closed sat under "Reconnecting To The Table" for as long as the tab
           was open (measured on production: a closed NLH Straddle table, the
           banner for the whole 40s it was watched, SUBSCRIBE answered
           TABLE_NOT_FOUND every time). The flag keeps the ladder honest:
           it is polling for a table that may come back, and says nothing. */
        this.tableMissing = true;
        this.setStatus('idle');
        this.opts.onError({ code: e.code, reason: e.reason });
        this.retryCount = Math.max(this.retryCount, 5); // start at ~16s+ delays
        this.scheduleReconnect();
        return;
      }

      // 2026-08-22 (mux): a newer client instance claimed this table's
      // facade. Reconnecting would evict IT and ping-pong forever — the old
      // owner stands down for good. The newer instance carries the game.
      if (e.code === CLOSE_MUX_SUPERSEDED) {
        this.setStatus('idle');
        return;
      }

      // 2026-08-22: the server told us to slow down — honour it instead of
      // rejoining the thundering herd at the fast end of the ladder.
      if (e.code === CLOSE_RATE_LIMITED) {
        this.retryCount = Math.max(this.retryCount, 4);
      }

      // Anything else (transient server/network issue) → reconnect
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Errors are always followed by onclose; handle there.
    };
  }

  /**
   * ═══ THE UNIFIED INBOUND QUEUE (review fix 2026-08-25) ═══
   *
   * History, because three constraints meet here:
   *
   *  - Task 56 (2026-04-17): two EVENTs in one tick collapsed into one React
   *    render and pot_win vanished. Cure: each EVENT gets its own macrotask.
   *  - Showdown reveal (2026-08-25): the engine emits the showdown EVENT
   *    before the revealing snapshot, but state frames applied synchronously
   *    while events were deferred — the snapshot overtook the event and the
   *    reveal stagger died. First cure (requeue the state frame behind
   *    pending events) was reviewed and found wanting: no staleness guard, a
   *    starvation window, and it still inverted an EVENT emitted after a
   *    state frame.
   *  - This queue is the cure for all three at once. Every non-PING frame
   *    enters ONE FIFO in arrival order. The drain applies contiguous state
   *    frames synchronously, dispatches exactly ONE event per macrotask,
   *    then yields. Guarantees: server emit order IS client observation
   *    order in both directions; every event still gets its own render; a
   *    state frame is never observed before an event the server emitted
   *    first; drain always advances (no starvation); and connect/disconnect
   *    clear the queue, so a dead socket's frames can never reach a live
   *    page (the CA-22 class). A lone state frame with an empty queue keeps
   *    the old zero-latency fast path.
   */
  private inbox: ServerMessage[] = [];
  private drainScheduled = false;
  /**
   * SHOWDOWN POLISH review fix: consume the hub's per-table EVENT seq —
   * duplicates and out-of-order replays on the SAME connection are dropped.
   * Reset on every (re)connect: the hub's counter restarts with the engine,
   * and a fresh socket legitimately re-receives retained reveal events.
   */
  private lastEventSeq = 0;

  private handleMessage(msg: ServerMessage): void {
    /**
     * ENGINE RESTART EPOCH RESET — WIRED 2026-08-28.
     *
     * `resetInbox()` below carries the cure for the permanent freeze after an
     * engine rebuild, and its docblock claims "This fires on every dropTable
     * path". It did not. `resetInbox` is reachable only from `disconnect()`
     * and `ws.onopen`, and `TableStateHub.dropTable()` deliberately KEEPS the
     * socket open (it resets `room.lastSeq = 0` and broadcasts this notice
     * instead of dropping subscribers) — so no socket boundary occurred and
     * the epoch was never reset. The rebuilt engine's `SNAPSHOT seq:1` was
     * then discarded by the monotonicity belt, every following DELTA tripped
     * `msg.prev !== this.seq` into a resync whose reply was dropped the same
     * way, and because frames kept arriving the staleness watchdog and the
     * reconnect ladder both stayed asleep. The felt sat dead — no cards, no
     * clock, no chips — until the player reloaded the page.
     *
     * The hub sends the notice for exactly this purpose ("tell the clients
     * why they are about to see a sequence reset"), and nothing consumed it.
     * Consume it here, BEFORE the queue: the reset must land ahead of the
     * fresh snapshot that follows it, and the hub always re-sends a full
     * snapshot after a drop, so forgetting the old sequence loses nothing.
     *
     * This matters more from 2026-08-28 on, not less: the deploy pipeline's
     * drain-gate deadlock was fixed the same day, so the engine now actually
     * restarts on deploy instead of running hours-stale code — which means
     * this path runs often rather than rarely.
     */
    if (
      msg.type === 'EVENT' &&
      (msg.payload as { type?: string } | undefined)?.type === 'engine_restarting'
    ) {
      this.inbox = [];
      this.lastEventSeq = 0;
      this.seq = 0;
      this.snapshot = null;
      // Still surface it: TablePage can show its reconnect chrome rather than
      // a silently frozen table while the rebuilt engine publishes.
      try {
        this.opts.onEvent(msg.payload);
      } catch (err) {
        console.error('[EngineStateClient] onEvent listener threw', err);
      }
      return;
    }
    if (msg.type === 'USER_EVENT') {
      // Private, unsequenced, idempotent: straight through, never queued.
      try {
        this.opts.onUserEvent(msg.payload);
      } catch (err) {
        console.error('[EngineStateClient] onUserEvent listener threw', err);
      }
      return;
    }
    if (msg.type === 'PING') {
      // Keepalive never queues — answering late defeats its purpose.
      try {
        this.ws?.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
      } catch {
        /* onclose will reconnect */
      }
      return;
    }
    // Fast path: a state frame with nothing queued applies immediately,
    // exactly as it always has.
    if (this.inbox.length === 0 && (msg.type === 'SNAPSHOT' || msg.type === 'DELTA')) {
      this.applyStateFrame(msg);
      return;
    }
    this.inbox.push(msg);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setTimeout(() => {
      this.drainScheduled = false;
      this.drainInbox();
    }, 0);
  }

  private drainInbox(): void {
    while (this.inbox.length > 0) {
      const msg = this.inbox.shift()!;
      if (msg.type === 'EVENT') {
        // Seq-based de-duplication (0/absent = legacy frame, always passes).
        const seq = (msg as { seq?: number }).seq;
        if (typeof seq === 'number' && seq > 0) {
          if (seq <= this.lastEventSeq) continue;
          this.lastEventSeq = seq;
        }
        try {
          this.opts.onEvent(msg.payload);
        } catch (err) {
          // Never let a listener throw propagate back into the WS
          // message pump — it would kill the connection.
          console.error('[EngineStateClient] onEvent listener threw', err);
        }
        // One render per event: yield before anything else is observed.
        if (this.inbox.length > 0) this.scheduleDrain();
        return;
      }
      // SNAPSHOT / DELTA: apply in queue position, keep draining — state
      // may share a render with a LATER event (server order preserved),
      // never with an earlier one.
      this.applyStateFrame(msg);
    }
  }

  private applyStateFrame(msg: ServerMessage): void {
    if (msg.type === 'SNAPSHOT') {
      // Monotonicity belt: never roll state backwards. The hub's seq is
      // monotonic per table and an engine restart forces a reconnect (which
      // clears local seq via the fresh subscribe), so an older seq here can
      // only be a stale frame.
      if (this.snapshot && typeof msg.seq === 'number' && msg.seq < this.seq) return;
      this.snapshot = msg.state;
      this.seq = msg.seq;
      this.opts.onSnapshot(this.snapshot, this.seq);
      return;
    }
    if (msg.type !== 'DELTA') return;
    // If we don't have a snapshot yet, we can't apply a patch — request one.
    if (!this.snapshot) {
      this.requestResync();
      return;
    }
    // Gap detection: if msg.prev !== local seq, we're missing something.
    if (msg.prev !== this.seq) {
      this.requestResync();
      return;
    }
    try {
      // applyPatch mutates in place by default; pass a cloned target
      // for stable snapshot semantics downstream.
      const next = structuredClone(this.snapshot) as EngineSnapshot;
      applyPatch(next, msg.patch, /* validate */ false);
      this.snapshot = next;
      this.seq = msg.seq;
      this.opts.onSnapshot(this.snapshot, this.seq);
    } catch {
      // Patch failed — force a resync
      this.requestResync();
    }
  }

  /**
   * Review fix 2026-08-25: a socket boundary empties the queue. Frames from
   * a dead connection must never apply after reconnect, and a reconnect's
   * first snapshot must not sit behind a dead socket's events.
   */
  private resetInbox(): void {
    this.inbox = [];
    this.lastEventSeq = 0;
    /**
     * EPOCH RESET 2026-08-27 (security/realtime audit): the table froze
     * permanently after ANY engine restart.
     *
     * TableStateHub.dropTable() deliberately keeps the room's subscribers and
     * their open sockets, and resets the room's sequence (`room.lastSeq = 0`).
     * The client never reset its counterpart, so with `this.seq` still at, say,
     * 4213 from before the restart, the monotonicity belt
     *     if (msg.seq < this.seq) return;
     * discarded the rebuilt engine's `SNAPSHOT seq:1`, and every following
     * DELTA tripped `msg.prev !== this.seq` -> requestResync(), whose reply is
     * another small-seq SNAPSHOT that was dropped again. An endless loop — and
     * because frames kept arriving, `lastInboundAt` and `unansweredResyncs`
     * were refreshed every time, so neither the staleness watchdog nor the
     * reconnect ladder ever escalated. The table sat frozen until the player
     * reloaded the page.
     *
     * The dropTable paths (zombie reaper, watchdog kill, tournament table
     * breaks) do NOT pass through here — dropTable keeps the socket open, so
     * no socket boundary occurs. They are handled by the `engine_restarting`
     * branch in handleMessage(), which performs the same reset for the same
     * reason. (Corrected 2026-08-28: this docblock previously claimed those
     * paths reached this function, and that claim was why the freeze survived
     * the fix meant to cure it.)
     *
     * Resetting the epoch here is safe: the hub always sends a FULL snapshot
     * on subscribe and on resync, so nothing is lost by forgetting the old
     * sequence.
     */
    this.seq = 0;
    this.snapshot = null;
  }

  private requestResync(): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'RESYNC' }));
    } catch {
      /* onclose will reconnect */
    }
  }

  /**
   * Dan 2026-08-15 (item 6) — start the inbound staleness watchdog.
   * Idempotent; safe to call on every (re)open.
   */
  private startWatchdog(): void {
    this.lastInboundAt = Date.now();
    if (this.watchdogTimer !== null) return;

    this.watchdogTimer = window.setInterval(() => {
      if (this.intentionalClose) return;
      // Only meaningful while we believe we are connected. During
      // 'reconnecting' the backoff ladder already owns recovery.
      if (this.status !== 'connected') return;
      // A tab that was backgrounded has throttled timers, so the elapsed gap
      // says nothing about the link. The visibilitychange handler re-arms the
      // clock on wake; skip the check while hidden.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      const silentFor = Date.now() - this.lastInboundAt;

      if (
        silentFor >= EngineStateClient.STALE_HARD_MS ||
        // 2026-08-22: escalate on unanswered RESYNCs too. Tab switching used
        // to reset the silence clock on every wake, so a half-open socket
        // could dodge the HARD threshold forever while every soft RESYNC
        // vanished into the void. Three RESYNCs with zero inbound frames is a
        // dead link regardless of what the clock says.
        this.unansweredResyncs >= EngineStateClient.MAX_UNANSWERED_RESYNCS
      ) {
        // The socket claims to be open but the server has said nothing —
        // force it closed so onclose -> scheduleReconnect runs.
        this.opts.onError({
          reason: `engine silent for ${Math.round(silentFor / 1000)}s (${this.unansweredResyncs} unanswered resyncs) - forcing reconnect`,
        });
        this.lastInboundAt = Date.now(); // don't re-fire while the close lands
        this.unansweredResyncs = 0;
        // 2026-08-22: announce the truth. This path used to leave status at
        // 'connected' (green dot on a dead table), and when close() left the
        // socket in CLOSING with onclose never firing, NO reconnect was ever
        // scheduled — another full silent cycle per repeat. Detach the socket
        // and drive the reconnect ourselves; the stale-socket guards make a
        // late onclose from the old socket harmless.
        this.setStatus('reconnecting');
        const dead = this.ws;
        this.ws = null;
        try {
          dead?.close(4001, 'client staleness watchdog');
        } catch {
          /* ignore */
        }
        this.scheduleReconnect();
        return;
      }

      if (silentFor >= EngineStateClient.STALE_SOFT_MS) {
        // Might just be dropped frames on a live socket — ask for a full
        // snapshot. A reply refreshes lastInboundAt and clears the condition.
        this.unansweredResyncs++;
        this.requestResync();
      }
    }, EngineStateClient.WATCHDOG_TICK_MS);

    // Coming back to a backgrounded tab: timers were throttled, so treat the
    // gap as unknown rather than as evidence of failure. Re-arm the clock and
    // pull a fresh snapshot immediately — the table may have moved on a lot.
    if (typeof document !== 'undefined' && this.onVisibility === null) {
      this.onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        // 2026-08-22: grant a BOUNDED grace on wake instead of a full clock
        // reset. The unconditional `lastInboundAt = Date.now()` here was the
        // hole that let a half-open socket survive forever under frequent tab
        // switching. The link now has one soft interval to prove itself (the
        // RESYNC below refreshes the clock for real when it is answered);
        // unanswered resyncs escalate regardless.
        this.lastInboundAt = Math.max(
          this.lastInboundAt,
          Date.now() - EngineStateClient.STALE_SOFT_MS
        );
        if (this.status === 'connected') this.requestResync();
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.onVisibility !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.retryCount++;
    // ── Dan 2026-08-21 ("the games can never freeze or die"): NEVER stop
    // trying. The old code went terminally 'failed' after maxRetries and the
    // table sat dead until a manual refresh. Now maxRetries only marks the
    // moment we ANNOUNCE failure (status 'failed' → the host UI can escalate,
    // e.g. auto-refresh) — the backoff ladder keeps running at maxDelay
    // cadence forever underneath. A laptop waking from sleep or a phone
    // regaining signal reconnects on its own, however long it was gone.
    if (this.tableMissing) {
      // A closed table is not a lost connection. The overlay for a table that
      // stays 4404 (TableLoadFailureOverlay, "This Table Has Closed") is
      // driven by the error count, not by this status.
      this.setStatus('idle');
    } else if (this.retryCount >= this.opts.maxRetries) {
      this.setStatus('failed');
      if (this.retryCount === this.opts.maxRetries) {
        this.opts.onError({ reason: 'max retries reached - still retrying in background' });
      }
    } else {
      this.setStatus('reconnecting');
    }
    const base = Math.min(
      this.opts.initialDelay * Math.pow(2, Math.min(this.retryCount, 10) - 1),
      this.opts.maxDelay
    );
    const jitter = Math.random() * base * 0.3;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openOnce();
    }, base + jitter);
  }

  private setStatus(status: EngineConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus(status);
  }
}

export default EngineStateClient;

// ═══════════════════════════════════════════════════════════════════════════════
// EngineChannelClient — general-purpose channel transport
// ═══════════════════════════════════════════════════════════════════════════════
//
// Connects to wss://engine.smarter.poker/ws/channel (new endpoint — see
// server-side requirements note at bottom). Carries all non-table real-time
// channels: club presence, tournament events, lobby, hand replay, financials,
// and table-meta updates.
//
// Same auth scheme as EngineStateClient: Sec-WebSocket-Protocol: bearer, <jwt>.
// Same PING/PONG heartbeat protocol.
//
// CLIENT → SERVER messages:
//   JOIN_CLUB            { type, clubId }
//   LEAVE_CLUB           { type, clubId }
//   UPDATE_PRESENCE      { type, clubId, status, currentTableId? }
//   JOIN_TOURNAMENT      { type, tournamentId }
//   LEAVE_TOURNAMENT     { type, tournamentId }
//   JOIN_LOBBY           { type }
//   LEAVE_LOBBY          { type }
//   REQUEST_HAND_REPLAY  { type, handId }
//
// SERVER → CLIENT messages:
//   CLUB_PRESENCE_UPDATE { type, clubId, members, event, changed? }
//   CLUB_EVENT           { type, clubId, event }
//   TOURNAMENT_EVENT     { type, tournamentId, event }
//   LOBBY_UPDATE         { type, type: 'club_activity'|'tournament_starting'|'jackpot_hit', payload }
//   HAND_REPLAY_EVENT    { type, handId, event }
//   TABLE_META_UPDATE    { type, tableId, table }
//   FINANCIAL_UPDATE     { type, userId, walletType, available, total, ledgerEntry? }
//   PING                 { type, ts }
// ═══════════════════════════════════════════════════════════════════════════════

import type { ClubPresence, ClubEvent, TournamentEvent, HandEvent } from './RealtimeChannelService';
import type { PokerTable } from '../types/database.types';

// ─── Server → Client message types ───────────────────────────────────────────

export interface ChannelPingMessage {
  type: 'PING';
  ts: number;
}
/**
 * 2026-08-24: the server's documented heartbeat frame. The server sweep sent
 * CHANNEL_PING and only accepted CHANNEL_PONG, while this client only answered
 * PING with PONG — so every /ws/channel connection was declared dead and
 * force-closed by the server 60s after it opened, forever. Both sides now
 * speak both dialects so either can deploy first.
 */
export interface ChannelChannelPingMessage {
  type: 'CHANNEL_PING';
  ts?: number;
}
export interface ClubPresenceUpdateMessage {
  type: 'CLUB_PRESENCE_UPDATE';
  clubId: string;
  members: ClubPresence[];
  event: 'sync' | 'join' | 'leave';
  changed?: ClubPresence;
}
export interface ClubEventMessage {
  type: 'CLUB_EVENT';
  clubId: string;
  event: ClubEvent;
}
export interface TournamentEventMessage {
  type: 'TOURNAMENT_EVENT';
  tournamentId: string;
  event: TournamentEvent;
}
export interface LobbyUpdateMessage {
  type: 'LOBBY_UPDATE';
  kind: 'club_activity' | 'tournament_starting' | 'jackpot_hit';
  payload: unknown;
}
export interface HandReplayEventMessage {
  type: 'HAND_REPLAY_EVENT';
  handId: string;
  event: HandEvent;
}
export interface TableMetaUpdateMessage {
  type: 'TABLE_META_UPDATE';
  tableId: string;
  table: Partial<PokerTable>;
}
export interface FinancialUpdateMessage {
  type: 'FINANCIAL_UPDATE';
  userId: string;
  walletType: string;
  available: number;
  total: number;
  ledgerEntry?: unknown;
}

export type ChannelServerMessage =
  | ChannelPingMessage
  | ChannelChannelPingMessage
  | ClubPresenceUpdateMessage
  | ClubEventMessage
  | TournamentEventMessage
  | LobbyUpdateMessage
  | HandReplayEventMessage
  | TableMetaUpdateMessage
  | FinancialUpdateMessage;

// ─── Client → Server message types ───────────────────────────────────────────

export type ChannelClientMessage =
  | { type: 'JOIN_CLUB'; clubId: string }
  | { type: 'LEAVE_CLUB'; clubId: string }
  | {
      type: 'UPDATE_PRESENCE';
      clubId: string;
      status: 'online' | 'at_table' | 'away';
      currentTableId?: string;
    }
  | { type: 'JOIN_TOURNAMENT'; tournamentId: string }
  | { type: 'LEAVE_TOURNAMENT'; tournamentId: string }
  | { type: 'JOIN_LOBBY' }
  | { type: 'LEAVE_LOBBY' }
  | { type: 'REQUEST_HAND_REPLAY'; handId: string }
  | { type: 'PONG'; ts: number }
  | { type: 'CHANNEL_PONG' };

// ─── Listener registrations ───────────────────────────────────────────────────

type Listener<T> = (msg: T) => void;

interface ChannelListeners {
  onClubPresence: Set<Listener<ClubPresenceUpdateMessage>>;
  onClubEvent: Set<Listener<ClubEventMessage>>;
  onTournamentEvent: Set<Listener<TournamentEventMessage>>;
  onLobbyUpdate: Set<Listener<LobbyUpdateMessage>>;
  onHandReplayEvent: Set<Listener<HandReplayEventMessage>>;
  onTableMetaUpdate: Set<Listener<TableMetaUpdateMessage>>;
  onFinancialUpdate: Set<Listener<FinancialUpdateMessage>>;
}

// ─── EngineChannelClient ──────────────────────────────────────────────────────

export interface EngineChannelClientOptions {
  /** Base URL, e.g. https://engine.smarter.poker. Scheme is rewritten to ws(s). */
  baseUrl: string;
  /** Called every time fresh auth is needed. */
  getToken: () => Promise<string | null>;
  /** Called when connection status changes. */
  onStatus?: (status: EngineConnectionStatus) => void;
  /** Maximum reconnect attempts. Default: 10. */
  maxRetries?: number;
  /** Initial backoff ms. Default: 1000. */
  initialDelay?: number;
  /** Max backoff ms. Default: 30000. */
  maxDelay?: number;
}

export class EngineChannelClient {
  private opts: Required<EngineChannelClientOptions>;
  private ws: WebSocket | null = null;
  private status: EngineConnectionStatus = 'idle';
  private retryCount = 0;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  private listeners: ChannelListeners = {
    onClubPresence: new Set(),
    onClubEvent: new Set(),
    onTournamentEvent: new Set(),
    onLobbyUpdate: new Set(),
    onHandReplayEvent: new Set(),
    onTableMetaUpdate: new Set(),
    onFinancialUpdate: new Set(),
  };

  // Queue of messages to send once connected
  private sendQueue: ChannelClientMessage[] = [];
  /** 2026-08-22: bound the offline queue — an hour offline must not flush a
   *  thousand stale messages into the server's rate limiter on reconnect. */
  private static readonly MAX_QUEUE = 100;

  // ── 2026-08-24: DESIRED SUBSCRIPTION STATE — survives reconnects ─────────
  //
  // Server-side subscriptions (ChannelHub clubSubs / tournamentSubs /
  // lobbySubscribers) live on the CONNECTION and die with it. The old client
  // sent each JOIN exactly once at subscribe time and never again, so ANY
  // reconnect — engine deploy, network blip, heartbeat teardown — left the
  // new connection subscribed to NOTHING. Tournament events, club events,
  // presence and lobby updates went silent until a full page reload, with no
  // error anywhere. (Supabase Realtime re-subscribed channels automatically;
  // this behaviour was lost in the migration to the engine WS.)
  //
  // send() records the net desired state below; every onopen replays it.
  // Server JOINs are idempotent (Set adds + alreadyJoined guard), so a replay
  // that races a queued duplicate is harmless.
  private desiredClubs = new Set<string>();
  private desiredTournaments = new Set<string>();
  private desiredLobby = false;
  /** Latest UPDATE_PRESENCE per club, replayed after JOIN_CLUB on reconnect. */
  private lastPresence = new Map<string, ChannelClientMessage>();
  /** True once any socket has reached OPEN — gates the replay to reconnects. */
  private hasConnectedBefore = false;

  /** @internal Track the net effect of a client → server message. */
  private recordDesiredState(msg: ChannelClientMessage): void {
    switch (msg.type) {
      case 'JOIN_CLUB':
        this.desiredClubs.add(msg.clubId);
        return;
      case 'LEAVE_CLUB':
        this.desiredClubs.delete(msg.clubId);
        this.lastPresence.delete(msg.clubId);
        return;
      case 'UPDATE_PRESENCE':
        this.desiredClubs.add(msg.clubId);
        this.lastPresence.set(msg.clubId, msg);
        return;
      case 'JOIN_TOURNAMENT':
        this.desiredTournaments.add(msg.tournamentId);
        return;
      case 'LEAVE_TOURNAMENT':
        this.desiredTournaments.delete(msg.tournamentId);
        return;
      case 'JOIN_LOBBY':
        this.desiredLobby = true;
        return;
      case 'LEAVE_LOBBY':
        this.desiredLobby = false;
        return;
      default:
        return; // PONG / CHANNEL_PONG / REQUEST_HAND_REPLAY carry no state
    }
  }

  /** @internal Re-send the desired subscription state on a fresh socket. */
  private replayDesiredState(ws: WebSocket): void {
    const replay: ChannelClientMessage[] = [];
    for (const clubId of this.desiredClubs) replay.push({ type: 'JOIN_CLUB', clubId });
    for (const msg of this.lastPresence.values()) replay.push(msg);
    for (const tournamentId of this.desiredTournaments)
      replay.push({ type: 'JOIN_TOURNAMENT', tournamentId });
    if (this.desiredLobby) replay.push({ type: 'JOIN_LOBBY' });
    for (const msg of replay) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* onclose will drive the next reconnect */
      }
    }
  }

  // 2026-08-22: staleness watchdog + online-event recovery, mirroring
  // EngineStateClient. This client previously had NEITHER — plus a reconnect
  // ladder that gave up permanently after maxRetries — so one bad stretch of
  // network silently killed club presence, lobby, tournament events and
  // FINANCIAL_UPDATE (wallet!) for the rest of the page's life.
  private lastInboundAt = 0;
  private watchdogTimer: number | null = null;
  private onOnline: (() => void) | null = null;
  /** 2026-08-22: bounded wake grace — see startWatchdog. */
  private onVisibility: (() => void) | null = null;
  private static readonly WATCHDOG_TICK_MS = 10_000;
  private static readonly STALE_HARD_MS = 60_000;
  /**
   * 2026-08-24: periodic subscription RE-ASSERT. Two ways a subscription can
   * silently die on a healthy socket: (a) the server's JOIN_CLUB membership
   * check fails CLOSED on a transient DB error — the join is simply dropped,
   * no error frame, and the client believes it is subscribed; (b) any future
   * server-side state loss that does not close the socket. JOINs are
   * idempotent server-side (Set adds + alreadyJoined guard), so re-sending
   * the desired state every few minutes costs a handful of tiny frames and
   * guarantees a lost subscription heals within one interval instead of
   * never.
   */
  private static readonly REASSERT_INTERVAL_MS = 180_000;
  private lastReassertAt = 0;
  /**
   * How much of the staleness budget a backgrounded tab is forgiven on wake.
   *
   * The watchdog skips its check while the tab is hidden but did NOT reset the
   * clock on the way back, so the first tick after any background longer than
   * STALE_HARD_MS saw a full minute of "silence" and tore down a socket that
   * was very probably fine — dropping club presence, lobby, tournament events
   * and FINANCIAL_UPDATE for a reconnect nobody needed. Every phone user who
   * left the app for a minute paid that.
   *
   * A full reset would be the opposite error: that is exactly the hole that
   * let a half-open socket survive forever in EngineStateClient under frequent
   * tab switching. So the link is forgiven down to a bounded debt and gets one
   * watchdog interval to prove itself — a genuinely dead one is still caught
   * within WATCHDOG_TICK_MS of the wake.
   */
  private static readonly WAKE_GRACE_MS =
    EngineChannelClient.STALE_HARD_MS - EngineChannelClient.WATCHDOG_TICK_MS;

  constructor(opts: EngineChannelClientOptions) {
    this.opts = {
      onStatus: () => undefined,
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30_000,
      ...opts,
    };
  }

  /** Open the channel connection. Safe to call multiple times (no-op if already connected). */
  async connect(): Promise<void> {
    if (this.ws !== null && this.ws.readyState <= 1 /* OPEN or CONNECTING */) return;
    this.intentionalClose = false;
    this.retryCount = 0;
    if (this.onOnline === null && typeof window !== 'undefined') {
      this.onOnline = () => {
        if (this.intentionalClose) return;
        if (this.ws !== null && this.ws.readyState === 1) return;
        if (this.ws !== null && this.ws.readyState === 0) {
          try {
            this.ws.close();
          } catch {
            /* ignore */
          }
          this.ws = null;
        }
        if (this.reconnectTimer !== null) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.retryCount = 0;
        void this.openOnce();
      };
      window.addEventListener('online', this.onOnline);
    }
    await this.openOnce();
  }

  /** Close the channel connection permanently. */
  disconnect(): void {
    this.intentionalClose = true;
    this.stopWatchdog();
    if (this.onOnline !== null && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      this.onOnline = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'intentional');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus('idle');
  }

  /** Current connection status. */
  getStatus(): EngineConnectionStatus {
    return this.status;
  }

  // ─── Send helpers ─────────────────────────────────────────────────────────

  /**
   * Send a typed client → server message.
   * If the socket isn't open yet, the message is queued and sent on connect.
   */
  send(msg: ChannelClientMessage): void {
    // 2026-08-24: record the net desired subscription state FIRST, whether or
    // not the socket is currently open — this is what reconnect replays.
    this.recordDesiredState(msg);
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch (err) {
        console.warn('[EngineChannelClient] send failed:', err);
      }
    } else {
      // Queue for when the connection opens (bounded: drop the oldest first —
      // fresher presence/join state supersedes stale state anyway).
      if (this.sendQueue.length >= EngineChannelClient.MAX_QUEUE) {
        this.sendQueue.shift();
      }
      this.sendQueue.push(msg);
      // Auto-connect on first send
      void this.connect();
    }
  }

  // ─── Listener registration ────────────────────────────────────────────────
  //
  // Each method follows the same pattern:
  //   onXxx(listener) → returns an unsubscribe function () => void
  //
  // Auto-connects the channel on first listener registration.

  onClubPresence(listener: Listener<ClubPresenceUpdateMessage>): () => void {
    this.listeners.onClubPresence.add(listener);
    void this.connect();
    return () => this.listeners.onClubPresence.delete(listener);
  }

  onClubEvent(listener: Listener<ClubEventMessage>): () => void {
    this.listeners.onClubEvent.add(listener);
    void this.connect();
    return () => this.listeners.onClubEvent.delete(listener);
  }

  onTournamentEvent(listener: Listener<TournamentEventMessage>): () => void {
    this.listeners.onTournamentEvent.add(listener);
    void this.connect();
    return () => this.listeners.onTournamentEvent.delete(listener);
  }

  onLobbyUpdate(listener: Listener<LobbyUpdateMessage>): () => void {
    this.listeners.onLobbyUpdate.add(listener);
    void this.connect();
    return () => this.listeners.onLobbyUpdate.delete(listener);
  }

  onHandReplayEvent(listener: Listener<HandReplayEventMessage>): () => void {
    this.listeners.onHandReplayEvent.add(listener);
    void this.connect();
    return () => this.listeners.onHandReplayEvent.delete(listener);
  }

  onTableMetaUpdate(listener: Listener<TableMetaUpdateMessage>): () => void {
    this.listeners.onTableMetaUpdate.add(listener);
    void this.connect();
    return () => this.listeners.onTableMetaUpdate.delete(listener);
  }

  onFinancialUpdate(listener: Listener<FinancialUpdateMessage>): () => void {
    this.listeners.onFinancialUpdate.add(listener);
    void this.connect();
    return () => this.listeners.onFinancialUpdate.delete(listener);
  }

  /**
   * 2026-08-24: status listeners. The constructor's onStatus option is owned
   * by whoever built the singleton; surfaces that need to react to a
   * reconnect (e.g. the wallet refetching balances it may have missed while
   * the socket was down) register here instead. Does NOT auto-connect: a
   * status observer is not a reason to open a network connection.
   */
  private statusListeners = new Set<(status: EngineConnectionStatus) => void>();

  onStatusChange(listener: (status: EngineConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private opening = false;

  private async openOnce(): Promise<void> {
    // Single-flight + live-socket guard — same race as EngineStateClient:
    // openOnce awaits getToken before assigning this.ws, so overlapping
    // invocations would create a second socket and orphan one.
    if (this.opening) return;
    if (this.ws !== null && this.ws.readyState <= 1 /* OPEN or CONNECTING */) return;
    this.opening = true;
    try {
      await this.openOnceInner();
    } finally {
      this.opening = false;
    }
  }

  private async openOnceInner(): Promise<void> {
    this.setStatus(this.retryCount === 0 ? 'connecting' : 'reconnecting');
    // 2026-08-22: a getToken rejection must be a retry, not the permanent end
    // of the reconnect ladder (same fix as EngineStateClient.openOnce).
    let token: string | null = null;
    try {
      token = await this.opts.getToken();
    } catch {
      if (!this.intentionalClose) this.scheduleReconnect();
      return;
    }
    // P2-1: disconnect() may have fired while getToken() was in flight. Abort
    // before creating the socket to avoid leaking a zombie channel connection.
    if (this.intentionalClose) return;
    if (!token) {
      this.scheduleReconnect();
      return;
    }

    const wsUrl = this.opts.baseUrl.replace(/^http/, 'ws') + '/ws/channel';
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, ['bearer', token]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retryCount = 0;
      // 2026-08-24: on a RECONNECT, replay the desired subscription state
      // BEFORE flushing the queue — the fresh connection has no server-side
      // subscriptions, and the queue only holds messages sent while offline.
      // (First connect skips this: the original JOINs are in the queue or
      // will be sent by their callers; replaying would only duplicate them.)
      if (this.hasConnectedBefore) {
        this.replayDesiredState(ws);
      }
      this.hasConnectedBefore = true;
      // Fresh socket just (re)played its state — start the re-assert clock now.
      this.lastReassertAt = Date.now();
      this.setStatus('connected');
      this.startWatchdog();
      // Flush any queued messages
      const queued = this.sendQueue.splice(0);
      for (const msg of queued) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* ignore */
        }
      }
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      // Any byte proves the link is alive (see EngineStateClient.onmessage).
      this.lastInboundAt = Date.now();
      let msg: ChannelServerMessage | null = null;
      try {
        msg = JSON.parse(e.data as string) as ChannelServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof (msg as { type?: string }).type !== 'string') return;
      this.handleMessage(msg);
    };

    ws.onclose = (e) => {
      if (this.ws !== null && this.ws !== ws) return;
      if (this.intentionalClose) return;
      if (e.code === CLOSE_AUTH_FAILED) {
        this.setStatus('auth_failed');
        this.scheduleReconnect();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Errors are always followed by onclose; handle there.
    };
  }

  private handleMessage(msg: ChannelServerMessage): void {
    switch (msg.type) {
      case 'PING': {
        try {
          this.ws?.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
        } catch {
          /* ignore */
        }
        return;
      }
      case 'CHANNEL_PING': {
        // 2026-08-24: the server's heartbeat dialect. Not answering this is
        // what got every channel connection killed at the 60s mark — the
        // server sweep only counted CHANNEL_PONG as proof of life.
        try {
          this.ws?.send(JSON.stringify({ type: 'CHANNEL_PONG' }));
        } catch {
          /* ignore */
        }
        return;
      }
      case 'CLUB_PRESENCE_UPDATE': {
        this.emit('onClubPresence', msg);
        return;
      }
      case 'CLUB_EVENT': {
        this.emit('onClubEvent', msg);
        return;
      }
      case 'TOURNAMENT_EVENT': {
        this.emit('onTournamentEvent', msg);
        return;
      }
      case 'LOBBY_UPDATE': {
        this.emit('onLobbyUpdate', msg);
        return;
      }
      case 'HAND_REPLAY_EVENT': {
        this.emit('onHandReplayEvent', msg);
        return;
      }
      case 'TABLE_META_UPDATE': {
        this.emit('onTableMetaUpdate', msg);
        return;
      }
      case 'FINANCIAL_UPDATE': {
        this.emit('onFinancialUpdate', msg);
        return;
      }
    }
  }

  private emit<K extends keyof ChannelListeners>(
    key: K,
    msg: ChannelListeners[K] extends Set<Listener<infer M>> ? M : never
  ): void {
    // Use setTimeout(0) for same reason as EngineStateClient EVENT handler:
    // prevent React 18 batching from dropping rapid sequential messages
    // (e.g. FINANCIAL_UPDATE arriving back-to-back for wallet + ledger).
    setTimeout(() => {
      (this.listeners[key] as Set<Listener<typeof msg>>).forEach((listener) => {
        try {
          listener(msg);
        } catch (err) {
          console.error(`[EngineChannelClient] ${key} listener threw:`, err);
        }
      });
    }, 0);
  }

  /**
   * 2026-08-22: dead-link detection. The channel server pings every 25s; a
   * minute of silence on an OPEN socket is a half-open link that will never
   * fire onclose on its own. Tear it down into the backoff ladder.
   */
  private startWatchdog(): void {
    this.lastInboundAt = Date.now();
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = window.setInterval(() => {
      if (this.intentionalClose || this.status !== 'connected') return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // 2026-08-24: re-assert desired subscriptions on a live socket — see
      // REASSERT_INTERVAL_MS. Runs before the staleness check on purpose:
      // the replay frames also serve as outbound traffic on a quiet link.
      if (
        this.ws !== null &&
        this.ws.readyState === 1 &&
        Date.now() - this.lastReassertAt >= EngineChannelClient.REASSERT_INTERVAL_MS
      ) {
        this.lastReassertAt = Date.now();
        this.replayDesiredState(this.ws);
      }
      if (Date.now() - this.lastInboundAt < EngineChannelClient.STALE_HARD_MS) return;
      this.lastInboundAt = Date.now();
      this.setStatus('reconnecting');
      const dead = this.ws;
      this.ws = null;
      try {
        dead?.close(4001, 'client staleness watchdog');
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    }, EngineChannelClient.WATCHDOG_TICK_MS);

    // 2026-08-22: the tick above returns early while the tab is hidden, so
    // without this the first tick after a long background reads the entire
    // background as silence and tears down a healthy socket. Grant a BOUNDED
    // grace on wake, never a full reset — the mirror of the game socket's
    // handler, which learned both halves of this the hard way.
    if (typeof document !== 'undefined' && this.onVisibility === null) {
      this.onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        this.lastInboundAt = Math.max(
          this.lastInboundAt,
          Date.now() - EngineChannelClient.WAKE_GRACE_MS
        );
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Must be removed with the timer: a listener that outlives the client keeps
    // firing against a dead socket, and on MultiTablePage several of these come
    // and go as tabs open and close.
    if (this.onVisibility !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.retryCount++;
    // 2026-08-22: NEVER stop trying (same contract as EngineStateClient).
    // The old code returned here at maxRetries with a terminal 'failed', so
    // ~5 minutes of outage permanently killed presence/lobby/tournament/
    // financial updates until a full page reload. 'failed' is now an
    // announcement; the ladder keeps running at maxDelay cadence underneath.
    if (this.retryCount >= this.opts.maxRetries) {
      this.setStatus('failed');
    } else {
      this.setStatus('reconnecting');
    }
    const base = Math.min(
      this.opts.initialDelay * Math.pow(2, Math.min(this.retryCount, 10) - 1),
      this.opts.maxDelay
    );
    const jitter = Math.random() * base * 0.3;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openOnce();
    }, base + jitter);
  }

  private setStatus(status: EngineConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus(status);
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[EngineChannelClient] status listener threw:', err);
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
//
// A single EngineChannelClient is shared across the whole app, analogous to
// how the Supabase client is a singleton. Auth token is read lazily from
// localStorage (same key as the Supabase session) so it always uses the
// latest token without needing an explicit setter.

const ENGINE_BASE_URL =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ENGINE_URL ??
  'https://engine.smarter.poker';

const AUTH_STORAGE_KEY = 'smarter-poker-auth';

function readTokenFromStorage(): string | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_STORAGE_KEY) : null;
    if (!raw) return null;
    const data = JSON.parse(raw) as { access_token?: string };
    return data?.access_token ?? null;
  } catch {
    return null;
  }
}

export const engineChannelClient = new EngineChannelClient({
  baseUrl: ENGINE_BASE_URL,
  // 2026-08-24: routed through the in-memory auth token cache
  // (src/lib/authToken.ts). Fast path is synchronous — no auth-js microtask
  // chain on the connect path. Slow path (cache empty / near expiry) still
  // calls supabase.auth.getSession(), which REFRESHES an expired token
  // (2026-08-22 fix preserved: the raw localStorage read never refreshed, so
  // a device that suspended past token expiry 4401-looped and died).
  // localStorage stays as the last-resort fallback. Dynamic import keeps this
  // module free of an eager supabase dependency (it is unit-tested under
  // jsdom without the app's env).
  getToken: async () => {
    try {
      const { getFreshAccessToken } = await import('../lib/authToken');
      const t = await getFreshAccessToken();
      if (t) return t;
    } catch {
      /* fall back to storage */
    }
    return readTokenFromStorage();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE REQUIREMENTS (documentation — no code change needed here)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Hetzner engine server (server/src/) needs the following additions to
// support the new /ws/channel endpoint:
//
// 1. New WS endpoint: /ws/channel
//    In server/src/transport/EngineWebSocketServer.ts (or a new
//    ChannelWebSocketServer.ts), add handling for upgrade requests whose
//    pathname is '/ws/channel'. Same auth scheme (bearer subprotocol + JWT).
//
// 2. New message router in the channel WS handler:
//    switch (msg.type) {
//      case 'JOIN_CLUB':           // track { userId, clubId } → send CLUB_PRESENCE_UPDATE sync
//      case 'LEAVE_CLUB':          // remove tracking, send CLUB_PRESENCE_UPDATE leave
//      case 'UPDATE_PRESENCE':     // update status in club presence map, broadcast to club
//      case 'JOIN_TOURNAMENT':     // subscribe this conn to tournament:tournamentId events
//      case 'LEAVE_TOURNAMENT':    // unsubscribe
//      case 'JOIN_LOBBY':          // subscribe this conn to lobby:global events
//      case 'LEAVE_LOBBY':         // unsubscribe
//      case 'REQUEST_HAND_REPLAY': // start streaming HandEvent sequence for handId
//      case 'PONG':                // update lastPongAt for heartbeat
//    }
//
// 3. Server-side club presence map:
//    Map<clubId, Map<userId, ClubPresence>>  — maintained in memory.
//    On JOIN_CLUB: add entry, broadcast CLUB_PRESENCE_UPDATE {event:'join', changed} to all
//    club subscribers.
//    On LEAVE_CLUB / connection close: remove entry, broadcast {event:'leave', changed}.
//    On UPDATE_PRESENCE: update entry, broadcast {event:'sync', members: [...]}.
//
// 4. Tournament event fan-out:
//    When the GameServer fires tournament events (eliminations, level_up, etc.),
//    it should call channelHub.broadcastToTournament(tournamentId, event) which
//    sends TOURNAMENT_EVENT to all subscribed channel connections.
//
// 5. Lobby fan-out:
//    Periodic or event-driven LOBBY_UPDATE messages broadcast to all
//    JOIN_LOBBY subscribers (club_activity counts, tournament_starting alerts).
//
// 6. Financial updates:
//    When atomic_credit_wallet_and_log or atomic_table_cashout runs,
//    the engine should broadcast FINANCIAL_UPDATE to the affected userId's
//    channel connection (if online).
//
// 7. Table meta updates:
//    When tables row changes (player count, status), broadcast TABLE_META_UPDATE
//    to connections that have joined the relevant club or are in the lobby.
//
// 8. Hand replay:
//    On REQUEST_HAND_REPLAY, fetch hand events from the DB and stream
//    HAND_REPLAY_EVENT messages to the requesting connection at the requested
//    speed (default 1 event/second).
