/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WOULD A BEAT BE SKIPPED? — the one question the re-anchor is asking
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The spin reveal is anchored to the third payment (`stampSpinRevealAnchor`),
 * so the wheel is not charged for the engine's start-up work. The client
 * honours that anchor exactly:
 *
 *     const elapsed = Math.max(0, Date.now() - data.revealAtMs);
 *     const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
 *
 * Every beat already behind `elapsed` therefore fires AT ONCE. So there is
 * exactly one condition under which the anchor must be abandoned and the
 * sequence restarted from now: **the reveal instant has already passed**.
 * Below that, `elapsed` is zero and nothing is skipped; above it, the
 * countdown, the chase and the flash start collapsing into one instant, which
 * is "it spun, never finished, never announced" (Dan, 2026-08-30) and a plain
 * violation of the Animation Law (CLAUDE.md 10.6).
 *
 * ─── WHY THIS IS A FUNCTION AND NOT AN INLINE COMPARISON ────────────────────
 *
 * Because the inline comparison silently inverted itself, in this repo, on
 * 2026-08-31, inside a fix that was otherwise correct.
 *
 * It used to read:
 *
 *     if (this.spinHoldUntil - now < spinRevealToDealMs()) { ...re-anchor... }
 *
 * With the hold stamped as `spinRevealAt + spinRevealToDealMs()` — that is,
 * `anchor + LEAD_IN + toDeal` — that expands to `anchor + LEAD_IN < now`,
 * i.e. "the reveal instant has passed". Correct, and equal to this module.
 *
 * The same morning, the double-counted lead-in was removed and the hold became
 * `anchor + spinRevealToDealMs()`. That change was right on its own terms — it
 * had been holding the deal a full second longer than the sequence it waits
 * for. But the threshold was expressed in terms of the HOLD, so it moved with
 * it, and became:
 *
 *     anchor + toDeal - now < toDeal   ⟺   anchor < now
 *
 * which is true for **every spin that has ever run**, since the anchor is the
 * third payment and `now` is after the draw. The consequences, both of them
 * invisible because everything still worked:
 *
 *   1. the anchor was discarded 100% of the time, so the wheel no longer
 *      opened one second after the third payment even when the engine was
 *      quick — the exact promise `stampSpinRevealAnchor` exists to keep;
 *   2. `Tournament.spin_reveal_window_overrun` was reported on every single
 *      spin — roughly 1,500 a day — which is how a real lateness signal gets
 *      buried.
 *
 * Two correct changes, one derived quantity between them, and the invariant
 * fell out. Stating the question directly — in terms of the reveal instant,
 * which is what the client actually keys on — means the next change to the
 * hold cannot move it, and `spinRevealWindow.test.ts` pins the arithmetic
 * rather than the wording.
 */

/** Everything the decision needs. No clock, no instance, no I/O. */
export interface SpinRevealWindow {
  /** Wall clock at the moment of the decision. */
  now: number;
  /** When the wheel is due to begin — `anchor + LEAD_IN_MS`. */
  revealAt: number;
}

/**
 * Has the wheel's own start already gone past?
 *
 * `true` means the client would skip at least the first instant of the
 * sequence, so the reveal must be re-anchored to now and played in full.
 */
export function spinRevealWouldSkipABeat({ now, revealAt }: SpinRevealWindow): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(revealAt)) return true;
  return now > revealAt;
}

/**
 * How far behind its own schedule the engine is, in milliseconds.
 *
 * Never negative: an engine that reaches the broadcast BEFORE the reveal is
 * due is early, not "minus two seconds late", and the metric this feeds is a
 * lateness measure.
 */
export function spinRevealLag({ now, revealAt }: SpinRevealWindow): number {
  if (!Number.isFinite(now) || !Number.isFinite(revealAt)) return 0;
  return Math.max(0, now - revealAt);
}
