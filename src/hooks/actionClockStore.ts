import { useCallback, useSyncExternalStore } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ActionClockStore — the countdown, kept OUT of the page container
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ─── WHY (2026-08-25, the last architectural defect on TablePage) ─────────────
 *
 * `useTableTimer` used to hold the countdown in React state, and that hook is
 * called by TablePage. So every publication re-rendered a fifteen-thousand-line
 * component and, through it, up to nine SeatSlots, the community board, the pot,
 * the HUD and the action panel — for the whole of ANY player's turn, on a phone,
 * with up to four tables open at once.
 *
 * The 2026-08-25 pass before this one already dropped the publication rate from
 * ~30Hz to 1Hz (whole seconds only). Measured on that code, a 20 second turn
 * rendered the page TWENTY times. This pass takes it to ZERO: the number never
 * enters TablePage's state at all.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────
 *
 * A minimal external store. `useTableTimer` owns one instance per table and
 * writes to it from the same evaluation loop as before. Whoever actually needs
 * the number subscribes to it directly with `useSyncExternalStore`, and only
 * that leaf re-renders:
 *
 *   - the acting seat's colour thresholds and its disconnect countdown (SeatSlot
 *     subscribes itself, and only while it is the seat on the clock);
 *   - the control-strip numeral (a leaf that renders one <span>);
 *   - the timer-warning sound and haptic window (a leaf that renders nothing).
 *
 * Nothing else on the page can see the clock move, because there is nothing else
 * to see: the value is not on TablePage's render path any more.
 *
 * ─── WHY AN EXTERNAL STORE AND NOT CSS CUSTOM PROPERTIES ─────────────────────
 *
 * The smooth part of the countdown ALREADY is pure CSS: SeatSlot's ring is an
 * `@property` animation seeded from the engine's absolute deadline
 * (`--sp-timer-duration` / `--sp-timer-delay`), so no React render has driven a
 * pixel of the ring for months. What is left is not smooth motion — it is four
 * pieces of LOGIC that need the value in JavaScript:
 *
 *   1. the 20% / 33% seat colour thresholds and the "tense" tell;
 *   2. the whole-second numeral in the control strip;
 *   3. the final-three-seconds warning window (sound + haptic), which is the
 *      moment the time bank is about to engage;
 *   4. a disconnected player's remaining seconds.
 *
 * A CSS variable written to a ref can express none of those without either
 * `@container style()` queries (not shipped widely enough to bet a shot clock
 * on) or a second, parallel source of truth for the same number. So: a store,
 * with the leaves subscribing.
 *
 * ─── PER TABLE, ALWAYS ───────────────────────────────────────────────────────
 *
 * The instance is created by `useTableTimer` and handed down as an explicit
 * prop. Four concurrent tables in MultiTablePage are four hooks, four stores and
 * four independent sets of subscribers; a table switch unmounts subscribers and
 * leaves the store alone. There is deliberately no React context and no module
 * singleton — a singleton is exactly how the four tables would start writing
 * over each other.
 */

export interface ActionClockSnapshot {
  /** WHOLE seconds remaining, rounded up. 0 at expiry. */
  readonly seconds: number;
  /** 0-100, computed from the PRECISE remainder at the instant of publication. */
  readonly progress: number;
  /** Hero is on the clock and inside the urgency threshold. */
  readonly isUrgent: boolean;
}

export class ActionClockStore {
  private snapshot: ActionClockSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(seconds = 0, progress = 0) {
    this.snapshot = { seconds, progress, isUrgent: false };
  }

  /** Stable identity: `useSyncExternalStore` re-subscribes if this changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ActionClockSnapshot => this.snapshot;

  /**
   * Publish a new reading. Identical readings are dropped, so a subscriber
   * cannot be woken by an evaluation that changed nothing — which is what makes
   * the 50ms evaluation loop cost one render a second rather than twenty.
   */
  publish(next: ActionClockSnapshot): void {
    const prev = this.snapshot;
    if (
      prev.seconds === next.seconds &&
      prev.progress === next.progress &&
      prev.isUrgent === next.isUrgent
    ) {
      return;
    }
    this.snapshot = next;
    // Copied before iterating: a subscriber that unmounts inside its own
    // notification must not shorten the list the loop is walking.
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Test/diagnostic only. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * The store a SeatSlot gets when nobody handed it one — SimPage, storybook-style
 * harnesses, anything that renders a seat outside a live table. It never
 * publishes, so subscribing to it costs one Set insertion and nothing else.
 */
export const IDLE_ACTION_CLOCK = new ActionClockStore();

const selectSeconds = (s: ActionClockSnapshot): number => s.seconds;
const selectProgress = (s: ActionClockSnapshot): number => s.progress;
const selectUrgent = (s: ActionClockSnapshot): boolean => s.isUrgent;

/**
 * Subscribe to one FIELD of the clock.
 *
 * `enabled` is the whole reason this takes a flag instead of returning the
 * snapshot: a seat that is not on the clock returns `undefined` on every
 * evaluation, React compares `undefined` with `Object.is` and does not render
 * it. Eight idle seats therefore cost nothing while the ninth counts down.
 */
function useClockField<T>(
  store: ActionClockStore | undefined,
  select: (s: ActionClockSnapshot) => T,
  enabled: boolean
): T | undefined {
  const live = store ?? IDLE_ACTION_CLOCK;
  const getSnapshot = useCallback(
    () => (enabled ? select(live.getSnapshot()) : undefined),
    [live, select, enabled]
  );
  return useSyncExternalStore(live.subscribe, getSnapshot, getSnapshot);
}

/** Whole seconds remaining, or `undefined` while `enabled` is false. */
export function useActionClockSeconds(
  store: ActionClockStore | undefined,
  enabled = true
): number | undefined {
  return useClockField(store, selectSeconds, enabled);
}

/** 0-100 progress, or `undefined` while `enabled` is false. */
export function useActionClockProgress(
  store: ActionClockStore | undefined,
  enabled = true
): number | undefined {
  return useClockField(store, selectProgress, enabled);
}

/** Hero urgency flag, or `undefined` while `enabled` is false. */
export function useActionClockUrgent(
  store: ActionClockStore | undefined,
  enabled = true
): boolean | undefined {
  return useClockField(store, selectUrgent, enabled);
}
