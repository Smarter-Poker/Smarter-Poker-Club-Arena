/**
 * LIGHTNING PHASE 12: HAND CREATION -> FIRST CLIENT RENDER.
 *
 * The spec's ACTION LATENCY TELEMETRY names the leg "hand creation -> first
 * client render". Only the client sees its own paint, so when a Lightning
 * room first renders a hand it tells the engine once: one small RENDER_ACK
 * frame on the table socket it already has, carrying the hand id and a
 * client-side delta (the time from the hand reaching React to the next
 * painted frame). NO CARD, no seat, no amount - a hand id only.
 *
 * The engine does not trust this clock. It times the leg itself, from the
 * moment its host sent the room the hand's first frame to the moment this
 * acknowledgement arrived; `d` is informational and ignored there. A room
 * that is not on screen (a background tab with no paint) may never ack, and
 * that is simply no sample.
 *
 * A HIDDEN TAB IS A RESUME (2026-10-23). A browser does not paint a hidden
 * tab, so a hand that reached React while the page was hidden is painted only
 * when the player comes back. That ack would time the player's absence, not
 * the render, so it carries `r: 1` and the engine counts it as a resume (it
 * still claims the seat). An engine that predates the flag ignores it.
 *
 * Telemetry only: nothing here changes what the player sees or can do, and a
 * failure to send is silent.
 */

/** The longest client delta reported (beyond it the paint was not this hand's). */
export const LIGHTNING_RENDER_ACK_MAX_DELTA_MS = 60_000;

export interface LightningRenderAckFrame {
  type: 'RENDER_ACK';
  tableId: string;
  hand_id: string;
  d: number;
  /** 1: the hand reached React while the page was hidden (a resume, not a render). */
  r?: 1;
}

/** The frame, exactly: a hand id and a bounded whole-millisecond delta, nothing else. */
export function lightningRenderAckFrame(
  tableId: string,
  handId: string,
  deltaMs: number,
  resumed = false
): LightningRenderAckFrame {
  const d = Number.isFinite(deltaMs)
    ? Math.max(0, Math.min(LIGHTNING_RENDER_ACK_MAX_DELTA_MS, Math.round(deltaMs)))
    : 0;
  const frame: LightningRenderAckFrame = { type: 'RENDER_ACK', tableId, hand_id: handId, d };
  if (resumed) frame.r = 1;
  return frame;
}

/**
 * Once the hand has been committed to the DOM, wait for the next painted
 * frame and acknowledge it. `send` is the table socket's own sender.
 * Returns a cancel for the effect's cleanup.
 */
export function scheduleLightningRenderAck(
  handId: string,
  send: (handId: string, deltaMs: number, resumed: boolean) => void,
  clock: () => number = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now(),
  hidden: () => boolean = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
): () => void {
  const committedAt = clock();
  // Hidden when the hand reached React, or at any point before its paint.
  let wasHidden = hidden();
  let cancelled = false;
  const onVisibility = () => {
    if (hidden()) wasHidden = true;
  };
  const watch = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
  if (watch) document.addEventListener('visibilitychange', onVisibility);
  const unwatch = () => {
    if (watch) document.removeEventListener('visibilitychange', onVisibility);
  };
  const fire = () => {
    if (cancelled) return;
    cancelled = true;
    unwatch();
    try {
      send(handId, clock() - committedAt, wasHidden || hidden());
    } catch {
      // Telemetry never reaches back into the table.
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => fire());
    return () => {
      cancelled = true;
      unwatch();
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    };
  }
  const t = setTimeout(fire, 0);
  return () => {
    cancelled = true;
    unwatch();
    clearTimeout(t);
  };
}
