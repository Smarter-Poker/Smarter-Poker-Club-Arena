/**
 * LISTEN-based wake for the hand projection worker.
 *
 * WHY THIS EXISTS (2026-09-10). The worker in ./handProjection.ts was woken by
 * a Realtime `postgres_changes` subscription on hand_projection_outbox. That
 * table gets one INSERT and one DELETE per hand (95.5% of everything in the
 * supabase_realtime publication), and Realtime has to logically decode and
 * RLS-check every one of those WAL records to deliver a callback whose payload
 * the worker never read: 5-7% of all database time for a wake-up. A NOTIFY
 * from the insert trigger (migration hand_projection_outbox_notifies_its_listener)
 * carries the same signal for the cost of one queue write at commit.
 *
 * This is a WAKE, not a data path. The payload (hand_id:table_id) is kept for
 * logs and metrics only; the drain re-reads the outbox ordered by hand_number,
 * which is what preserves the per-table predecessor order the database
 * enforces. A lost notification therefore loses nothing durable: the 5 s poll
 * in handProjection.ts and the resync wake after every (re)connect cover it.
 *
 * Connection requirements: LISTEN is session-level, so ENGINE_PG_LISTEN_URL
 * must be the Supavisor SESSION-mode string (port 5432 on the pooler host) or
 * a direct connection - never the transaction pooler on 6543, where LISTEN is
 * refused or silently never delivers. Unset = disabled, logged once at start;
 * the local commit wake, Realtime (until cutover step 2) and the 5 s poll keep
 * hands flowing. The connection string is never logged.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { reportError, describeError } from '../errorReporter.js';
import { wakeHandProjection, type HandProjectionWakeSource } from './handProjection.js';

export const HAND_OUTBOX_CHANNEL = 'hand_projection_outbox';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
export const HEARTBEAT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export type OutboxNotification = { channel: string; payload?: string };

/**
 * The slice of pg.Client this service uses. Narrow on purpose so a test can
 * hand in a plain EventEmitter and so a future driver swap is one factory.
 */
export interface OutboxListenerClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (msg: OutboxNotification) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
}

export type HandOutboxListenerOptions = {
  /** Defaults to process.env.ENGINE_PG_LISTEN_URL. Empty disables the service. */
  connectionString?: string;
  /**
   * Opens the dedicated LISTEN session. Defaults to a TLS pg.Client. This is
   * a raw Postgres session for LISTEN only, never a Data API client: the
   * only Supabase client on the engine is built in ./client.ts, where the
   * actor-authority fence stamps every PostgREST request
   * (TournamentManagerRequestFence.guard.test.ts).
   */
  openSession?: (connectionString: string) => OutboxListenerClient;
  /** Defaults to wakeHandProjection. Injected so the spec can count wakes. */
  wake?: (source: HandProjectionWakeSource) => Promise<unknown>;
  /** Jitter source in [0, 1). Defaults to Math.random. */
  random?: () => number;
};

