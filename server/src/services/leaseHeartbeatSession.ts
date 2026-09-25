/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LEASE RENEWAL CANNOT QUEUE BEHIND GAME TRAFFIC (2026-09-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED (2026-09-22, engine logs and Postgres/PostgREST logs)
 *
 * Every table and tournament lease heartbeat went through the SHARED
 * PostgREST client, the same client every hand, seat and settlement uses.
 * Between 13:52:55 and 13:53:30 UTC PostgREST answered 437 requests with
 * 504 PGRST003 "Timed out acquiring connection from connection pool": game
 * traffic held every pool connection. The heartbeat statement itself is fast
 * (heartbeat_tournament_leases_v4: mean 46.6 ms over 264,503 calls), but it
 * never reached Postgres, so no heartbeat was answered inside the 20 s local
 * proof window and every manager's proof expired at once: 1,616
 * lease_proof_expired and 572 tournament_lease_lost in one minute. Each such
 * burst kills manager generations mid-hand and leaves reserved hands that
 * block their tables (the MTT stall). 103 more followed in one hour.
 *
 * A longer proof is not a fix: the 30 s takeover boundary caps it.
 *
 * THE FIX
 *
 * Renewal runs on a persistent Postgres session of its own, one per scope
 * (tournament, table), that game traffic cannot fill. It uses the engine's
 * existing raw-session configuration (./supabase/enginePgSession.ts, the same
 * connection string and TLS as the LISTEN session) and invents no credential.
 *
 *   - One statement at a time per scope. The session sets statement_timeout
 *     to 8 s, and a local bound of 10 s drops a session whose socket went
 *     silent, so one bad statement can delay the next by at most that.
 *   - A lost session reconnects in the background with jittered backoff. The
 *     heartbeat loop never waits for a reconnect: while the session is down
 *     each request uses the shared client exactly as before.
 *   - No configured session (the variable is unset), or a login role without
 *     EXECUTE on the heartbeat function, means the shared client, unchanged.
 *
 * WHAT DOES NOT CHANGE
 *
 * This module is transport only. It returns the same { data, error } shape
 * as supabase.rpc, and the callers in tableLease.ts and tournamentLease.ts
 * keep every proof rule: the proof deadline is read immediately BEFORE this
 * call (so time spent waiting here only shortens it), the window is 20 s,
 * `busy` and every error or UNKNOWN outcome extend nothing, and authority is
 * extended only by a validated `kept` row on the exact generation.
 *
 * WHY THIS MAY BYPASS THE DATA API ACTOR FENCE
 *
 * The PostgREST pre-request hook reads the actor headers stamped in
 * ./supabase/client.ts. Neither heartbeat function reads a request setting or
 * auth.role(): both are SECURITY DEFINER, take their authority from their
 * arguments (instance id and exact lease generation), and touch only
 * heartbeat_at, which no lease trigger inspects. So the session runs exactly
 * these two statements and nothing else
 * (TournamentManagerRequestFence.guard.test.ts pins that).
 */

import pg from 'pg';
import { supabase } from './supabase/client.js';
import {
  enginePgConnectionString,
  enginePgSsl,
  reconnectDelayMs,
} from './supabase/enginePgSession.js';

export type LeaseHeartbeatScope = 'tournament' | 'table';

export const LEASE_HEARTBEAT_STATEMENT_TIMEOUT_MS = 8_000;
/** A silent socket is dropped this long after its statement was sent. */
export const LEASE_HEARTBEAT_LOCAL_BOUND_MS = LEASE_HEARTBEAT_STATEMENT_TIMEOUT_MS + 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Connect, SET and the privilege check together; a caller may wait this long once. */
const CONNECT_BOUND_MS = CONNECT_TIMEOUT_MS + 2_000;

const HEARTBEAT_FUNCTION = {
  tournament: 'heartbeat_tournament_leases_v4',
  table: 'heartbeat_table_leases_v4',
} as const satisfies Record<LeaseHeartbeatScope, string>;

/* The only statements this session ever runs. */
const HEARTBEAT_SQL: Record<LeaseHeartbeatScope, string> = {
  tournament:
    'SELECT tournament_id::text AS tournament_id, state, lease_generation::text AS lease_generation ' +
    'FROM public.heartbeat_tournament_leases_v4($1::text, $2::jsonb, $3::integer)',
  table:
    'SELECT table_id::text AS table_id, state, lease_generation::text AS lease_generation ' +
    'FROM public.heartbeat_table_leases_v4($1::text, $2::jsonb, $3::integer)',
};
const EXECUTE_PRIVILEGE_SQL: Record<LeaseHeartbeatScope, string> = {
  tournament:
    "SELECT has_function_privilege('public.heartbeat_tournament_leases_v4(text,jsonb,integer)', 'EXECUTE') AS ok",
  table:
    "SELECT has_function_privilege('public.heartbeat_table_leases_v4(text,jsonb,integer)', 'EXECUTE') AS ok",
};
const STATEMENT_TIMEOUT_SQL = `SET statement_timeout = ${LEASE_HEARTBEAT_STATEMENT_TIMEOUT_MS}`;

export interface LeaseHeartbeatArgs {
  p_instance_id: string;
  p_claims: unknown[];
  p_stale_seconds: number;
}

export type LeaseHeartbeatRpcResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

/** The slice of pg.Client used here, so a test can hand in a fake. */
export interface LeaseHeartbeatSessionClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
}

