/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ENGINE SOCKET MUX — one WebSocket for up to four tables (roadmap batch 6)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four open tables used to mean four engine sockets: four TLS handshakes on
 * every network blip, four heartbeats, four reconnect storms hitting the
 * engine at the exact moment it is already under load. This module keeps ONE
 * physical socket to `/ws/multi` and hands each EngineStateClient a
 * WebSocket-shaped facade for its table.
 *
 * DEFAULT OFF. EngineStateClient only routes through the mux when the
 * `ca_ws_mux` localStorage flag is '1' (see isMuxEnabled). With the flag
 * unset, nothing here runs and the per-table `/ws/table/:id` path is used
 * exactly as before. Server support shipped in the same commit
 * (EngineWebSocketServer `/ws/multi`, unit-tested in
 * EngineWebSocketServer.mux.test.ts); the flag stays off until a soak in
 * real play says otherwise.
 *
 * Protocol (server side is authoritative):
 *   C→S SUBSCRIBE   { type, tableId }        → gates run per table
 *   C→S UNSUBSCRIBE { type, tableId }
 *   C→S RESYNC      { type, tableId }        (facade rewrites the client's
 *                                             plain RESYNC to include its
 *                                             tableId)
 *   C→S PONG        { type, ts }             (passes through unchanged)
 *   S→C SUBSCRIBED  { type, tableId }        → facade reports OPEN
 *   S→C SNAPSHOT / DELTA / EVENT { tableId, ... } → routed by tableId
 *   S→C PING        { type, ts }             → delivered to every facade
 *   S→C ERROR       { type, tableId, code }  → delivered, then facade closes
 *
 * The facade mirrors the real WebSocket lifecycle EngineStateClient already
 * knows: onopen fires once subscribed, onclose fires when the physical link
 * dies or the table subscription is refused, and the client's own reconnect
 * / RESYNC / watchdog logic runs unchanged on top.
 */

/**
 * 2026-08-24: raised 5s -> 60s. With the mux now default-ON this socket IS the
 * lobby connection: a player who stands up, browses the lobby, and sits at
 * another table within a minute reuses the warm socket instead of paying a
 * fresh TLS handshake. One idle WS per browsing player is far cheaper for the
 * engine than the reconnect storm of per-join handshakes it replaces.
 *
 * 2026-09-04: 60s -> 10 minutes. Until today an idle socket could not have
 * lived past 60s anyway (see THE SOCKET ANSWERS ITS OWN PINGS below), so the
 * linger was moot. Now that it can, a player reading the lobby for a few
 * minutes between tables keeps the warm socket, and every table they open
 * is a SUBSCRIBE frame, not a handshake. Dan: "it must always stay connected
 * at all times."
 */
const LINGER_AFTER_LAST_RELEASE_MS = 10 * 60_000;
/** Physical socket stuck in CONNECTING longer than this is torn down. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** A facade whose SUBSCRIBE gets no SUBSCRIBED within this is failed. */
const SUBSCRIBE_TIMEOUT_MS = 15_000;
/** Server pings every 25s; an OPEN physical socket silent this long is dead. */
const STALE_HARD_MS = 60_000;
const WATCHDOG_TICK_MS = 10_000;
/**
 * 2026-08-22: close code for "a newer client claimed this table's facade".
 * EngineStateClient treats it as terminal for that instance — reconnecting
 * would evict the newer owner and ping-pong forever (StrictMode double-mount,
 * rapid table switches).
 */
export const CLOSE_MUX_SUPERSEDED = 4901;

