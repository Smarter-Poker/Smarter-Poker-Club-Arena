import type { OutboxListenerClient } from './pgListenSession.js';
import { reconnectDelayMs } from './enginePgSession.js';
import { PRIVATE_RECORD_TOPIC } from '../../transport/PrivateRecordSubscriptions.js';

export const PRIVATE_RECORD_CHANNEL = 'ca_private_record_changes';
/** Dedicated LISTEN transport. No row reads, writes, heartbeat sharing or data polling. */
export class PrivateRecordListener {
  private client: OutboxListenerClient | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempt = 0;
  private probing = false;
  private cancelProbe: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  ready = false;
  phase: 'connecting' | 'unavailable' = 'connecting';
  constructor(
    private changed: (topic: string) => void,
    private readiness: (ready: boolean, phase: 'connecting' | 'unavailable') => void,
    private resolve: () => Promise<string>,
    private open: (connection: string) => OutboxListenerClient,
    private sourceReady: (client: OutboxListenerClient) => Promise<boolean>
  ) {}
  start(): void {
    if (this.stopped) {
      this.stopped = false;
      void this.connect();
    }
  }
  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    try {
      const connection = await this.resolve();
      if (this.stopped) return;
      if (!connection) throw new Error('listen credential unavailable');
      const client = this.open(connection);
      this.client = client;
      client.on('error', () => this.lost(client));
      client.on('end', () => this.lost(client));
      client.on('notification', (message) => {
        if (this.client !== client || !this.ready || message.channel !== PRIVATE_RECORD_CHANNEL)
          return;
        try {
          const signal = JSON.parse(message.payload ?? '');
          if (
            signal.event === 'record_changed' &&
            typeof signal.topic === 'string' &&
            PRIVATE_RECORD_TOPIC.test(signal.topic)
          )
            this.changed(signal.topic);
        } catch {
          /* Malformed transport signals have no authority. */
        }
      });
      await client.connect();
      await client.query(`LISTEN ${PRIVATE_RECORD_CHANNEL}`);
      if (!(await this.sourceReady(client))) throw new Error('private record source is not ready');
      if (this.stopped || this.client !== client) {
        await client.end().catch(() => undefined);
        return;
      }
      this.attempt = 0;
      this.ready = true;
      this.phase = 'connecting';
      this.readiness(true, 'connecting'); // Existing readers refresh once after every reconnect.
    } catch {
      if (this.client) this.lost(this.client);
      else {
        this.phase = 'unavailable';
        this.readiness(false, this.phase);
        this.schedule();
      }
    }
  }
  /** Existing channel heartbeat owns this liveness probe, never a row/data poll. */
  probe(): void {
    const client = this.client;
    if (!client || !this.ready || this.probing) return;
    this.probing = true;
    const deadline = new Promise<never>((_resolve, reject) => {
      this.cancelProbe = () => reject(new Error('listen heartbeat stopped'));
      this.probeTimer = setTimeout(() => reject(new Error('listen heartbeat timeout')), 8_000);
      this.probeTimer.unref?.();
    });
    void Promise.race([client.query('SELECT 1'), deadline])
      .catch(() => this.lost(client))
      .finally(() => {
        if (this.probeTimer) clearTimeout(this.probeTimer);
        this.probeTimer = null;
        this.probing = false;
        this.cancelProbe = null;
      });
  }
  private lost(client: OutboxListenerClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.ready = false;
    this.phase = 'unavailable';
    this.readiness(false, this.phase);
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, reconnectDelayMs(this.attempt++));
    this.retry.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelProbe?.();
    this.cancelProbe = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ready = false;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }
}
