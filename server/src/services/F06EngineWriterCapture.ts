import { AsyncLocalStorage } from 'node:async_hooks';
/** Physical observations only. No durable disposition or retirement capability. */
export type EngineWriterLane =
  | 'allocator'
  | 'maintenance'
  | 'dispatch'
  | 'commit-and-final-stacks'
  | 'postcommit'
  | 'permit-finish'
  | 'private-card-write'
  | 'card-retry-continuation'
  | 'table-metadata'
  | 'seat-funding'
  | 'seat-departure'
  | 'user-continuation'
  | 'event-continuation'
  | 'turn-continuation'
  | 'snapshot-completion'
  | 'snapshot-save'
  | 'time-bank-consumption'
  | 'recovery-telemetry'
  | 'retirement-control'
  | 'retirement-disposition'
  | 'allocator-absence'
  | 'retirement-readback';
type Entry = {
  id: number;
  lane: EngineWriterLane;
  state: 'pending' | 'returned' | 'unknown';
  operationId?: string;
};
export type EngineWriterObservation = Readonly<{
  coverage: 'incomplete';
  state: 'pending' | 'unknown' | 'captured-writers-returned';
  fenced: boolean;
  returned: number;
  returnedHistory: 'summarized-transport-only';
  writers: readonly Readonly<Entry>[];
}>;
const currentWriter = new AsyncLocalStorage<F06EngineWriterCapture>();
const currentAttempt = new AsyncLocalStorage<number>();
/** Existing service calls outside an engine dispatch retain their original path. */
export function observeCurrentEngineWriter<T>(
  lane: EngineWriterLane,
  operationId: string,
  work: () => Promise<T>,
  unknown: (value: T) => boolean
): Promise<T> {
  const original = currentWriter.getStore();
  return original ? original.captureAccepted(lane, operationId, work, unknown) : work();
}
/** Origin only: Session must retain this exact object at its raw attempt
 * boundary. A clone, another tracker, or an outside call cannot supply it. */
export function captureCurrentEngineWriterOrigin(): Readonly<{ attempt: number }> | null {
  return currentWriter.getStore()?.captureAcceptedOrigin() ?? null;
}
export class F06EngineWriterCapture {
  #fenced = false;
  #closed = false;
  #sequence = 0;
  #returned = 0;
  #entries = new Map<number, Entry>();
  #pending = new Set<Promise<unknown>>();
  #observations = new WeakSet<object>();
  #origins = new WeakMap<object, number>();
  fence(): void {
    this.#fenced = true;
  }
  assertAdmissionOpen(): void {
    if (this.#fenced) throw new Error('f06_engine_writer_fenced');
  }
  run<T>(
    lane: EngineWriterLane,
    work: () => Promise<T>,
    unknown: (value: T) => boolean = () => false
  ): Promise<T> {
    if (this.#fenced) return Promise.reject(new Error('f06_engine_writer_fenced'));
    return this.captureAccepted(lane, undefined, work, unknown);
  }
  runDispatch<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    // Completion is accepted work: fencing new hands must not cancel its writes.
    let canonical: Promise<T> | undefined;
    const observation = currentWriter.run(this, () =>
      this.captureAccepted('dispatch', operationId, () => {
        canonical = work();
        return canonical;
      })
    );
    // The canonical owner retains error delivery and promise identity. This
    // parallel observer records uncertainty; it must not create an unhandled
    // rejection or replace the once-only completion promise returned to callers.
    void observation.catch(() => undefined);
    return canonical ?? observation;
  }
  captureAccepted<T>(
    lane: EngineWriterLane,
    operationId: string | undefined,
    work: () => Promise<T>,
    unknown: (value: T) => boolean = () => false
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('f06_engine_writer_closed'));
    const entry: Entry = {
      id: ++this.#sequence,
      lane,
      state: 'pending',
      operationId,
    };
    this.#entries.set(entry.id, entry);
    // Register before invoking work: synchronous callbacks may inspect/fence.
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const raw = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#pending.add(raw);
    const tracked = raw
      .then(
        (value) => {
          try {
            if (unknown(value)) entry.state = 'unknown';
            else {
              // Bounded physical-return summary, never a canonical-success journal.
              // Pending and unknown attempts retain their exact original identities.
              this.#returned++;
              this.#entries.delete(entry.id);
            }
          } catch (error) {
            entry.state = 'unknown';
            throw error;
          }
          return value;
        },
        (error) => {
          entry.state = 'unknown';
          throw error;
        }
      )
      .finally(() => {
        this.#pending.delete(raw);
      });
    try {
      resolve(currentWriter.run(this, () => currentAttempt.run(entry.id, work)));
    } catch (error) {
      reject(error);
    }
    return tracked;
  }
  /** Close future covered launches only after accepted children reach a fixed
   * point. The external custody owner calls this after the existing stop
   * barriers; the registry itself still makes no full-coverage claim. */
  async closeCoveredWriters(assertCurrent: () => void): Promise<EngineWriterObservation> {
    this.assertExternalJoin();
    this.fence();
    for (;;) {
      await this.join(assertCurrent);
      assertCurrent();
      // A callback can register between join's return and this continuation.
      // Test and close in the same synchronous turn, without another await.
      if (this.#pending.size) continue;
      this.#closed = true;
      return this.observe();
    }
  }
  observe(): EngineWriterObservation {
    const writers = Object.freeze(
      [...this.#entries.values()].map((row) => Object.freeze({ ...row }))
    );
    const result: EngineWriterObservation = Object.freeze({
      coverage: 'incomplete',
      state: writers.some((row) => row.state === 'pending')
        ? 'pending'
        : writers.some((row) => row.state === 'unknown')
          ? 'unknown'
          : 'captured-writers-returned',
      fenced: this.#fenced,
      returned: this.#returned,
      returnedHistory: 'summarized-transport-only',
      writers,
    });
    this.#observations.add(result);
    return result;
  }
  ownsObservation(value: unknown): value is EngineWriterObservation {
    return typeof value === 'object' && value !== null && this.#observations.has(value);
  }
  captureAcceptedOrigin(): Readonly<{ attempt: number }> | null {
    const attempt = this.currentAcceptedAttempt();
    if (attempt === null || !this.isAcceptedContext()) return null;
    const origin = Object.freeze({ attempt });
    this.#origins.set(origin, attempt);
    return origin;
  }
  ownsAcceptedOrigin(value: unknown, attempt: number): boolean {
    return !!value && typeof value === 'object' && this.#origins.get(value) === attempt;
  }
  currentAcceptedAttempt(): number | null {
    return currentWriter.getStore() === this ? (currentAttempt.getStore() ?? null) : null;
  }
  isAcceptedContext(): boolean {
    const attempt = this.currentAcceptedAttempt();
    return attempt !== null && this.#entries.get(attempt)?.state === 'pending';
  }
  assertExternalJoin(): void {
    if (currentWriter.getStore() === this) throw new Error('f06_engine_writer_ancestor_join');
  }
  async join(assertCurrent: () => void): Promise<EngineWriterObservation> {
    // An accepted writer cannot await the registry that contains itself.
    // The retained external custody owner performs the fixed-point join.
    this.assertExternalJoin();
    assertCurrent();
    if (!this.#fenced) throw new Error('f06_engine_writer_fence_required');
    while (this.#pending.size) {
      await Promise.allSettled([...this.#pending]);
      assertCurrent();
    }
    assertCurrent();
    return this.observe();
  }
}
