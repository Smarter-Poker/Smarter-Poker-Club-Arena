/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A "NOT NOW" FROM A LIGHTNING HAND WAITS FOR THE HAND (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * While a player's chips are in a live Lightning hand the database refuses any
 * change to their anchor seat, and the engine answers an add-on with
 * LIGHTNING_ADD_ON_REFUSED_MESSAGE (server/src/lightning/rpcErrors.ts). Nothing
 * was taken; it is a "not now".
 *
 * The ordinary Auto Top Up effect on an anchor table did not hear it that way.
 * A Lightning anchor table is halted for as long as its game is Lightning, so
 * `isHandInProgress` is false on every snapshot, and the effect re-runs on
 * every snapshot. Each pass asked again, was refused again, filed the refusal
 * and raised the error toast. Production, 2026-10-24 06:23-06:39: one player,
 * two anchor tables, ~11 refusals a minute each - 392 refusals, 392 toasts.
 *
 * The hold makes the refusal a wait. Once engaged, automatic top-ups stop
 * asking. The hold asks the database whether the player's chips are still in a
 * hand (fn_lightning_my_session.in_hand, the same settled signal
 * readLightningTopUp gates on), on a growing interval, and releases the moment
 * the answer is no - the next pass then tops up exactly as it would have.
 *
 * It cannot wait for ever on a question nobody answers: after
 * LIGHTNING_HOLD_MAX_UNANSWERED checks without an answer it releases, and the
 * worst case is one more refusal (which engages it again) per that interval.
 */

/** The engine's sentence, verbatim. Pinned to the server constant by a test. */
export const LIGHTNING_ADD_ON_REFUSED_TEXT =
  'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.';

export function isLightningAddOnRefusal(error: unknown): boolean {
  return typeof error === 'string' && error.trim() === LIGHTNING_ADD_ON_REFUSED_TEXT;
}

/** First wait before asking whether the hand settled, its growth and ceiling. */
export const LIGHTNING_HOLD_FIRST_CHECK_MS = 2_000;
export const LIGHTNING_HOLD_BACKOFF = 1.5;
export const LIGHTNING_HOLD_MAX_CHECK_MS = 15_000;
/** Unanswered checks before the hold lets one attempt through regardless. */
export const LIGHTNING_HOLD_MAX_UNANSWERED = 20;

export function lightningHoldDelay(checks: number): number {
  const grown = LIGHTNING_HOLD_FIRST_CHECK_MS * Math.pow(LIGHTNING_HOLD_BACKOFF, checks);
  return Math.min(LIGHTNING_HOLD_MAX_CHECK_MS, Math.round(grown));
}

export interface LightningAddOnHoldDeps {
  /**
   * True while the player's chips are in a live Lightning hand in this
   * Cluster; false once settled. A throw or null is "unknown": the hold keeps
   * waiting rather than guessing.
   */
  inHand: (clusterId: string) => Promise<boolean | null>;
  onRelease: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class LightningAddOnHold {
  private held = false;
  private clusterId: string | null = null;
  private timer: unknown = null;
  private checks = 0;
  private unanswered = 0;
  private generation = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: LightningAddOnHoldDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Automatic top-ups must not ask while this is true. */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * The engine said "not now". Engaging an engaged hold changes nothing: the
   * wait already running is the one that releases it. With no Cluster to ask
   * about, the hold simply waits out the longest interval once.
   */
  engage(clusterId: string | null | undefined): void {
    if (this.held) return;
    this.held = true;
    this.clusterId = clusterId || null;
    this.checks = 0;
    this.unanswered = 0;
    this.schedule(this.generation);
  }

  /** The table, the player or the Cluster changed: forget the wait silently. */
  reset(): void {
    this.generation += 1;
    this.held = false;
    this.clusterId = null;
    this.checks = 0;
    this.unanswered = 0;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(generation: number): void {
    const delay = this.clusterId ? lightningHoldDelay(this.checks) : LIGHTNING_HOLD_MAX_CHECK_MS;
    this.timer = this.setTimer(() => void this.check(generation), delay);
  }

  private release(): void {
    this.held = false;
    this.clusterId = null;
    this.checks = 0;
    this.unanswered = 0;
    this.deps.onRelease();
  }

  private async check(generation: number): Promise<void> {
    this.timer = null;
    if (generation !== this.generation || !this.held) return;
    const clusterId = this.clusterId;
    if (!clusterId) return this.release();
    this.checks += 1;
    let answer: boolean | null = null;
    try {
      answer = await this.deps.inHand(clusterId);
    } catch {
      answer = null;
    }
    if (generation !== this.generation || !this.held) return;
    if (answer === false) return this.release();
    if (answer === null && ++this.unanswered >= LIGHTNING_HOLD_MAX_UNANSWERED) {
      return this.release();
    }
    this.schedule(generation);
  }
}
