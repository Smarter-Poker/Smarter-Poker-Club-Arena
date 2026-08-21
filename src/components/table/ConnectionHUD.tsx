/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONNECTION HUD — Latency indicator and disconnect warning
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  disconnectProtectionService,
  type ConnectionState,
} from '../../services/DisconnectProtectionService';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { haptic, soundService } from '../../services/SoundService';
import { useToast } from '../common/Toast';
import './ConnectionHUD.css';
import { reportError } from '../../utils/errorReporter';

interface ConnectionHUDProps {
  tableId: string;
  userId: string;
}

// Use Unicode bullet (U+2022) styled via CSS class color — no emoji
const QUALITY_ICONS: Record<string, string> = {
  excellent: '\u2022',
  good: '\u2022',
  fair: '\u2022',
  poor: '\u2022',
  disconnected: '\u2022',
};

const QUALITY_LABELS: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  disconnected: 'Disconnected',
};

export const ConnectionHUD: React.FC<ConnectionHUDProps> = ({ tableId, userId }) => {
  const toast = useToast();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [graceCountdown, setGraceCountdown] = useState<number | null>(null);
  const [showDisconnectWarning, setShowDisconnectWarning] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  /** Enhancement #1: Store the actual auto-action text from DISCONNECT_TIMEOUT */
  const [autoActionText, setAutoActionText] = useState<string | null>(null);
  /** Prevents the polling interval from overwriting the DISCONNECT_TIMEOUT state */
  const hasTimedOutRef = useRef(false);
  /** Track whether we were disconnected (for reconnect toast) */
  const wasDisconnectedRef = useRef(false);
  /** Track stale data state for banner */
  const [showStaleBanner, setShowStaleBanner] = useState(false);
  /** Stale banner auto-dismiss timer ref */
  const staleBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Poll connection state ──
  useEffect(() => {
    const interval = setInterval(() => {
      const state = disconnectProtectionService.getConnectionState(tableId, userId);
      setConn(state);

      // Don't overwrite countdown if DISCONNECT_TIMEOUT has already fired
      if (hasTimedOutRef.current) return;

      // Update grace countdown
      if (state && !state.isConnected && state.graceExpiresAt) {
        const remaining = Math.max(0, Math.ceil((state.graceExpiresAt - Date.now()) / 1000));
        setGraceCountdown(remaining);
      } else {
        setGraceCountdown(null);
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      if (staleBannerTimerRef.current) clearTimeout(staleBannerTimerRef.current);
    };
  }, [tableId, userId]);

  // ── Listen for disconnect events ──
  useMasterBusSubscription('PLAYER_DISCONNECTED', (payload: any) => {
    const data = payload;
    if (data?.userId === userId && data?.tableId === tableId) {
      hasTimedOutRef.current = false; // Reset on new disconnect
      setAutoActionText(null); // Reset action text
      setShowDisconnectWarning(true);
      wasDisconnectedRef.current = true;
      // FIX 172: Play disconnect sound (Bible V8 §5.3)
      if (soundService.isEnabled()) soundService.playDisconnect();
      haptic.double(); // Haptic: disconnect warning
    }
  });

  useMasterBusSubscription('PLAYER_RECONNECTED', (payload: any) => {
    const data = payload;
    if (data?.userId === userId && data?.tableId === tableId) {
      hasTimedOutRef.current = false; // Reset on reconnect
      setAutoActionText(null); // Reset action text
      setShowDisconnectWarning(false);
      // FIX 172: Play reconnect sound (Bible V8 §5.3)
      if (soundService.isEnabled()) soundService.playReconnect();
      haptic.medium(); // Haptic: reconnected confirmation

      // Show reconnect toast and stale data banner
      if (wasDisconnectedRef.current) {
        wasDisconnectedRef.current = false;
        toast.success('Connection restored - table data syncing...');
        setShowStaleBanner(true);
        // Auto-hide stale banner after 5s (data should be fresh by then)
        if (staleBannerTimerRef.current) clearTimeout(staleBannerTimerRef.current);
        staleBannerTimerRef.current = setTimeout(() => setShowStaleBanner(false), 5000);
      }
    }
  });

  // Feature 2b: Listen for grace period expiry — display auto-action taken
  useMasterBusSubscription('DISCONNECT_TIMEOUT', (payload: any) => {
    const data = payload;
    if (data?.userId === userId && data?.tableId === tableId) {
      hasTimedOutRef.current = true; // Lock the countdown at 0
      setGraceCountdown(0); // Force countdown to 0 to show timeout message
      // Enhancement #1: Store the actual action for display
      const action = data.action || 'check_fold';
      const actionLabel = action
        .replace(/_/g, '/')
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
      setAutoActionText(actionLabel);
      haptic.strong(); // Haptic: timeout warning
      console.debug(`[ConnectionHUD] Disconnect timeout - auto-action: ${action}`);
    }
  });

  // ── Auto-reconnect with exponential backoff ──
  useEffect(() => {
    if (!showDisconnectWarning) {
      setReconnectAttempts(0);
      setIsReconnecting(false);
      return;
    }

    const MAX_RECONNECT_ATTEMPTS = 10; // Enhancement #6: stop after 10 attempts
    let timeout: ReturnType<typeof setTimeout>;
    let cancelled = false; // Prevents ghost timeout chain after unmount

    const attemptReconnect = async (attempt: number) => {
      if (cancelled) return; // Stop if effect was cleaned up
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        // Enhancement #6: Give up after max attempts
        if (!cancelled) {
          setIsReconnecting(false);
          setReconnectAttempts(attempt);
        }
        return;
      }
      if (!cancelled) {
        setIsReconnecting(true);
        setReconnectAttempts(attempt);
      }
      try {
        // Attempt reconnection via the disconnect protection service
        const svc = disconnectProtectionService as any;
        if (typeof svc.attemptReconnect === 'function') {
          await svc.attemptReconnect(tableId, userId);
        } else {
          // Fallback: check if connection re-established via polling
          const state = disconnectProtectionService.getConnectionState(tableId, userId);
          if (state?.isConnected) return; // Successfully reconnected
          throw new Error('Still disconnected');
        }
      } catch (err) {
        reportError(err, 'ConnectionHUD.Error');
        if (cancelled) return; // Don't schedule if cleaned up during await
        // Exponential backoff: 1s, 2s, 4s, 8s, max 16s
        const delay = Math.min(1000 * Math.pow(2, attempt), 16_000);
        timeout = setTimeout(() => attemptReconnect(attempt + 1), delay);
      }
    };

    // Start first reconnect attempt after 1s
    timeout = setTimeout(() => attemptReconnect(0), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [showDisconnectWarning, tableId, userId]);

  if (!conn) return null;

  return (
    <>
      {/* ── Latency Indicator (always visible) ── */}
      <div className={`conn-hud conn-${conn.quality}`}>
        <span className="conn-icon">{QUALITY_ICONS[conn.quality]}</span>
        <span className="conn-latency">{conn.latencyMs}ms</span>
        <span className="conn-label">{QUALITY_LABELS[conn.quality]}</span>
      </div>

      {/* ── Stale Data Banner (after reconnect) ── */}
      {showStaleBanner && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '6px 12px',
            background:
              'linear-gradient(135deg, rgba(217, 119, 6, 0.9) 0%, rgba(245, 158, 11, 0.9) 100%)',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 600,
            animation: 'slideInDown 0.3s ease-out',
          }}
        >
          <span style={{ fontWeight: 700 }}>--</span>
          Reconnected - syncing latest table state...
          <button
            onClick={() => setShowStaleBanner(false)}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Disconnect Warning Overlay ── */}
      {showDisconnectWarning && (
        <div className="conn-dc-warning">
          <div className="conn-dc-container">
            <span className="conn-dc-icon" style={{ fontSize: '1.5rem', lineHeight: 1 }}>
              X
            </span>
            <span className="conn-dc-text">Connection Lost</span>
            {graceCountdown !== null && graceCountdown > 0 && (
              <div className="conn-dc-grace">
                <span className="conn-dc-timer">{graceCountdown}s</span>
                <span className="conn-dc-label">reconnecting...</span>
                <div className="conn-dc-bar">
                  <div
                    className="conn-dc-fill"
                    style={{
                      width: `${(graceCountdown / 30) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {graceCountdown === 0 && (
              <span className="conn-dc-timeout">
                Auto-action applied: {autoActionText || 'check/fold'}
              </span>
            )}
            {isReconnecting && reconnectAttempts > 0 && (
              <span className="conn-dc-retry">Retry attempt {reconnectAttempts}/10...</span>
            )}
            {!isReconnecting && reconnectAttempts >= 10 && (
              <span className="conn-dc-retry" style={{ color: '#ef4444' }}>
                Reconnection failed. Please refresh the page.
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default ConnectionHUD;
