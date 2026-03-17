/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONNECTION INDICATOR — Realtime connection health dot (SILENT MODE)
 * ═══════════════════════════════════════════════════════════════════════════════
 * DESIGN: Users should NEVER see "Offline". The app silently reconnects in the
 * background. This indicator only renders in extreme failure cases (60+ seconds
 * of consecutive disconnection) and auto-dismisses as soon as connectivity
 * returns. For normal transient blips, users see nothing.
 *
 * The watchdog + Supabase client handle actual reconnection. This component
 * is purely visual feedback for catastrophic, prolonged outages.
 */

import { useState, useEffect, useRef } from 'react';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './ConnectionIndicator.css';

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

// Only show "Offline" after this many CONSECUTIVE seconds of disconnection.
// Normal blips (page transitions, token refresh, tab sleep) never reach this.
const OFFLINE_DISPLAY_THRESHOLD_MS = 60_000; // 60 seconds

export default function ConnectionIndicator() {
  const [connState, setConnState] = useState<ConnectionState>('connected');
  const [visible, setVisible] = useState(false); // Start hidden — assume connected
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup timers on unmount
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    };
  }, []);

  useMasterBusSubscription('REALTIME_CONNECTED', () => {
    // Connection restored — immediately hide any offline indicator
    if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    setConnState('connected');
    // Brief green flash to confirm reconnection, then hide
    if (visible) {
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), 2000);
    }
  });

  useMasterBusSubscription('REALTIME_DISCONNECTED', () => {
    // Start the long timer — only show "Offline" if disconnected for 60+ seconds.
    // Silently reconnect in the background. Users should never know about blips.
    if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    offlineTimerRef.current = setTimeout(() => {
      setConnState('disconnected');
      setVisible(true);
    }, OFFLINE_DISPLAY_THRESHOLD_MS);
  });

  // Also listen for reconnecting events — same silent treatment
  useMasterBusSubscription('WS_RECONNECTING', () => {
    // Cancel the offline timer — we're actively trying to reconnect
    // Only show if it's been a really long time
    if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    offlineTimerRef.current = setTimeout(() => {
      setConnState('reconnecting');
      setVisible(true);
    }, OFFLINE_DISPLAY_THRESHOLD_MS);
  });

  if (!visible) return null;

  const labels: Record<ConnectionState, string> = {
    connected: 'Connected',
    disconnected: 'Reconnecting...',
    reconnecting: 'Reconnecting...',
  };

  return (
    <div
      className={`conn-indicator conn-indicator--${connState}`}
      title={labels[connState]}
      role="status"
      aria-label={labels[connState]}
    >
      <span className="conn-indicator__dot" />
      {connState !== 'connected' && <span className="conn-indicator__label">Reconnecting...</span>}
    </div>
  );
}
