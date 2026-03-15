/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONNECTION STATUS BAR — Silent reconnection indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * DESIGN: This bar is INVISIBLE to users during normal operation. It only
 * appears as a brief green flash when reconnection succeeds after a prolonged
 * outage. Users should NEVER see red/orange disconnection indicators.
 * The watchdog handles all reconnection silently in the background.
 */

import { useEffect, useState, useRef } from 'react';
import { masterBus } from '../core/MasterBus';

type ConnStatus = 'connected' | 'idle';

export function ConnectionStatusBar() {
  const [status, setStatus] = useState<ConnStatus>('idle');
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Only show the bar on successful reconnection (green flash)
    const unsub1 = masterBus.subscribe('WS_CONNECTED', () => {
      setStatus('connected');
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setStatus('idle'), 2000);
    });

    // Ignore disconnect/reconnecting events — users should never see these
    // The watchdog handles reconnection silently

    return () => {
      unsub1();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (status === 'idle') return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '3px',
        backgroundColor: '#2ecc71',
        zIndex: 99999,
        transition: 'opacity 0.3s ease',
      }}
      role="status"
      aria-live="polite"
      aria-label="Connected"
    />
  );
}

export default ConnectionStatusBar;
