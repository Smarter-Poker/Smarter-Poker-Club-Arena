/**
 * Durable-for-the-manager continuation across bounded scheduler admissions.
 *
 * The cursor advances only after a stage's successful response has been
 * applied. Crossing the wall-clock budget then yields before the next stage;
 * it never throws away the successful response and restarts at stage zero.
 *
 * A LATER STAGE DOES NOT HOLD AN EARLIER STAGE'S NEW WORK HOSTAGE (2026-09-29).
 *
 * Continuation alone let the balance stage (5) keep the cursor for as long as
 * each of its admissions spent the whole work budget, which is exactly what a
 * contended table break does: park probe, roster read, destination read and a
 * refused begin. A bust that happened meanwhile waited for the bust stage (1),
 * and the break it was waiting on was refused BECAUSE of that bust: the busted
 * player still read `playing` at the source, so `fn_f06_begin_break` counted
 * one more registration than the engine proposed live seats and raised
 * `F06_WHOLE_ROSTER_REQUIRED`. Production 2026-09-29 07:04-07:17 UTC: $100
 * Freeroll c65c414d, $100 Freeroll cb8f2dd1 and Morning Free Buy 6a18ddaa
 * held 6, 7 and 1 zero-chip `playing` players whose seats had left, none of
 * them recorded for more than ten minutes, while their breaks refused.
 *
 * So an earlier stage may ask for its turn back (`rewindTo`). The request is
 * applied at the next admission, and never twice in a row: after one rewind,
 * the stage it interrupted must be reached again (advanced past, or admitted
 * with a fresh budget) before another rewind is applied. Neither stage can
 * then starve the other, which is the property drift incident 7ab0dcbe proved
 * the hard way from the other direction (a bust backlog that kept the cursor
 * at stage 1 and never let the balancer run).
 */
export class TournamentSweepWorkCursor {
  private next = 0;
  /** The earliest stage asking for its turn back, applied at admission. */
  private rewindRequested: number | null = null;
  /** The stage the last applied rewind interrupted, until it is reached again. */
  private interrupted: number | null = null;

  get nextStage(): number {
    return this.next;
  }

  /** The stage an applied rewind is still waiting to give its turn back to. */
  get interruptedStage(): number | null {
    return this.interrupted;
  }

  advanceTo(nextStage: number): void {
    if (!Number.isSafeInteger(nextStage) || nextStage < this.next) return;
    this.next = nextStage;
    if (this.interrupted !== null && this.next > this.interrupted) this.interrupted = null;
  }

  /**
   * An earlier stage has new work that a later stage is waiting on. Recorded
   * now and applied by `beginAdmission`, so a stage already running is never cut.
   */
  rewindTo(stage: number): void {
    if (!Number.isSafeInteger(stage) || stage < 0) return;
    this.rewindRequested =
      this.rewindRequested === null ? stage : Math.min(this.rewindRequested, stage);
  }

  /** Called once as each scheduler admission starts, before any stage runs. */
  beginAdmission(): void {
    if (this.interrupted !== null) {
      // The interrupted stage gets this whole admission before any further
      // rewind; a request stays recorded for the admission after it.
      if (this.next >= this.interrupted) this.interrupted = null;
      return;
    }
    const target = this.rewindRequested;
    if (target === null) return;
    this.rewindRequested = null;
    if (target >= this.next) return;
    this.interrupted = this.next;
    this.next = target;
  }

  reset(): void {
    this.next = 0;
    this.rewindRequested = null;
    this.interrupted = null;
  }
}
