/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUS EVENT LOGGER — Batched Supabase logging for critical MasterBus events
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Subscribes to critical events and batch-writes them to `bus_event_log` table.
 * Flushes every 10 seconds or when batch reaches 20 events.
 */

import { supabase } from '../lib/supabase';
import { masterBus, type BusEventType } from '../core/MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { reportError } from '../utils/errorReporter';

interface LogEntry {
  event_type: string;
  payload: Record<string, unknown>;
  user_id: string | null;
  created_at: string;
}

const CRITICAL_EVENTS: BusEventType[] = [
  'BALANCE_UPDATED',
  'CLUB_JOINED',
  'CLUB_LEFT',
  'TABLE_SEATED',
  'TABLE_LEFT',
];

const BATCH_FLUSH_INTERVAL = 10_000; // 10 seconds
const MAX_BATCH_SIZE = 20;

class BusEventLoggerService {
  private batch: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribes: (() => void)[] = [];
  private started = false;

  /** Start listening to critical events and batching to Supabase */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Subscribe to each critical event
    for (const eventType of CRITICAL_EVENTS) {
      const unsub = masterBus.subscribe(eventType, (event) => {
        const userId = useUserStore.getState().user?.id || null;
        this.batch.push({
          event_type: event.type,
          payload:
            typeof event.payload === 'object'
              ? (event.payload as Record<string, unknown>)
              : { value: event.payload },
          user_id: userId,
          created_at: event.timestamp,
        });

        if (this.batch.length >= MAX_BATCH_SIZE) {
          this.flush();
        }
      });
      this.unsubscribes.push(unsub);
    }

    // Periodic flush
    this.flushTimer = setInterval(() => this.flush(), BATCH_FLUSH_INTERVAL);
  }

  /** Flush the current batch to Supabase */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const toFlush = [...this.batch];
    this.batch = [];

    try {
      const { error } = await supabase.from('bus_event_log').insert(toFlush);

      if (error) {
        reportError(error, 'BusEventLogger.flush');
        // Re-queue failed entries (up to limit)
        this.batch = [...toFlush.slice(-10), ...this.batch].slice(0, MAX_BATCH_SIZE);
      }
    } catch (e: unknown) {
      reportError(e, 'BusEventLogger.flush.catch');
    }
  }

  /** Stop the logger and clean up */
  stop(): void {
    this.unsubscribes.forEach((fn) => fn());
    this.unsubscribes = [];
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // Final flush
    this.started = false;
  }

  /** Get current batch size (for DevTools) */
  getBatchSize(): number {
    return this.batch.length;
  }
}

export const busEventLogger = new BusEventLoggerService();
