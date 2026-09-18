/** Phase/unknown ownership only: serialization reuses the existing seat mutex.
 * Canonical completion is synchronous and never acquires that mutex. */
export class FinancialPublicationBoundary {
  private phase: 'between_hands' | 'active_hand' | 'settling' = 'between_hands';
  private unresolved: unknown = null;
  private completion: Promise<void> | null = null;
  private completionSucceeded = false;
  constructor(
    private readonly ownerCurrent: () => boolean,
    private readonly withSeatBoundary: <T>(work: () => Promise<T> | T) => Promise<T>
  ) {}
  private assertOwner(): void {
    if (!this.ownerCurrent()) throw new Error('financial_publication_owner_changed');
  }
  ingress<T>(
    work: (context: {
      phase: 'between_hands' | 'active_hand';
      assertCurrent: () => void;
    }) => Promise<T>
  ): Promise<T> {
    return this.withSeatBoundary(async () => {
      this.assertOwner();
      if (this.unresolved || this.phase === 'settling')
        throw new Error('financial_delivery_unresolved');
      const phase = this.phase;
      const assertCurrent = () => {
        this.assertOwner();
        if (this.phase !== phase) throw new Error('financial_hand_boundary_changed');
      };
      try {
        const result = await work({ phase, assertCurrent });
        assertCurrent();
        return result;
      } catch (error) {
        this.unresolved = error || new Error('financial_delivery_unknown');
        throw error;
      }
    });
  }
  reconcile(work: (assertCurrent: () => void) => Promise<void>): Promise<void> {
    return this.withSeatBoundary(async () => {
      this.assertOwner();
      await work(() => this.assertOwner());
      this.assertOwner();
      this.unresolved = null;
    });
  }
  /** Caller already owns seatBoundary through preparation/start. */
  acquireControllerStart(authorize: () => void): {
    start: (actuate: () => void) => void;
    release: () => void;
  } {
    this.assertOwner();
    if (this.unresolved || this.phase !== 'between_hands')
      throw new Error('financial_start_unproven');
    const result = authorize() as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw new Error('financial_authorizer_must_be_synchronous');
    let released = false,
      started = false;
    return {
      release: () => {
        released = true;
      },
      start: (actuate) => {
        this.assertOwner();
        if (released || started || this.unresolved || this.phase !== 'between_hands')
          throw new Error('financial_start_unproven');
        started = true;
        this.phase = 'active_hand';
        this.completion = null;
        this.completionSucceeded = false;
        actuate();
      },
    };
  }
  start(authorize: () => void, actuate: () => void): Promise<void> {
    return this.withSeatBoundary(() => {
      const guard = this.acquireControllerStart(authorize);
      try {
        guard.start(actuate);
      } finally {
        guard.release();
      }
    });
  }
  /** Invoke canonical capture BEFORE listener teardown, including unknown ingress.
   * Repeated completion for this active hand returns the same exact promise. */
  handComplete(dispatchCanonicalSettlement: () => Promise<void>): Promise<void> {
    if (this.completion) return this.completion;
    try {
      this.assertOwner();
      if (this.phase !== 'active_hand') throw new Error('financial_completion_unproven');
    } catch (error) {
      return Promise.reject(error);
    }
    this.phase = 'settling';
    // Create retained identity before calling user code so synchronous reentry
    // cannot dispatch a second completion. Do not defer invocation to .then().
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    try {
      const canonical = dispatchCanonicalSettlement();
      Promise.resolve(canonical).then(() => {
        this.completionSucceeded = true;
        resolve();
      }, reject);
    } catch (error) {
      reject(error);
    }
    return this.completion;
  }
  obligationsComplete(authorizeAndPublish: () => void): Promise<void> {
    // Never await postHandTasks while holding seatBoundary: departures may do
    // so, but settlement itself must remain independent of that mutex.
    return this.withSeatBoundary(() => {
      this.assertOwner();
      if (this.unresolved || this.phase !== 'settling' || !this.completionSucceeded)
        throw new Error('financial_obligations_unproven');
      authorizeAndPublish();
      this.assertOwner();
      this.phase = 'between_hands';
    });
  }
}
