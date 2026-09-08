/**
 * Durable-for-the-manager continuation across bounded scheduler admissions.
 *
 * The cursor advances only after a stage's successful response has been
 * applied. Crossing the wall-clock budget then yields before the next stage;
 * it never throws away the successful response and restarts at stage zero.
 */
export class TournamentSweepWorkCursor {
  private next = 0;

  get nextStage(): number {
    return this.next;
  }

  advanceTo(nextStage: number): void {
    if (!Number.isSafeInteger(nextStage) || nextStage < this.next) return;
    this.next = nextStage;
  }

  reset(): void {
    this.next = 0;
  }
}
