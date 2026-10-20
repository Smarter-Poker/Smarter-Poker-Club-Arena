/** A separate, bounded socket lane for the ORIGINAL Lightning fold transaction.
 * The fixed private wrapper runs the ordinary data actor/manager pre-request guard
 * in the same transaction. Raw sockets do not create an authorization exception.
 */
import pg from 'pg';
import { supabase } from './supabase/client.js';
import { resolveClientTimeoutMs } from './cashAccountingBatchBudget.js';
import { enginePgSsl } from './supabase/enginePgSession.js';
import { currentTournamentDataAuthority, dataActorHeaders } from './supabase/dataActorContext.js';
import {
  isTournamentManagerFencedError,
  notifyTournamentManagerFenced,
} from './supabase/tournamentManagerFence.js';

export const LIGHTNING_FOLD_POOL_MAX = 4;
export const LIGHTNING_FOLD_ACQUIRE_MS = 100;
export const LIGHTNING_FOLD_SQL =
  'SELECT smarter_private.fn_engine_lightning_fast_fold($1::uuid,$2::uuid,$3::uuid,$4::text,$5::numeric,$6::jsonb) AS result';
const DB_TIMEOUT_MS = resolveClientTimeoutMs();

export interface LightningFoldArgs {
  p_hand_id: string;
  p_player_id: string;
  p_request_id: string;
  p_fold_type: 'fast' | 'normal' | 'fold_watch';
  p_committed: number;
}
export type LightningFoldSessionResult = {
  data: unknown;
  error: null | { message: 'lightning_fold_outcome_unknown'; code: 'LIGHTNING_FOLD_UNKNOWN' };
};
export interface LightningFoldClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean): void;
}
export interface LightningFoldPool {
  connect(): Promise<LightningFoldClient>;
  end(): Promise<void>;
  on(event: 'error', callback: () => void): unknown;
}

function verifiedConnectionString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      (url.port && url.port !== '5432') ||
      decodeURIComponent(url.username).split('.')[0] !== 'engine_lightning_fold' ||
      !url.password ||
      !url.hostname
    )
      return null;
    // pg merges ALL query fields over its explicit configuration, including user,
    // port, options and TLS. Only the validated canonical authority/path is used.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Dependency boundary is private to this fixed operation, never a generic SQL interface. */