type OpenSession = (
  connectionString: string,
  scope: LeaseHeartbeatScope
) => LeaseHeartbeatSessionClient;

function defaultOpenSession(
  connectionString: string,
  scope: LeaseHeartbeatScope
): LeaseHeartbeatSessionClient {
  return new pg.Client({
    connectionString,
    application_name: `club-arena-engine-lease-heartbeat-${scope}:${process.pid}`,
    keepAlive: true,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: enginePgSsl(),
  }) as unknown as LeaseHeartbeatSessionClient;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : String(err);
}

/** The login role cannot run the function: a configuration answer, not an outage. */
function isConfigurationRefusal(err: unknown): boolean {
  const code = errorCode(err);
  if (code === '42883') return true; // undefined_function
  return code === '42501' && /permission denied/i.test(errorMessage(err));
}

/**
 * A SQLSTATE outside the connection classes means Postgres answered and the
 * session is still usable (a statement timeout cancels one statement only).
 * No SQLSTATE means the socket failed or went silent: drop the session.
 */
function sessionSurvives(err: unknown): boolean {
  const code = errorCode(err);
  if (!code || !/^[0-9A-Z]{5}$/.test(code)) return false;
  return !code.startsWith('08') && !code.startsWith('57P');
}

type SessionState = 'idle' | 'connecting' | 'ready' | 'disabled';

class LeaseHeartbeatSession {
  private state: SessionState = 'idle';
  private client: LeaseHeartbeatSessionClient | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private disabledReason = '';

  connects = 0;
  disconnects = 0;
  dedicatedStatements = 0;
  sharedStatements = 0;

  constructor(
    readonly scope: LeaseHeartbeatScope,
    private readonly connectionString: string,
    private readonly openSession: OpenSession,
    private readonly random: () => number
  ) {
    if (!connectionString) {
      this.state = 'disabled';
      this.disabledReason = 'no session configured';
    }
  }

  get connected(): boolean {
    return this.state === 'ready';
  }

  get enabled(): boolean {
    return this.state !== 'disabled';
  }

