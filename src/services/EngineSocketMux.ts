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

const LINGER_AFTER_LAST_RELEASE_MS = 5_000;

/** Read the opt-in flag. Safe under Safari private mode's throwing storage. */
export function isMuxEnabled(): boolean {
  try {
    return localStorage.getItem('ca_ws_mux') === '1';
  } catch {
    return false;
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
    this.mux.sendFor(this.tableId, data);
  }

  close(code?: number, reason?: string): void {
    this.mux.release(this.tableId, code, reason);
  }

  /** @internal */
  _open(): void {
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
    const prior = this.facades.get(tableId);
    if (prior) prior._close(1000, 'superseded');

    const facade = new MuxTableSocket(this, tableId);
    this.facades.set(tableId, facade);
    this.baseUrl = baseUrl;
    this.token = token;
    this.ensureSocket();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe(tableId);
    }
    return facade;
  }

  /** @internal facade → server, rewriting per-table RESYNC. */
  sendFor(tableId: string, data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let out = data;
    try {
      const msg = JSON.parse(data) as { type?: string };
      if (msg?.type === 'RESYNC') out = JSON.stringify({ type: 'RESYNC', tableId });
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
  release(tableId: string, code?: number, reason?: string): void {
    const facade = this.facades.get(tableId);
    if (!facade) return;
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
    const url = this.baseUrl.replace(/^http/, 'ws') + '/ws/multi';
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['bearer', this.token]);
    } catch {
      // Constructor failure = immediate close for every waiting facade; each
      // EngineStateClient schedules its own reconnect and re-acquires.
      this.failAll(4500, 'mux socket construction failed');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      for (const tableId of this.facades.keys()) this.subscribe(tableId);
    };

    ws.onmessage = (e) => {
      const raw = typeof e.data === 'string' ? e.data : String(e.data);
      let msg: { type?: string; tableId?: string } | null = null;
      try {
        msg = JSON.parse(raw) as { type?: string; tableId?: string };
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'PING') {
        // Liveness belongs to every table; each client stamps its watchdog.
        // (Each replies PONG; duplicates are harmless and far under the
        // server's inbound rate limit.)
        for (const f of this.facades.values()) f._message(raw);
        return;
      }
      if (msg.type === 'SUBSCRIBED' && msg.tableId) {
        this.facades.get(msg.tableId)?._open();
        return;
      }
      if (msg.type === 'ERROR' && msg.tableId) {
        // Per-table refusal (not found / banned / cap). Deliver for logging,
        // then close that facade so the client's backoff owns retry policy.
        const f = this.facades.get(msg.tableId);
        if (f) {
          f._message(raw);
          this.facades.delete(msg.tableId);
          f._close(4400, 'subscription refused');
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
