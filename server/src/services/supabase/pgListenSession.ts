import pg from 'pg';
import { enginePgSsl } from './enginePgSession.js';
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

export function defaultOpenSession(
  connectionString: string,
  applicationName = `club-arena-engine-outbox-listener:${process.pid}`
): OutboxListenerClient {
  return new pg.Client({
    connectionString,
    application_name: applicationName,
    keepAlive: true,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: enginePgSsl(),
  });
}