  async call(args: LeaseHeartbeatArgs): Promise<LeaseHeartbeatRpcResult> {
    this.ensureConnecting();
    // A connect already in flight is bounded by CONNECT_TIMEOUT_MS. A session
    // waiting out its backoff is not waited for: the shared client serves.
    if (this.state === 'connecting' && this.connecting) await this.connecting;
    if (this.state !== 'ready') return this.shared(args);

    // One statement at a time on this scope's session. The caller's proof
    // deadline was read before this call, so waiting here only shortens it.
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const client = this.client;
      if (this.state !== 'ready' || !client) return await this.shared(args);
      return await this.dedicated(client, args);
    } finally {
      release();
    }
  }

  private async shared(args: LeaseHeartbeatArgs): Promise<LeaseHeartbeatRpcResult> {
    this.sharedStatements++;
    return (await supabase.rpc(HEARTBEAT_FUNCTION[this.scope], args)) as LeaseHeartbeatRpcResult;
  }

  private async dedicated(
    client: LeaseHeartbeatSessionClient,
    args: LeaseHeartbeatArgs
  ): Promise<LeaseHeartbeatRpcResult> {
    this.dedicatedStatements++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`lease heartbeat session was silent for ${LEASE_HEARTBEAT_LOCAL_BOUND_MS} ms`)
          ),
        LEASE_HEARTBEAT_LOCAL_BOUND_MS
      );
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        client.query(HEARTBEAT_SQL[this.scope], [
          args.p_instance_id,
          JSON.stringify(args.p_claims),
          args.p_stale_seconds,
        ]),
        silent,
      ]);
      return { data: Array.isArray(result?.rows) ? result.rows : null, error: null };
    } catch (err) {
      if (isConfigurationRefusal(err)) this.disable(client, err);
      else if (!sessionSurvives(err)) this.lost(client, err);
      // Whatever happened, this request is UNKNOWN to the caller and extends
      // nothing. It is not replayed on the shared client: the statement may
      // have run, and the next pass asks again.
      return { data: null, error: { message: errorMessage(err), code: errorCode(err) } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ensureConnecting(): void {
    if (this.state !== 'idle' || this.stopped || this.reconnectTimer) return;
    const client = this.openSession(this.connectionString, this.scope);
    this.client = client;
    this.state = 'connecting';
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, new Error('connection ended')));
    this.connecting = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const silent = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`lease heartbeat session did not open within ${CONNECT_BOUND_MS} ms`)
              ),
            CONNECT_BOUND_MS
          );
          timer.unref?.();
        });
        const privilege = await Promise.race([
          (async () => {
            await client.connect();
            await client.query(STATEMENT_TIMEOUT_SQL);
            return await client.query(EXECUTE_PRIVILEGE_SQL[this.scope]);
          })(),
          silent,
        ]);
        const row = privilege.rows[0] as { ok?: unknown } | undefined;
        if (row?.ok !== true) {
          this.disable(
            client,
            new Error(`login role lacks EXECUTE on ${HEARTBEAT_FUNCTION[this.scope]}`)
          );
          return;
        }
      } catch (err) {
        if (isConfigurationRefusal(err)) this.disable(client, err);
        else this.lost(client, err);
        return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.client !== client || this.state !== 'connecting') return;
      this.state = 'ready';
      this.attempt = 0;
      this.connects++;
      console.log(
        `[lease-session] ${this.scope} heartbeats renew on a dedicated session (connect #${this.connects})`
      );
    })().finally(() => {
      this.connecting = null;
    });
  }

  private detach(client: LeaseHeartbeatSessionClient): void {
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
  }

  private lost(client: LeaseHeartbeatSessionClient, err: unknown): void {
    if (this.client !== client) return;
    this.client = null;
    if (this.state === 'ready') this.disconnects++;
    this.state = 'idle';
    this.detach(client);
    if (this.stopped) return;
    const delay = reconnectDelayMs(this.attempt, this.random);
    this.attempt++;
    // The driver message only (ECONNRESET, timeout, auth failure); the
    // connection string is never part of it.
    console.warn(
      `[lease-session] ${this.scope} session lost (${errorMessage(err)}); ` +
        `the shared client serves until it reconnects in ${delay} ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnecting();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private disable(client: LeaseHeartbeatSessionClient, err: unknown): void {
    if (this.client === client) this.client = null;
    this.state = 'disabled';
    this.disabledReason = errorMessage(err);
    this.detach(client);
    console.error(
      `[lease-session] ${this.scope} dedicated session disabled (${this.disabledReason}); ` +
        'heartbeats use the shared client for the life of this process'
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (this.state !== 'disabled') this.state = 'idle';
    if (client) {
      client.removeAllListeners('error');
      client.removeAllListeners('end');
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }
}

type SessionOptions = {
  connectionString?: string;
  openSession?: OpenSession;
  random?: () => number;
};

let options: SessionOptions = {};
const sessions = new Map<LeaseHeartbeatScope, LeaseHeartbeatSession>();

function sessionFor(scope: LeaseHeartbeatScope): LeaseHeartbeatSession {
  let session = sessions.get(scope);
  if (!session) {
    session = new LeaseHeartbeatSession(
      scope,
      options.connectionString ?? enginePgConnectionString(),
      options.openSession ?? defaultOpenSession,
      options.random ?? Math.random
    );
    sessions.set(scope, session);
  }
  return session;
}

/**
 * Run one lease heartbeat statement for `scope`. Same arguments and the same
 * { data, error } result shape as supabase.rpc on the heartbeat function.
 */
export function leaseHeartbeatRpc(
  scope: LeaseHeartbeatScope,
  args: LeaseHeartbeatArgs
): Promise<LeaseHeartbeatRpcResult> {
  return sessionFor(scope).call(args);
}

/** Close both sessions. Called on shutdown after the leases are released. */
export async function stopLeaseHeartbeatSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => session.stop()));
}

export function leaseHeartbeatSessionsToPrometheus(): string[] {
  const scopes = (['tournament', 'table'] as const).map((scope) => sessionFor(scope));
  return [
    '# HELP poker_lease_heartbeat_session_enabled 1 when lease heartbeats may use a dedicated Postgres session.',
    '# TYPE poker_lease_heartbeat_session_enabled gauge',
    ...scopes.map(
      (s) => `poker_lease_heartbeat_session_enabled{scope="${s.scope}"} ${s.enabled ? 1 : 0}`
    ),
    '# HELP poker_lease_heartbeat_session_connected 1 while the dedicated lease heartbeat session is open.',
    '# TYPE poker_lease_heartbeat_session_connected gauge',
    ...scopes.map(
      (s) => `poker_lease_heartbeat_session_connected{scope="${s.scope}"} ${s.connected ? 1 : 0}`
    ),
    '# HELP poker_lease_heartbeat_statements_total Lease heartbeat statements by transport.',
    '# TYPE poker_lease_heartbeat_statements_total counter',
    ...scopes.flatMap((s) => [
      `poker_lease_heartbeat_statements_total{scope="${s.scope}",transport="dedicated"} ${s.dedicatedStatements}`,
      `poker_lease_heartbeat_statements_total{scope="${s.scope}",transport="shared"} ${s.sharedStatements}`,
    ]),
    '# HELP poker_lease_heartbeat_session_disconnects_total Dedicated lease heartbeat sessions lost.',
    '# TYPE poker_lease_heartbeat_session_disconnects_total counter',
    ...scopes.map(
      (s) => `poker_lease_heartbeat_session_disconnects_total{scope="${s.scope}"} ${s.disconnects}`
    ),
  ];
}

/** Tests only: replace the configuration and forget every session. */
export async function _resetLeaseHeartbeatSessionsForTests(
  next: SessionOptions = {}
): Promise<void> {
  await stopLeaseHeartbeatSessions();
  sessions.clear();
  options = next;
}