function sslConfig(): pg.ClientConfig['ssl'] {
  const caFile = process.env.ENGINE_PG_LISTEN_CA_FILE;
  if (caFile) return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

function defaultOpenSession(connectionString: string): OutboxListenerClient {
  return new pg.Client({
    connectionString,
    application_name: `club-arena-engine-outbox-listener:${process.pid}`,
    keepAlive: true,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: sslConfig(),
  });
}

/** Exponential backoff, base 500 ms, capped at 30 s, jittered by +/-25%. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
  return Math.round(delay * (0.75 + random() * 0.5));
}

export class HandOutboxListener {
  private readonly connectionString: string;
  private readonly openSession: (connectionString: string) => OutboxListenerClient;
  private readonly wake: (source: HandProjectionWakeSource) => Promise<unknown>;
  private readonly random: () => number;

  private client: OutboxListenerClient | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private connectsTotal = 0;
  private disconnectsTotal = 0;
  private notificationsTotal = 0;
  private lastNotificationAt = 0;
  private lastPayload = '';

  constructor(options: HandOutboxListenerOptions = {}) {
    this.connectionString = options.connectionString ?? process.env.ENGINE_PG_LISTEN_URL ?? '';
    this.openSession = options.openSession ?? defaultOpenSession;
    this.wake = options.wake ?? wakeHandProjection;
    this.random = options.random ?? Math.random;
  }

  get enabled(): boolean {
    return this.connectionString.length > 0;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Reconnect attempts made since the last successful LISTEN. */
  get reconnectAttempts(): number {
    return this.attempt;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.enabled) {
      console.warn(
        '[HandOutboxListener] ENGINE_PG_LISTEN_URL is not set - LISTEN hand_projection_outbox disabled; projection relies on local commit wakes, Realtime and the 5 s poll'
      );
      return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      client.removeAllListeners('error');
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const client = this.openSession(this.connectionString);
    this.client = client;

    client.on('notification', (msg) => {
      if (msg.channel !== HAND_OUTBOX_CHANNEL) return;
      this.notificationsTotal++;
      this.lastNotificationAt = Date.now();
      this.lastPayload = msg.payload ?? '';
      // Same handler the Realtime callback uses. The drain coalesces.
      void this.wake('listen').catch((err) =>
        reportError(err, 'HandOutboxListener.wake_failed', { payload: this.lastPayload })
      );
    });
    client.on('error', (err) => this.onLost(client, err));
    client.on('end', () => this.onLost(client, new Error('connection ended')));

    try {
      await client.connect();
      await client.query(`LISTEN ${HAND_OUTBOX_CHANNEL}`);
    } catch (err) {
      this.onLost(client, err);
      return;
    }
    if (this.stopped || this.client !== client) {
      await client.end().catch(() => undefined);
      return;
    }

    this.connected = true;
    this.connectsTotal++;
    this.attempt = 0;
    this.startHeartbeat(client);
    console.log(
      `[HandOutboxListener] LISTEN ${HAND_OUTBOX_CHANNEL} established (connect #${this.connectsTotal})`
    );
    // Anything committed while this process had no LISTEN produced no
    // notification it could see. One drain covers the gap; duplicates are
    // harmless because the outbox row is the claim.
    void this.wake('listen_resync').catch((err) =>
      reportError(err, 'HandOutboxListener.resync_wake_failed')
    );
  }

  private onLost(client: OutboxListenerClient, err: unknown): void {
    if (this.client !== client) return; // stale client from a previous attempt
    this.client = null;
    this.stopHeartbeat();
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.disconnectsTotal++;
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.stopped) return;
    const jittered = reconnectDelayMs(this.attempt, this.random);
    this.attempt++;
    // describeError carries the driver's message only (ECONNRESET, timeout,
    // auth failure). The connection string is never part of it.
    reportError(
      new Error(
        `[HandOutboxListener] LISTEN connection lost (${describeError(err)}); reconnect in ${jittered} ms`
      ),
      'HandOutboxListener.connection_lost',
      { attempt: this.attempt, wasConnected }
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(client: OutboxListenerClient): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // A half-open socket (pooler idle reap, NAT timeout) delivers nothing and
      // errors nothing. A trivial round-trip turns it into an error we handle.
      client.query('SELECT 1').catch((err) => this.onLost(client, err));
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  toPrometheus(): string[] {
    const sinceLast =
      this.lastNotificationAt === 0
        ? -1
        : Math.round((Date.now() - this.lastNotificationAt) / 1000);
    return [
      '# HELP poker_hand_outbox_listener_enabled 1 when ENGINE_PG_LISTEN_URL is configured.',
      '# TYPE poker_hand_outbox_listener_enabled gauge',
      `poker_hand_outbox_listener_enabled ${this.enabled ? 1 : 0}`,
      '# HELP poker_hand_outbox_listener_connected 1 while a LISTEN hand_projection_outbox session is open.',
      '# TYPE poker_hand_outbox_listener_connected gauge',
      `poker_hand_outbox_listener_connected ${this.connected ? 1 : 0}`,
      '# HELP poker_hand_outbox_listener_connects_total Successful LISTEN sessions established since process start.',
      '# TYPE poker_hand_outbox_listener_connects_total counter',
      `poker_hand_outbox_listener_connects_total ${this.connectsTotal}`,
      '# HELP poker_hand_outbox_listener_disconnects_total LISTEN sessions lost since process start.',
      '# TYPE poker_hand_outbox_listener_disconnects_total counter',
      `poker_hand_outbox_listener_disconnects_total ${this.disconnectsTotal}`,
      '# HELP poker_hand_outbox_notifications_total NOTIFY messages received on hand_projection_outbox.',
      '# TYPE poker_hand_outbox_notifications_total counter',
      `poker_hand_outbox_notifications_total ${this.notificationsTotal}`,
      '# HELP poker_hand_outbox_notification_age_seconds Seconds since the last NOTIFY; -1 when none yet.',
      '# TYPE poker_hand_outbox_notification_age_seconds gauge',
      `poker_hand_outbox_notification_age_seconds ${sinceLast}`,
    ];
  }
}