/**
 * ═══ THE PROTOCOL VERSION (Realtime Phase 4, 2026-09-05) ═══════════════════
 *
 * What this bundle speaks, sent as `?v=` on the socket URL.
 *
 * IN THE URL, NOT A FRAME. The multiplexed socket does have a SUBSCRIBE frame
 * and the per-table socket does not - the table is named by the path and the
 * engine sends a SNAPSHOT on connect - so a frame would cover one socket and
 * not the other, and would arrive after the connection had already been
 * accepted. The URL is the one place both sockets share and the one moment the
 * engine can still refuse.
 *
 * WHY IT EXISTS BEFORE IT IS NEEDED. Club Arena's origin keeps old assets on
 * purpose (CLAUDE.md 1.1), so a tab open since yesterday is running
 * yesterday's bundle against today's engine, mid-hand. Today the engine
 * accepts every version and this costs one query parameter. The day a frame
 * changes shape, `MIN_CLIENT_PROTOCOL` on the engine goes up by one, and
 * instead of a stale tab misreading a frame in a way nobody can debug it is
 * closed with 4426 and told to go and fetch the new bytes.
 *
 * A version this bundle does not send is read by the engine as 0, so the
 * mechanism reaches the bundles that predate it too - which is the entire
 * population it exists for.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Build an engine socket URL carrying this bundle's protocol version.
 *
 * ONE function for both sockets on purpose. A version that rode on only the
 * multiplexed socket would be worse than none: the engine would refuse the
 * stale bundles that happened to be muxed and silently serve the ones behind
 * the `ca_ws_mux='0'` kill switch.
 */
