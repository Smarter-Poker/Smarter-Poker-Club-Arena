/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONNECTION INDICATOR — Realtime connection health dot
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows a small colored dot reflecting Supabase realtime connection health.
 * Auto-hides when connected for 5+ seconds to avoid visual clutter.
 * Stays visible when disconnected to alert the user.
 */

import { useState, useEffect, useRef } from 'react';
import { masterBus } from '../../core/MasterBus';
import './ConnectionIndicator.css';

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export default function ConnectionIndicator() {
  const [connState, setConnState] = useState<ConnectionState>('connected');
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    const unsubConnected = masterBus.subscribe('REALTIME_CONNECTED', () => {
      // Cancel any pending disconnect display
      if (disconnectDelayRef.current) clearTimeout(disconnectDelayRef.current);
      setConnState('connected');
      // Auto-hide after 5 seconds when healthy
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), 5000);
    });

    const unsubDisconnected = masterBus.subscribe('REALTIME_DISCONNECTED', () => {
      // Grace period: Don't show "Offline" during the first 15 seconds after mount.
      // In iframe contexts, the initial connection takes time to establish.
      // Also add a 3-second delay before showing "Offline" to avoid flicker
      // from transient disconnects during page transitions.
      if (disconnectDelayRef.current) clearTimeout(disconnectDelayRef.current);
      const timeSinceMount = Date.now() - mountTimeRef.current;
      const delay = timeSinceMount < 15_000 ? 8_000 : 3_000;
      disconnectDelayRef.current = setTimeout(() => {
        setConnState('disconnected');
        setVisible(true);
      }, delay);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    });

    // Initial auto-hide after 5s
    hideTimerRef.current = setTimeout(() => setVisible(false), 5000);

    return () => {
      unsubConnected();
      unsubDisconnected();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (disconnectDelayRef.current) clearTimeout(disconnectDelayRef.current);
    };
  }, []);

  if (!visible) return null;

  const labels: Record<ConnectionState, string> = {
    connected: 'Live connection active',
    disconnected: 'Connection lost — data may be stale',
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
      {connState === 'disconnected' && <span className="conn-indicator__label">Offline</span>}
    </div>
  );
}
