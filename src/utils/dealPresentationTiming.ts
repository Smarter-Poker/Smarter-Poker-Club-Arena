/** Transient, opt-in certificate observations; never a setting or correctness input. */
export const DEAL_PRESENTATION_TIMING_EVENT = 'sp-deal-presentation-timing';
export type DealPresentationPhase =
  | 'scheduled'
  | 'timer-fired'
  | 'run-effect'
  | 'geometry-wait'
  | 'cards-ready'
  | 'frame-committed';
export interface DealPresentationTiming {
  handNumber: number;
  phase: DealPresentationPhase;
  at: number;
  speed?: number;
  buttonDelayMs?: number;
  activeSeatCount?: number;
  geometryCount?: number;
  cardCount?: number;
}
export function observeDealPresentationTiming(record: Omit<DealPresentationTiming, 'at'>): void {
  if (
    typeof window === 'undefined' ||
    !Number.isSafeInteger(record.handNumber) ||
    record.handNumber <= 0
  )
    return;
  const target = window as typeof window & { __spObserveDealPresentationTiming?: boolean };
  if (target.__spObserveDealPresentationTiming !== true) return;
  // Diagnostics must never throw into the table's animation/hold transition.
  try {
    target.dispatchEvent(
      new CustomEvent(DEAL_PRESENTATION_TIMING_EVENT, { detail: { ...record, at: Date.now() } })
    );
  } catch {
    /* observation has no authority over gameplay */
  }
}
