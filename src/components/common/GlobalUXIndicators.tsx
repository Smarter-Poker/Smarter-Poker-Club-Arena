/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL UX INDICATORS — Shared component for platform-wide UX consistency
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides:
 * 1. Offline banner (yellow warning when network is down)
 * 2. WebSocket connection health dot (green/red indicator)
 *
 * Usage: <GlobalUXIndicators wsConnected={true} />
 * Drop into any page for instant UX polish.
 */

import { useState, useEffect } from 'react';
import './GlobalUXIndicators.css';

interface Props {
  wsConnected?: boolean; // Pass WebSocket connection status from page
}

export default function GlobalUXIndicators({ wsConnected = true }: Props) {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return (
    <>
      {/* Offline banner */}
      {!isOnline && (
        <div className="global-offline-banner" role="alert">
          <span>⚠ Offline - Showing Cached Data</span>
        </div>
      )}
      {/* WS connection health dot */}
      <div
        className={`global-ws-dot ${wsConnected ? 'connected' : 'disconnected'}`}
        title={wsConnected ? 'Live Connection' : 'Reconnecting…'}
      />
    </>
  );
}