export function engineSocketUrl(baseUrl: string, path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${baseUrl.replace(/^http/, 'ws')}${path}${sep}v=${PROTOCOL_VERSION}`;
}

/**
 * Mux flag. DEFAULT ON as of 2026-08-24 (Dan: kill the per-join TLS handshake
 * globally — every table join must be a SUBSCRIBE frame on the already-open
 * lobby socket, not a fresh wss:// negotiation). `ca_ws_mux`:
 *   unset / '1'  -> mux ON (shared /ws/multi socket)
 *   '0'          -> mux OFF (legacy per-table /ws/table/:id sockets) — the
 *                   kill switch if a soak regression appears.
 * Safe under Safari private mode's throwing storage (throw -> default ON).
 */
export function isMuxEnabled(): boolean {
  try {
    return localStorage.getItem('ca_ws_mux') !== '0';
  } catch {
    return true;
  }
}

/**
 * WebSocket-shaped facade for a single table over the shared socket.
 * Implements exactly the surface EngineStateClient uses: the four handler
 * properties, readyState, send(), close().
 */
export class MuxTableSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  /** 0 CONNECTING, 1 OPEN, 3 CLOSED — same values as WebSocket. */
  readyState = 0;

  constructor(
    private readonly mux: EngineSocketMuxImpl,
    readonly tableId: string
  ) {}

  send(data: string): void {
    this.mux.sendFor(this, data);
  }

  close(code?: number, reason?: string): void {
    this.mux.release(this, code, reason);
  }

  /** @internal 2026-08-22: SUBSCRIBE->SUBSCRIBED watchdog handle. */
  _subTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal */
  _open(): void {
    if (this._subTimer) {
      clearTimeout(this._subTimer);
      this._subTimer = null;
    }
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.();
  }

  /** @internal */
  _message(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  /** @internal */
  _close(code?: number, reason?: string): void {
    if (this._subTimer) {
      clearTimeout(this._subTimer);
      this._subTimer = null;
    }
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class EngineSocketMuxImpl {
  private ws: WebSocket | null = null;
  private facades = new Map<string, MuxTableSocket>();
  private baseUrl = '';
  private token = '';
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  /** 2026-08-22: physical-socket liveness. Stamped on every inbound frame. */
  private lastInboundAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Get a facade for a table, (re)establishing the shared socket as needed.
   * A fresh facade is returned on every call — matching `new WebSocket()`
   * semantics so EngineStateClient's reconnect flow needs no special cases.
   */
  acquire(baseUrl: string, tableId: string, token: string): MuxTableSocket {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    // A stale facade for the same table (pre-reconnect) is superseded.
    // 2026-08-22: with a DEDICATED close code — closing it with 1000 made the
    // old owner's EngineStateClient schedule a reconnect, which re-acquired
    // and evicted THIS facade: an unbounded mutual-eviction loop whenever the
    // same table was mounted twice (StrictMode, rapid switches). 4901 tells
    // the old owner "a newer client owns this table now; stand down".
    const prior = this.facades.get(tableId);
    /* ADOPT THE WARM SUBSCRIPTION INSTEAD OF PAYING FOR IT TWICE (Dan
       2026-09-07: "TABLES ... SHOULD BE RUNNING AT ALL TIMES, AND PRE LOADED").
       The lobby warm-up (services/tableWarmup) exists to get SUBSCRIBE out
       early so the felt mounts against a live subscription. It was doing that
       and then throwing the result away: the real join arrives here, the warm
       facade is superseded, a fresh facade starts at readyState 0, and the
       client sits in 'connecting' for a SECOND SUBSCRIBE->SUBSCRIBED
       round-trip that had already completed. The warm-up shortened the window
       it was supposed to remove.
       If the prior facade is genuinely OPEN, the server-side subscription for
       this table is established on a physical socket that is still up, so the
       new facade is already live the moment it is wired in — recorded here and
       acted on below, after the facade exists. */
    const adoptWarmSubscription =
      !!prior &&
      prior.readyState === 1 &&
      !!this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      Date.now() - this.lastInboundAt <= STALE_HARD_MS;
    if (prior) prior._close(CLOSE_MUX_SUPERSEDED, 'superseded by newer acquire');

    this.baseUrl = baseUrl;
    this.token = token;

    // 2026-08-22: a physical socket that is OPEN but has heard NOTHING for a
    // hard-stale interval is half-open — reusing it strands every facade
    // forever (SUBSCRIBE sent into the void, SUBSCRIBED never returns, and
    // readyState still reads OPEN so nothing else escalates). Replace it.
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.lastInboundAt > 0 &&
      Date.now() - this.lastInboundAt > STALE_HARD_MS
    ) {
      this.teardownPhysical(4001, 'stale physical socket at acquire');
    }

    // Register only after retiring the old transport. Otherwise failAll()
    // closes this new facade before its caller can attach onclose, leaving
    // the table stranded on a CLOSED facade with no reconnect scheduled.
    const facade = new MuxTableSocket(this, tableId);
    this.facades.set(tableId, facade);
    this.ensureSocket();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe(tableId);
    }

    /* The adopted case: open on the next microtask rather than waiting for a
       SUBSCRIBED that the server has already sent for this table. Not
       synchronous — the caller has not had a chance to attach onopen yet, and
       `new WebSocket()` never fires onopen inside its own constructor either.
       The SUBSCRIBE above still goes out and is idempotent server-side, so a
       subscription that turns out to be gone is re-established anyway and the
       normal ERROR/close path still applies. No watchdog is armed here: there
       is nothing to wait for. */
    if (adoptWarmSubscription) {
      queueMicrotask(() => {
        if (this.facades.get(tableId) === facade && facade.readyState === 0) facade._open();
      });
      return facade;
    }

    // SUBSCRIBE->SUBSCRIBED watchdog: no ack within the timeout fails THIS
    // facade (the owning client's backoff handles retry), and marks the
    // physical socket suspect if it has also gone silent.
    facade._subTimer = setTimeout(() => {
      facade._subTimer = null;
      if (facade.readyState !== 0) return;
      if (this.facades.get(tableId) === facade) this.facades.delete(tableId);
      const silent =
        this.lastInboundAt === 0 || Date.now() - this.lastInboundAt > SUBSCRIBE_TIMEOUT_MS;
      facade._close(4500, 'subscribe timeout');
      if (silent) this.teardownPhysical(4001, 'no inbound traffic across subscribe window');
    }, SUBSCRIBE_TIMEOUT_MS);
    return facade;
  }

  /**
   * LOBBY PRE-WARM (2026-08-24). Open the physical /ws/multi socket during app
   * boot, before any table is joined, so the first join pays only a SUBSCRIBE
   * round-trip (~30ms) instead of TCP + TLS + WS upgrade (~300-600ms).
   *
   * Best-effort by design: no reconnect ladder of its own. If the pre-warmed
   * socket dies with no facades attached, failAll() is a no-op and the next
   * acquire() simply establishes a fresh socket — exactly the pre-existing
   * cold path. Cancels a pending linger-close so a warm socket is never
   * thrown away moments before a join.
   */
  prewarm(baseUrl: string, token: string): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // already warm
    this.baseUrl = baseUrl;
    this.token = token;
    this.ensureSocket();
  }

  /**
   * Does a facade already exist for this table on the shared socket? The table
   * warm-up (services/tableWarmup.ts) asks before acquiring a placeholder, so a
   * table a player is already seated at in the multi-table view is never
   * superseded by a lobby warm-up. A facade in ANY non-closed state counts:
   * CONNECTING (0) is a warm-up or a real client mid-subscribe, OPEN (1) is a
   * live table; either one owns the table and must not be displaced.
   */
  isSubscribed(tableId: string): boolean {
    const f = this.facades.get(tableId);
    return !!f && f.readyState !== 3 /* CLOSED */;
  }

  /** Force-close and detach the physical socket; surviving facades fail and
   *  their clients reconnect (which re-acquires a fresh socket). */
  private teardownPhysical(code: number, reason: string): void {
    const dead = this.ws;
    this.ws = null;
    this.stopWatchdog();
    if (dead) {
      try {
        dead.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.failAll(code, reason);
  }

  private startWatchdog(): void {
    this.lastInboundAt = Date.now();
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - this.lastInboundAt < STALE_HARD_MS) return;
      this.teardownPhysical(4001, 'mux staleness watchdog');
    }, WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** @internal facade → server, rewriting per-table RESYNC. */
  sendFor(facade: MuxTableSocket, data: string): void {
    const { tableId } = facade;
    if (this.facades.get(tableId) !== facade || facade.readyState === 3) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let out = data;
    try {
      const msg = JSON.parse(data) as { type?: string };
      if (msg?.type === 'RESYNC') out = JSON.stringify({ type: 'RESYNC', tableId });
      // The physical socket already answered this PING (see onmessage); a
      // facade's PONG is a duplicate.
      if (msg?.type === 'PONG') return;
    } catch {
      /* pass through unparseable frames untouched */
    }
    try {
      this.ws.send(out);
    } catch {
      /* physical onclose will fan out shortly */
    }
  }

  /** @internal facade close → unsubscribe; last one out lingers then closes. */
  release(facade: MuxTableSocket, code?: number, reason?: string): void {
    const { tableId } = facade;
    // Cleanup belongs to the acquiring instance, not merely the table ID.
    // A superseded client's delayed disconnect must not evict its successor.
    if (this.facades.get(tableId) !== facade) return;
    this.facades.delete(tableId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'UNSUBSCRIBE', tableId }));
      } catch {
        /* ignore */
      }
    }
    facade._close(code ?? 1000, reason ?? 'released');
    if (this.facades.size === 0 && this.ws) {
      // Linger briefly: table switches and reconnects re-acquire within
      // moments, and re-using the socket beats a fresh TLS handshake.
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        if (this.facades.size === 0 && this.ws) {
          try {
            this.ws.close(1000, 'no subscribers');
          } catch {
            /* ignore */
          }
          this.ws = null;
          this.stopWatchdog();
        }
      }, LINGER_AFTER_LAST_RELEASE_MS);
    }
  }

  private subscribe(tableId: string): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'SUBSCRIBE', tableId }));
    } catch {
      /* physical onclose will fan out */
    }
  }

  private ensureSocket(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // CONNECTING or OPEN
    // Carries this bundle's protocol version, from the same helper the
    // per-table socket uses (Realtime Phase 4): a version on only one of the
    // two sockets would refuse the stale bundles that happened to be muxed
    // and silently serve the ones that were not.
    const url = engineSocketUrl(this.baseUrl, '/ws/multi');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['bearer', this.token]);
    } catch {
      // Constructor failure = immediate close for every waiting facade; each
      // EngineStateClient schedules its own reconnect and re-acquires.
      // Match native asynchronous socket events: acquire() must return before
      // onclose fires. Capture this generation now so a later acquire cannot
      // be closed by the failed attempt's queued notification.
      const failed = [...this.facades.values()];
      this.facades.clear();
      void Promise.resolve().then(() => {
        for (const facade of failed) facade._close(4500, 'mux socket construction failed');
      });
      return;
    }
    this.ws = ws;

    // 2026-08-22: bound CONNECTING — a wedged handshake fires neither onopen
    // nor onclose, and `readyState <= OPEN` above would trust it forever.
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        this.teardownPhysical(4001, 'mux handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.startWatchdog();
      for (const tableId of this.facades.keys()) this.subscribe(tableId);
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      const raw = typeof e.data === 'string' ? e.data : String(e.data);
      let msg: { type?: string; tableId?: string; code?: string } | null = null;
      try {
        msg = JSON.parse(raw) as { type?: string; tableId?: string };
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'PING') {
        /* ═══ THE SOCKET ANSWERS ITS OWN PINGS (2026-09-04) ═══════════════
           The server pings every 25s and closes any connection that has not
           PONGed in 60s (EngineWebSocketServer.heartbeatSweep, 1001
           "heartbeat timeout"). Until today the only PONGs on this socket
           came from the facades' EngineStateClients - so a physical socket
           with NO facade never answered. That is the pre-warmed lobby socket
           (ServiceBootstrap.prewarm at boot), and the linger after the last
           table is released, and the whole reason both existed was to be
           alive when the next table was opened.

           Measured in production, in Dan's own browser, 2026-09-04: the
           boot socket opened at t+0, the table was opened at t+42s (facade
           attached, SUBSCRIBED, felt live), and at t+60s the server closed
           the socket for the PINGs that went unanswered BEFORE the facade
           existed. Every facade failed, EngineStateClient went
           'reconnecting', and the felt showed "Reconnecting To The Table"
           twenty seconds into a table that had loaded perfectly. Anyone who
           spent 35-60s in the lobby after boot got the same; anyone who
           spent longer got a dead pre-warm and a cold handshake on join.

           So the physical socket answers every PING itself, exactly once,
           facades or not. The frame is still fanned out so each client stamps
           its own staleness watchdog; their PONGs are dropped in sendFor so
           four tables do not mean four replies. */
        try {
          ws.send(JSON.stringify({ type: 'PONG', ts: (msg as { ts?: number }).ts ?? Date.now() }));
        } catch {
          /* physical onclose will fan out */
        }
        for (const f of this.facades.values()) f._message(raw);
        return;
      }
      if (msg.type === 'SUBSCRIBED' && msg.tableId) {
        this.facades.get(msg.tableId)?._open();
        return;
      }
      if (msg.type === 'ERROR' && msg.tableId) {
        // Per-table refusal. Deliver for logging, then close that facade with
        // a close code that PRESERVES the refusal's meaning — flattening
        // everything to 4400 gave "table not found" the wrong retry policy in
        // both directions (retried forever with the mux on, abandoned forever
        // with it off). The server's codes: TABLE_NOT_FOUND, BANNED,
        // TABLE_CAP, SUB_FAILED.
        const f = this.facades.get(msg.tableId);
        if (f) {
          f._message(raw);
          this.facades.delete(msg.tableId);
          const closeCode =
            msg.code === 'TABLE_NOT_FOUND' ? 4404 : msg.code === 'BANNED' ? 4403 : 4400;
          f._close(closeCode, 'subscription refused: ' + (msg.code ?? 'unknown'));
        }
        return;
      }
      if (msg.tableId) {
        this.facades.get(msg.tableId)?._message(raw);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return; // superseded socket - its facades are gone
      for (const f of this.facades.values()) f.onerror?.({});
    };

    ws.onclose = (e) => {
      /**
       * Audit round 4: failAll used to run UNCONDITIONALLY here. In the
       * narrow window where a dying socket sits in CLOSING and a reconnect
       * has already created its replacement, the OLD socket's close event
       * then killed every facade registered on the NEW one. A superseded
       * socket's facades were already failed when it was superseded; its
       * close is history, not news.
       */
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopWatchdog();
      this.failAll(e.code, e.reason);
    };
  }

  private failAll(code?: number, reason?: string): void {
    const all = [...this.facades.values()];
    this.facades.clear();
    for (const f of all) f._close(code, reason);
  }
}

export const engineSocketMux = new EngineSocketMuxImpl();
