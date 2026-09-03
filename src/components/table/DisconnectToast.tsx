/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DisconnectToast — hero-only banner for MISSING / DISCONNECTED states
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consumes the `disconnect_states` map the engine now emits (Phase 1.2 PR-F).
 * When the hero's FSM state is MISSING shows a countdown "Reconnecting —
 * N seconds until auto-check/fold". When DISCONNECTED shows "Session lost —
 * rejoin to continue". Otherwise renders null.
 *
 * The timer is deadline-based (graceDeadlineMs from the engine), not
 * setInterval + local math, so it survives OS-clock skew and tab-wake
 * from background.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DisconnectFsmEntry } from '../../utils/mapEngineSnapshot';
import './DisconnectToast.css';

export interface DisconnectToastProps {
  heroUserId: string | null | undefined;
  disconnectStates: Record<string, DisconnectFsmEntry>;
}

export default function DisconnectToast({
  heroUserId,
  disconnectStates,
}: DisconnectToastProps): ReactElement | null {
  const entry = heroUserId ? disconnectStates[heroUserId] : undefined;
  const state = entry?.state;
  const graceDeadline = entry?.graceDeadlineMs ?? null;

  // Live countdown when MISSING. Uses the engine's absolute deadline, not
  // a local duration — no drift under clock skew or tab wake.
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (state !== 'MISSING' || !graceDeadline) {
      setRemainingSec(null);
      return;
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const ms = Math.max(0, graceDeadline - Date.now());
      setRemainingSec(Math.ceil(ms / 1000));
      if (ms > 0) {
        rafRef.current = window.setTimeout(tick, 250) as unknown as number;
      }
    };
    tick();
    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        window.clearTimeout(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state, graceDeadline]);

  if (!entry) return null;

  if (state === 'MISSING') {
    return (
      <div className="disconnect-toast disconnect-toast--missing" role="status" aria-live="polite">
        <span className="disconnect-toast__spinner" aria-hidden="true" />
        <span>Reconnecting - {remainingSec ?? '...'}s Until Auto-Action</span>
      </div>
    );
  }

  if (state === 'DISCONNECTED') {
    return (
      <div className="disconnect-toast disconnect-toast--disconnected" role="alert">
        <span>Session Lost. Refresh To Rejoin The Table.</span>
      </div>
    );
  }

  return null;
}
