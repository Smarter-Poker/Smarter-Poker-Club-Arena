/**
 * The one configuration for the engine's raw Postgres sessions.
 *
 * Two services hold a session of their own instead of going through the
 * shared PostgREST client:
 *
 *   - ./handOutboxListener.ts, for LISTEN hand_projection_outbox (2026-09-10);
 *   - ../leaseHeartbeatSession.ts, for the table and tournament lease
 *     heartbeats (2026-09-24), which must not queue behind game traffic for a
 *     PostgREST pool connection.
 *
 * Both read the same connection string and the same TLS settings, so there is
 * one credential to place and one place that says how it is used. The value
 * must be the Supavisor SESSION-mode string (port 5432 on the pooler host) or
 * a direct connection, never the transaction pooler on 6543. Unset disables
 * both services and each keeps its documented fallback. The connection string
 * is never logged.
 */

import { readFileSync } from 'node:fs';
import type pg from 'pg';

export const ENGINE_PG_URL_ENV = 'ENGINE_PG_LISTEN_URL';
export const ENGINE_PG_CA_FILE_ENV = 'ENGINE_PG_LISTEN_CA_FILE';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

/** The configured session connection string, or '' when none is set. */
export function enginePgConnectionString(): string {
  return process.env[ENGINE_PG_URL_ENV] ?? '';
}

/** Verified TLS, with an optional pinned CA bundle. */
export function enginePgSsl(): pg.ClientConfig['ssl'] {
  const caFile = process.env[ENGINE_PG_CA_FILE_ENV];
  if (caFile) return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

/** Exponential backoff, base 500 ms, capped at 30 s, jittered by +/-25%. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
  return Math.round(delay * (0.75 + random() * 0.5));
}
