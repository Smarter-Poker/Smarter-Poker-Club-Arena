/** Bounded observations of owned promises. No timers, cancellation or recovery. */
export interface SettlementAwaitObservation {
  stage: string;
  generation: number;
  handNumber: number;
  ageMs: number;
  detail: string | null;
}

export class SettlementAwait {
  private readonly active = new Map<
    symbol,
    {
      stage: string;
      generation: number;
      handNumber: number;
      started: number;
      detail: string | null;
    }
  >();

  observe<T>(
    stage: string,
    generation: number,
    handNumber: number,
    operation: (progress: (detail: string) => void) => Promise<T>
  ): Promise<T> {
    const token = Symbol();
    const entry = {
      stage: stage.slice(0, 64),
      generation,
      handNumber,
      started: performance.now(),
      detail: null as string | null,
    };
    // A diagnostic cannot create an unbounded queue during an incident.
    if (this.active.size < 8) this.active.set(token, entry);
    const progress = (detail: string) => {
      if (this.active.has(token)) entry.detail = detail.slice(0, 64);
    };
    let promise: Promise<T>;
    try {
      promise = operation(progress);
    } catch (error) {
      this.active.delete(token);
      throw error;
    }
    // Preserve the original promise and its rejection. Observation never
    // acknowledges the settlement, changes a fence or releases its barrier.
    void promise.then(() => this.active.delete(token)).catch(() => this.active.delete(token));
    return promise;
  }

  snapshot(): SettlementAwaitObservation[] {
    const now = performance.now();
    return [...this.active.values()].map(({ started, ...entry }) => ({
      ...entry,
      ageMs: Math.max(0, now - started),
    }));
  }
}
