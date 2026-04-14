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
 * This file does NOT depend on any React or Zustand code so it can be unit-
 * tested with jsdom. The React binding lives in hooks/useEngineTableState.
 */

import jsonPatch from 'fast-json-patch';
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
  payload: Record<string, unknown>;
}
export type ServerMessage =
  | ServerSnapshotMessage
  | ServerDeltaMessage
  | ServerPingMessage
  | ServerEventMessage;

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
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  private snapshot: EngineSnapshot | null = null;
  private seq: number = 0;

  constructor(opts: EngineStateClientOptions) {
    this.opts = {
      onStatus: () => undefined,
      onEvent: () => undefined,
      onError: () => undefined,
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30_000,
      ...opts,
    };
  }

  /** Open the connection. Call once from the owning hook. */
  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.retryCount = 0;
    await this.openOnce();
  }

  /** Close the connection permanently. */
  disconnect(): void {
    this.intentionalClose = true;
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

  /** Current snapshot, or null if no snapshot has arrived yet. */
  getSnapshot(): EngineSnapshot | null {
    return this.snapshot;
  }

  getSeq(): number {
    return this.seq;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async openOnce(): Promise<void> {
    this.setStatus(this.retryCount === 0 ? 'connecting' : 'reconnecting');
    const token = await this.opts.getToken();
    if (!token) {
      // No token available. Retry on backoff — the auth layer may be warming up.
      this.scheduleReconnect();
      return;
    }

    const wsUrl = this.opts.baseUrl.replace(/^http/, 'ws') + '/ws/table/' + this.opts.tableId;
    // Subprotocol carries auth. Two entries: the literal "bearer", then the JWT.
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, ['bearer', token]);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryCount = 0;
      this.setStatus('connected');
      // Server sends SNAPSHOT on subscribe — no explicit RESYNC needed on
      // first connect. On reconnect after a gap, we explicitly request one.
      if (this.seq > 0) {
        try {
          ws.send(JSON.stringify({ type: 'RESYNC' }));
        } catch {
          /* will be covered by next onclose → reconnect */
        }
      }
    };

    ws.onmessage = (e) => {
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

      // Table gone — stop trying
      if (e.code === CLOSE_TABLE_NOT_FOUND) {
        this.setStatus('failed');
        this.opts.onError({ code: e.code, reason: e.reason });
        return;
      }

      // Anything else (transient server/network issue) → reconnect
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Errors are always followed by onclose; handle there.
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'SNAPSHOT': {
        this.snapshot = msg.state;
        this.seq = msg.seq;
        this.opts.onSnapshot(this.snapshot, this.seq);
        return;
      }
      case 'DELTA': {
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
        return;
      }
      case 'PING': {
        try {
          this.ws?.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
        } catch {
          /* onclose will reconnect */
        }
        return;
      }
      case 'EVENT': {
        // Forward the transient event payload to the owning hook so the UI
        // can dispatch by payload.type (insurance_offers, rit_offer, etc).
        this.opts.onEvent(msg.payload);
        return;
      }
    }
  }

  private requestResync(): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'RESYNC' }));
    } catch {
      /* onclose will reconnect */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.retryCount >= this.opts.maxRetries) {
      this.setStatus('failed');
      this.opts.onError({ reason: 'max retries reached' });
      return;
    }
    this.retryCount++;
    this.setStatus('reconnecting');
    const base = Math.min(
      this.opts.initialDelay * Math.pow(2, this.retryCount - 1),
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
