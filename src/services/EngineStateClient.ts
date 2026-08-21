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
  private onVisibility: (() => void) | null = null;
  /** Dan 2026-08-21: browser 'online' hook for instant post-outage reconnect. */
  private onOnline: (() => void) | null = null;

  /** How often the watchdog samples. */
  private static readonly WATCHDOG_TICK_MS = 5_000;
  /** Silence beyond this requests a RESYNC (server pings every 25s). */
  private static readonly STALE_SOFT_MS = 35_000;
  /** Silence beyond this tears the socket down and reconnects. */
  private static readonly STALE_HARD_MS = 60_000;

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
        if (this.ws !== null && this.ws.readyState <= 1) return;
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
    if (this.onOnline !== null && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      this.onOnline = null;
    }
    // Dan 2026-08-15 (item 6): tear the watchdog down here or its interval and
    // visibilitychange listener outlive the client. In MultiTablePage, where
    // up to four of these exist and tabs open/close freely, that leaks a timer
    // per closed table and keeps firing against a dead socket.
    this.stopWatchdog();
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
      // Dan 2026-08-15 (item 6): arm the staleness watchdog for this socket.
      this.startWatchdog();
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
      // Dan 2026-08-15 (item 6): stamp BEFORE parsing, and for every frame
      // including PING. Any byte from the server proves the link is alive;
      // gating this on a successful parse would let a malformed frame look
      // like silence and trip the watchdog on a healthy connection.
      this.lastInboundAt = Date.now();
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
        //
        // Dan 2026-04-17 (Task 56 — pot shipping / winner acknowledgment):
        // The server emits `pot_win` and `hand_complete` back-to-back in the
        // same synchronous code path (HandController.completeHand). On the
        // client, both WS frames often arrive in the same JS macrotask, so
        // React 18's automatic batching collapsed the two `setLastEvent(...)`
        // calls into a single render — only `hand_complete` survived, and
        // `pot_win` was dropped silently. That's why the pot-shipping
        // animation + winner banner never fired on production.
        //
        // Fix: defer each event dispatch to its own macrotask via
        // `setTimeout(..., 0)`. That forces a separate React render per
        // event, so every `useEffect([engineLastEvent])` watcher observes
        // every event in order. Tiny (<1ms) latency penalty, totally
        // invisible to the user — the animations now fire every hand.
        const payload = msg.payload;
        setTimeout(() => {
          try {
            this.opts.onEvent(payload);
          } catch (err) {
            // Never let a listener throw propagate back into the WS
            // message pump — it would kill the connection.
            console.error('[EngineStateClient] onEvent listener threw', err);
          }
        }, 0);
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

      if (silentFor >= EngineStateClient.STALE_HARD_MS) {
        // The socket claims to be open but the server has said nothing for a
        // full minute — well past two missed 25s pings. Force it closed so
        // onclose -> scheduleReconnect runs. Without this the table is stuck.
        this.opts.onError({
          reason: `engine silent for ${Math.round(silentFor / 1000)}s - forcing reconnect`,
        });
        this.lastInboundAt = Date.now(); // don't re-fire while the close lands
        try {
          this.ws?.close(4001, 'client staleness watchdog');
        } catch {
          /* fall through — schedule directly below */
        }
        // If close() did not synchronously trigger onclose (already CLOSING,
        // or a wedged socket), drive the reconnect ourselves.
        if (!this.ws || this.ws.readyState === 3 /* CLOSED */) {
          this.scheduleReconnect();
        }
        return;
      }

      if (silentFor >= EngineStateClient.STALE_SOFT_MS) {
        // Might just be dropped frames on a live socket — ask for a full
        // snapshot. A reply refreshes lastInboundAt and clears the condition.
        this.requestResync();
      }
    }, EngineStateClient.WATCHDOG_TICK_MS);

    // Coming back to a backgrounded tab: timers were throttled, so treat the
    // gap as unknown rather than as evidence of failure. Re-arm the clock and
    // pull a fresh snapshot immediately — the table may have moved on a lot.
    if (typeof document !== 'undefined' && this.onVisibility === null) {
      this.onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        this.lastInboundAt = Date.now();
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
    if (this.retryCount >= this.opts.maxRetries) {
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
  | { type: 'PONG'; ts: number };

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
    await this.openOnce();
  }

  /** Close the channel connection permanently. */
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
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch (err) {
        console.warn('[EngineChannelClient] send failed:', err);
      }
    } else {
      // Queue for when the connection opens
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

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async openOnce(): Promise<void> {
    this.setStatus(this.retryCount === 0 ? 'connecting' : 'reconnecting');
    const token = await this.opts.getToken();
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
      this.retryCount = 0;
      this.setStatus('connected');
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.retryCount >= this.opts.maxRetries) {
      this.setStatus('failed');
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
  getToken: async () => readTokenFromStorage(),
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