export function createLightningFoldSession(deps: {
  readUrl: () => Promise<unknown>;
  openPool: (connectionString: string) => LightningFoldPool;
  log?: (line: string) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? DB_TIMEOUT_MS;
  const BEGIN_SQL = `BEGIN; SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = '${timeoutMs}ms'; SET LOCAL idle_in_transaction_session_timeout = '${timeoutMs}ms'`;
  let pool: LightningFoldPool | null = null;
  let starting: Promise<boolean> | null = null;
  let stopped = false;
  let ready = false;
  let active = 0;
  let committed = 0;
  let unknown = 0;
  let admissionRefused = 0;
  const log = deps.log ?? ((line: string) => console.log(line));
  const safeLog = (message: string) => {
    try {
      log(message);
    } catch {
      /* diagnostic only */
    }
  };

  function start(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let candidate: LightningFoldPool | null = null;
      const warmed: LightningFoldClient[] = [];
      const prepare = (async () => {
        const connectionString = verifiedConnectionString(await deps.readUrl());
        if (!connectionString || stopped || closed) return false;
        candidate = deps.openPool(connectionString);
        pool = candidate;
        candidate.on('error', () =>
          safeLog(
            '[LightningFoldSession] idle socket lost; next original request reacquires a socket'
          )
        );
        for (let index = 0; index < LIGHTNING_FOLD_POOL_MAX; index++) {
          const client = await candidate.connect();
          if (closed || stopped) {
            client.release(true);
            return false;
          }
          warmed.push(client);
          const result = await client.query(
            "SELECT current_user='engine_lightning_fold' AND has_function_privilege('smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)','EXECUTE') AS ok"
          );
          if (result.rows[0]?.ok !== true || stopped || closed) return false;
        }
        return true;
      })();
      try {
        const boundary = new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            closed = true;
            resolve(false);
          }, 5_000);
          timer.unref?.();
        });
        ready = await Promise.race([prepare, boundary]);
        safeLog(
          ready
            ? '[LightningFoldSession] ready: dedicated verified-TLS pool, four sockets, synchronous commit'
            : '[LightningFoldSession] unavailable before dispatch; original HTTP fold route retained'
        );
        return ready;
      } catch {
        safeLog(
          '[LightningFoldSession] unavailable before dispatch; original HTTP fold route retained'
        );
        return false;
      } finally {
        closed = true;
        if (timer) clearTimeout(timer);
        for (const client of warmed) client.release(!ready);
        if (!ready && candidate) {
          const failed = candidate as LightningFoldPool;
          if (pool === failed) pool = null;
          // No shutdown wait on a connection that is still completing acquisition.
          void failed.end().catch(() => {});
        }
        starting = null;
      }
    })();
    return starting;
  }

  /** null means NO wrapper was dispatched: only that result permits the original HTTP route. */
  async function call(args: LightningFoldArgs): Promise<LightningFoldSessionResult | null> {
    const authority = currentTournamentDataAuthority();
    const actorHeaders = Object.fromEntries(dataActorHeaders().entries());
    const selected = pool;
    if (!ready || stopped || !selected || active >= LIGHTNING_FOLD_POOL_MAX) {
      admissionRefused++;
      return null;
    }
    active++;
    let client: LightningFoldClient | null = null;
    let admitted = false;
    let dispatched = false;
    let expired = false;
    let destroy = false;
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const acquisition = selected.connect();
      // An acquisition that finishes AFTER admission closed is released, never used by the fallback.
      const owned = acquisition.then((connection) => {
        if (!admitted) {
          connection.release();
          return null;
        }
        return connection;
      });
      admitted = true;
      const acquisitionBound = new Promise<null>((resolve) => {
        acquireTimer = setTimeout(() => {
          admitted = false;
          resolve(null);
        }, LIGHTNING_FOLD_ACQUIRE_MS);
        acquireTimer.unref?.();
      });
      client = await Promise.race([owned, acquisitionBound]);
      if (acquireTimer) clearTimeout(acquireTimer);
      if (!client || stopped) {
        admissionRefused++;
        return null;
      }
      const connection = client;
      const transaction = (async () => {
        await connection.query(BEGIN_SQL);
        if (expired || stopped) throw new Error('fold_admission_closed');
        dispatched = true;
        const result = await connection.query(LIGHTNING_FOLD_SQL, [
          args.p_hand_id,
          args.p_player_id,
          args.p_request_id,
          args.p_fold_type,
          args.p_committed,
          JSON.stringify(actorHeaders),
        ]);
        // The original money/reservation result cannot become an acknowledgement before durable COMMIT.
        if (expired) throw new Error('fold_request_boundary');
        await connection.query('COMMIT');
        if (!expired) committed++;
        return { data: result.rows[0]?.result ?? null, error: null };
      })();
      const boundary = new Promise<never>((_, reject) => {
        requestTimer = setTimeout(() => {
          expired = true;
          destroy = true;
          reject(new Error('fold_request_boundary'));
        }, timeoutMs);
        requestTimer.unref?.();
      });
      return await Promise.race([transaction, boundary]);
    } catch (error) {
      destroy = true;
      if (isTournamentManagerFencedError(error)) notifyTournamentManagerFenced(authority);
      if (!dispatched) {
        admissionRefused++;
        return null;
      }
      unknown++;
      safeLog('[LightningFoldSession] original fold outcome unknown; no HTTP fallback or replay');
      return {
        data: null,
        error: { message: 'lightning_fold_outcome_unknown', code: 'LIGHTNING_FOLD_UNKNOWN' },
      };
    } finally {
      admitted = false;
      if (acquireTimer) clearTimeout(acquireTimer);
      if (requestTimer) clearTimeout(requestTimer);
      client?.release(destroy);
      active--;
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    ready = false;
    if (starting) await starting;
    const closing = pool;
    pool = null;
    if (closing) await closing.end();
  }
  function toPrometheus(): string[] {
    return [
      '# TYPE poker_lightning_fold_session_ready gauge',
      `poker_lightning_fold_session_ready ${ready && !stopped ? 1 : 0}`,
      '# TYPE poker_lightning_fold_session_active gauge',
      `poker_lightning_fold_session_active ${active}`,
      '# TYPE poker_lightning_fold_session_committed_total counter',
      `poker_lightning_fold_session_committed_total ${committed}`,
      '# TYPE poker_lightning_fold_session_unknown_total counter',
      `poker_lightning_fold_session_unknown_total ${unknown}`,
      '# TYPE poker_lightning_fold_session_admission_refused_total counter',
      `poker_lightning_fold_session_admission_refused_total ${admissionRefused}`,
    ];
  }
  return { start, call, stop, toPrometheus };
}

const session = createLightningFoldSession({
  readUrl: async () => {
    const { data, error } = await supabase.rpc('fn_engine_lightning_fold_session_url');
    if (error) throw new Error('lightning_fold_session_credential_unavailable');
    return data;
  },
  openPool: (connectionString) =>
    new pg.Pool({
      connectionString,
      max: LIGHTNING_FOLD_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 0,
      keepAlive: true,
      ssl: enginePgSsl(),
      query_timeout: DB_TIMEOUT_MS,
      statement_timeout: DB_TIMEOUT_MS,
      application_name: `club-arena-engine-lightning-fold:${process.pid}`,
    }) as unknown as LightningFoldPool,
});
export const startLightningFoldSession = session.start;
export const lightningFoldSessionCall = session.call;
export const stopLightningFoldSession = session.stop;
export const lightningFoldSessionToPrometheus = session.toPrometheus;
