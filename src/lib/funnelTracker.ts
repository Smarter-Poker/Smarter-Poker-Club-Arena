/**
 * Activation Funnel Tracker — Phase 5.1.2b
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Subscribes to MasterBus + IdentityDNA and fires the three Club-Arena-side
 * PostHog funnel events AT MOST ONCE per (user, browser):
 *
 *   - first_table_seat  — on TABLE_SEATED
 *   - first_hand_played — on HAND_COMPLETED
 *   - first_session_of_30min — when the tab has been open for ≥30min with
 *       at least one HAND_COMPLETED fired in that session. (Open-and-idle
 *       tabs don't count; you have to actually be playing.)
 *
 * Called once from main.tsx after IdentityDNA and MasterBus are initialized.
 * All handlers are fire-and-forget — a crash inside the tracker must NEVER
 * break the poker UI.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { masterBus } from '../core/MasterBus';
import { identityDNA } from '../core/IdentityDNA';
import { capture, captureOnce, identify, FunnelEvents } from './analytics';

const SESSION_30MIN_MS = 30 * 60 * 1000;

let _started = false;
let _sessionStart: number | null = null;
let _handsThisSession = 0;
let _session30Timer: ReturnType<typeof setTimeout> | null = null;
let _lastIdentifiedUserId: string | null = null;

/**
 * Safely resolve the current user id. IdentityDNA may not have finished
 * getSession() yet when funnel events start firing — return null and let
 * captureOnce dedup under the 'anon' scope; once auth lands we identify()
 * and future events land on the right person.
 */
function currentUserId(): string | null {
  try {
    return identityDNA.getUserId();
  } catch {
    return null;
  }
}

/**
 * Call identify() once per userId flip. Safe to invoke repeatedly from the
 * auth listener without inflating network calls.
 */
function maybeIdentify(): void {
  const uid = currentUserId();
  if (!uid || uid === _lastIdentifiedUserId) return;
  _lastIdentifiedUserId = uid;
  try {
    identify(uid, { source: 'club-arena' });
  } catch {
    // swallow — analytics must never break auth
  }
}

/**
 * Fire first_session_of_30min if the user has been playing for ≥30min. Only
 * fires once per (user, browser) — once per lifetime essentially, because
 * the localStorage key never expires.
 */
function maybeFireSession30(): void {
  if (_sessionStart === null) return;
  if (_handsThisSession === 0) return; // idle tabs don't count
  const elapsed = Date.now() - _sessionStart;
  if (elapsed < SESSION_30MIN_MS) return;
  captureOnce(FunnelEvents.FIRST_SESSION_30MIN, currentUserId(), {
    session_ms: elapsed,
    hands_in_session: _handsThisSession,
  });
}

/**
 * Reset the session clock when the user lands in Club Arena. Called on
 * startFunnelTracker() so each SPA mount defines its own session.
 */
function resetSession(): void {
  _sessionStart = Date.now();
  _handsThisSession = 0;
  if (_session30Timer) clearTimeout(_session30Timer);
  // Schedule the 30-min check. We ALSO re-check on every HAND_COMPLETED so
  // a fast-starting session that crosses 30min doesn't have to wait for
  // the timer; and so sessions that start late (first hand at minute 25)
  // still fire on the 30-min mark even though the first-hand guard held.
  _session30Timer = setTimeout(() => {
    maybeFireSession30();
  }, SESSION_30MIN_MS + 500);
}

/**
 * Wire up the three funnel event listeners. Idempotent — safe to call more
 * than once; subsequent calls are no-ops.
 */
export function startFunnelTracker(): void {
  if (_started) return;
  _started = true;

  resetSession();

  // Identify now if auth already settled; otherwise the auth listener
  // below will catch it whenever getSession() resolves.
  maybeIdentify();

  // ── TABLE_SEATED → first_table_seat (once per user per browser) ─────
  masterBus.subscribe('TABLE_SEATED', (payload: unknown) => {
    maybeIdentify();
    const p = (payload || {}) as { tableId?: string; seat?: number; userId?: string };
    const uid = p.userId || currentUserId();
    // Only count when the seated user is the current user (not someone
    // else at the same table triggering a re-broadcast).
    if (uid && uid !== currentUserId()) return;
    try {
      captureOnce(FunnelEvents.FIRST_TABLE_SEAT, currentUserId(), {
        table_id: p.tableId,
        seat: p.seat,
      });
      // Also fire a non-once `table_seat` so analysts have a dense
      // event stream if they need seat-churn analysis later.
      capture('table_seat', { table_id: p.tableId, seat: p.seat });
    } catch {
      // swallow
    }
  });

  // ── HAND_COMPLETED → first_hand_played (once) + session counter ─────
  masterBus.subscribe('HAND_COMPLETED', (payload: unknown) => {
    maybeIdentify();
    const p = (payload || {}) as { handId?: string; tableId?: string };
    _handsThisSession += 1;
    try {
      captureOnce(FunnelEvents.FIRST_HAND_PLAYED, currentUserId(), {
        table_id: p.tableId,
        hand_id: p.handId,
      });
      // Dense event for retention/heatmap analysis.
      capture('hand_played', { table_id: p.tableId, hand_id: p.handId });
    } catch {
      // swallow
    }
    // Re-check the 30-min guard — the session might already be at 30min
    // from a long idle period right before the first hand.
    maybeFireSession30();
  });

  // ── Auth flip → re-identify so post-login events land on the right person
  // MasterBus emits AUTH_STATE_CHANGED on every supabase auth flip.
  masterBus.subscribe('AUTH_STATE_CHANGED', () => maybeIdentify());
  // And again on profile hydration in case user_id wasn't set at auth time.
  masterBus.subscribe('USER_PROFILE_LOADED', () => maybeIdentify());
}

/**
 * Test-only helper to reset module state between tests. Not exported from
 * the barrel so production callers can't accidentally use it.
 * @internal
 */
export function __resetForTests(): void {
  _started = false;
  _sessionStart = null;
  _handsThisSession = 0;
  _lastIdentifiedUserId = null;
  if (_session30Timer) {
    clearTimeout(_session30Timer);
    _session30Timer = null;
  }
}
