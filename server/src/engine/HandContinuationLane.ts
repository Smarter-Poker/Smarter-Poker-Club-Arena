import type { HandEvent } from '../types.js';
import type { TimeBankEvent } from './TimeBankEngine.js';
export type ContinuationEvent =
  | HandEvent
  | { type: 'CONTINUATION_TIME_BANK'; event: TimeBankEvent };
export interface ContinuationEventIdentity {
  sequence: number;
  index: number;
}

/** One controller's original event batch, retained before any consumer sees it. */
export interface HandContinuationBatch {
  version: 1;
  sequence: number;
  controller: string;
  events: ContinuationEvent[];
  engine: Record<string, unknown>;
}

/**
 * The synchronous controller emits several events per mutation. Capture its
 * stable end state at the end of that JavaScript turn, persist one immutable
 * batch, then dispatch those exact events through the existing handlers.
 * A failed or unknown write holds this original batch; it never becomes a new
 * hand or a successful acknowledgement. There is no timer or repair worker.
 */
export class HandContinuationLane {
  private pending: ContinuationEvent[] = [];
  private scheduled = false;
  private tail: Promise<void> = Promise.resolve();
  private sequence: number;
  private failure: unknown;
  private failed = false;
  private closed = false;
  private unretainedBatches = 0;
  private controlDirty = false;
  private retainedSequence: number;
  private replayingOriginal = false;

  isReplayingOriginal(): boolean {
    return this.replayingOriginal;
  }
  private retentionWaiters: Array<{
    sequence: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  isUnretained(): boolean {
    return (
      this.failed ||
      this.scheduled ||
      this.controlDirty ||
      this.pending.length > 0 ||
      this.unretainedBatches > 0
    );
  }

  /** A bank/presence decision can change without a controller event. */
  checkpoint(): void {
    if (this.closed || this.failed || !this.current())
      throw new Error('Hand Continuation Is Fenced');
    this.controlDirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.captureBatch());
  }

  constructor(
    sequence: number,
    private readonly captureController: () => string,
    private readonly captureEngine: () => Record<string, unknown>,
    private readonly persist: (batch: Readonly<HandContinuationBatch>) => Promise<void>,
    private readonly dispatch: (
      event: ContinuationEvent,
      identity: ContinuationEventIdentity
    ) => Promise<void>,
    private readonly current: () => boolean,
    private readonly reportFailure: (error: unknown) => void,
    initialReplay?: () => Promise<void>
  ) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid Hand Sequence');
    this.sequence = sequence;
    this.retainedSequence = sequence;
    if (initialReplay) {
      this.replayingOriginal = true;
      // The saved batch already owns its sequence and bytes. Only replay its
      // consumers; later captured batches queue behind this original tail.
      this.tail = Promise.resolve()
        .then(async () => {
          if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
          await initialReplay();
          if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
          this.replayingOriginal = false;
        })
        .catch((error) => this.fail(error));
    }
  }

  enqueue(event: ContinuationEvent): void {
    if (this.closed || this.failed || !this.current())
      throw new Error('Hand Continuation Is Fenced');
    this.pending.push(structuredClone(event));
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.captureBatch());
  }

  private captureBatch(): void {
    this.scheduled = false;
    if (this.pending.length === 0 && !this.controlDirty) return;
    try {
      if (this.failed || this.closed || !this.current())
        throw new Error('Hand Continuation Is Fenced');
      const controller = this.captureController();
      const control = structuredClone(this.captureEngine());
      const events = this.pending;
      this.pending = [];
      this.controlDirty = false;
      const sequence = ++this.sequence;
      if (!Number.isSafeInteger(sequence)) throw new Error('Hand Sequence Is Exhausted');
      this.unretainedBatches++;
      this.tail = this.tail
        .then(async () => {
          if (this.failed || this.closed || !this.current())
            throw new Error('Hand Continuation Is Fenced');
          // Engine metadata follows the PREVIOUS fully dispatched batch. The
          // stored events reconstruct only this batch after a process loss.
          const batch: HandContinuationBatch = {
            version: 1,
            sequence,
            controller,
            events,
            engine: {
              ...control,
              fields: structuredClone(this.captureEngine().fields),
              timeBankMeta: structuredClone(this.captureEngine().timeBankMeta),
              timeBankDebits: structuredClone(this.captureEngine().timeBankDebits),
            },
          };
          await this.persist(batch);
          if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
          this.unretainedBatches--;
          this.retainedSequence = sequence;
          const ready = this.retentionWaiters.filter((w) => w.sequence <= sequence);
          this.retentionWaiters = this.retentionWaiters.filter((w) => w.sequence > sequence);
          for (const waiter of ready) waiter.resolve();
          for (const [index, event] of batch.events.entries()) {
            if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
            await this.dispatch(structuredClone(event), { sequence, index });
          }
        })
        .catch((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
    for (const waiter of this.retentionWaiters.splice(0)) waiter.reject(error);
    try {
      this.reportFailure(error);
    } catch {
      // Reporting cannot replace the original persistence failure or create
      // an unhandled rejection. The owner still receives it from join().
    }
  }

  async join(): Promise<void> {
    // Admit a controller batch still queued by this same synchronous action.
    if (this.scheduled) this.captureBatch();
    for (;;) {
      const tail = this.tail;
      await tail;
      if (this.scheduled) this.captureBatch();
      if (tail === this.tail) break;
    }
    if (this.failed) throw this.failure;
    if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
  }

  /** Network acknowledgement waits for bytes, not the next actor's animation beat. */
  async awaitRetention(): Promise<void> {
    if (this.scheduled) this.captureBatch();
    if (this.failed) throw this.failure;
    if (this.closed || !this.current()) throw new Error('Hand Continuation Is Fenced');
    const sequence = this.sequence;
    if (this.retainedSequence >= sequence) return;
    await new Promise<void>((resolve, reject) =>
      this.retentionWaiters.push({ sequence, resolve, reject })
    );
  }

  close(): void {
    this.closed = true;
  }
}
