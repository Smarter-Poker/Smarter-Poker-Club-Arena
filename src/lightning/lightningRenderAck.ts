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
}

/** The frame, exactly: a hand id and a bounded whole-millisecond delta, nothing else. */
export function lightningRenderAckFrame(
  tableId: string,
  handId: string,
  deltaMs: number
): LightningRenderAckFrame {
  const d = Number.isFinite(deltaMs)
    ? Math.max(0, Math.min(LIGHTNING_RENDER_ACK_MAX_DELTA_MS, Math.round(deltaMs)))
    : 0;
  return { type: 'RENDER_ACK', tableId, hand_id: handId, d };
}

/**
 * Once the hand has been committed to the DOM, wait for the next painted
 * frame and acknowledge it. `send` is the table socket's own sender.
 * Returns a cancel for the effect's cleanup.
 */
export function scheduleLightningRenderAck(
  handId: string,
  send: (handId: string, deltaMs: number) => void,
  clock: () => number = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
): () => void {
  const committedAt = clock();
  let cancelled = false;
  const fire = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      send(handId, clock() - committedAt);
    } catch {
      // Telemetry never reaches back into the table.
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => fire());
    return () => {
      cancelled = true;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    };
  }
  const t = setTimeout(fire, 0);
  return () => {
    cancelled = true;
    clearTimeout(t);
  };
}
