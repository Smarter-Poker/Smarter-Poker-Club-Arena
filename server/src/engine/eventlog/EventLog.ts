/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EVENT LOG — Append-Only Store + Durable Sink Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 * The write side of the event-sourced engine. `EventLog` is an in-memory,
 * append-only sequence of hand events. It optionally forwards appends to a
 * durable `EventSink` (Supabase, Kafka, a file — anything).
 *
 * Provided here:
 *  - `EventSink`            — the durability contract.
 *  - `InMemoryEventSink`    — trivial impl (tests / dev / shadow mode).
 *  - `EventLog`             — append-only log with per-hand indexing.
 *  - `SupabaseEventSink`    — STUB that batches inserts into `hand_events`.
 *                             The CREATE TABLE lives in
 *                             supabase/migrations/011_hand_events.sql (NOT applied).
 */

import type { HandEvent } from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Durable sink contract
// ─────────────────────────────────────────────────────────────────────────────

export interface EventSink {
  /** Persist a batch of events. MUST be append-only and idempotent per (handId, seq). */
  append(events: HandEvent[]): Promise<void>;
  /** Flush any buffered writes. Optional for sinks that write synchronously. */
  flush?(): Promise<void>;
  /** Release resources. Optional. */
  close?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory sink (default)
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryEventSink implements EventSink {
  readonly events: HandEvent[] = [];

  async append(events: HandEvent[]): Promise<void> {
    for (const e of events) this.events.push(e);
  }

  async flush(): Promise<void> {
    /* no-op: already durable-in-memory */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Append-only log
// ─────────────────────────────────────────────────────────────────────────────

export class EventLog {
  private readonly events: HandEvent[] = [];
  private readonly byHand: Map<string, HandEvent[]> = new Map();
  private readonly sink?: EventSink;

  constructor(sink?: EventSink) {
    this.sink = sink;
  }

  /**
   * Append one event. Enforces monotonic seq per hand (rejects out-of-order /
   * duplicate seq). Returns the event for chaining. Forwarding to the durable
   * sink is fire-and-forget so it can NEVER block or break the live path;
   * failures are swallowed (the caller owns ret/reporting policy).
   */
  append(event: HandEvent): HandEvent {
    const prior = this.byHand.get(event.handId);
    if (prior && prior.length > 0) {
      const lastSeq = prior[prior.length - 1].seq;
      if (event.seq <= lastSeq) {
        throw new Error(
          `EventLog: non-monotonic seq for hand ${event.handId}: got ${event.seq}, last was ${lastSeq}`
        );
      }
    } else {
      this.byHand.set(event.handId, []);
    }

    this.events.push(event);
    this.byHand.get(event.handId)!.push(event);

    if (this.sink) {
      void this.sink.append([event]).catch(() => {
        /* durability failures must not affect gameplay in shadow mode */
      });
    }
    return event;
  }

  /** Append many events atomically-ish (in order). */
  appendAll(events: HandEvent[]): void {
    for (const e of events) this.append(e);
  }

  /** All events, in append order. */
  all(): readonly HandEvent[] {
    return this.events;
  }

  /** All events for one hand, in seq order. */
  forHand(handId: string): readonly HandEvent[] {
    return this.byHand.get(handId) ?? [];
  }

  /** Distinct hand ids seen so far. */
  handIds(): string[] {
    return [...this.byHand.keys()];
  }

  /** Flush the durable sink, if any. */
  async flush(): Promise<void> {
    await this.sink?.flush?.();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase sink (STUB — batches inserts into `hand_events`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the supabase-js client we depend on — kept structural so
 * this module has ZERO import of @supabase/supabase-js (self-contained).
 */
export interface SupabaseLike {
  from(table: string): {
    insert(rows: unknown[]): Promise<{ error: { message: string } | null }>;
  };
}

/** One row in the `hand_events` table (see 011_hand_events.sql). */
export interface HandEventRow {
  hand_id: string;
  seq: number;
  event_type: string;
  schema_version: number;
  ts: number; // epoch ms
  payload: HandEvent; // full event as jsonb
}

export function toRow(event: HandEvent): HandEventRow {
  return {
    hand_id: event.handId,
    seq: event.seq,
    event_type: event.type,
    schema_version: event.v,
    ts: event.ts,
    payload: event,
  };
}

/**
 * STUB durable sink for Supabase. Buffers events and flushes them as batched
 * inserts into `hand_events`. It is written but NOT wired: the follow-up will
 * pass a real supabase client. The CREATE TABLE migration is authored under
 * supabase/migrations/011_hand_events.sql and is intentionally NOT applied.
 */
export class SupabaseEventSink implements EventSink {
  private buffer: HandEventRow[] = [];

  constructor(
    private readonly client: SupabaseLike,
    private readonly opts: { table?: string; batchSize?: number } = {}
  ) {}

  private get table(): string {
    return this.opts.table ?? 'hand_events';
  }

  private get batchSize(): number {
    return this.opts.batchSize ?? 100;
  }

  async append(events: HandEvent[]): Promise<void> {
    for (const e of events) this.buffer.push(toRow(e));
    while (this.buffer.length >= this.batchSize) {
      await this.writeBatch(this.buffer.splice(0, this.batchSize));
    }
  }

  async flush(): Promise<void> {
    while (this.buffer.length > 0) {
      await this.writeBatch(this.buffer.splice(0, this.batchSize));
    }
  }

  private async writeBatch(rows: HandEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.client.from(this.table).insert(rows);
    if (error) {
      // Re-buffer so a later flush can retry; surface for the caller's policy.
      this.buffer.unshift(...rows);
      throw new Error(`SupabaseEventSink: batch insert failed: ${error.message}`);
    }
  }
}
