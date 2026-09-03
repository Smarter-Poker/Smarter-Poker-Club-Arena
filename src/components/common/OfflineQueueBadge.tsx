/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OFFLINE QUEUE BADGE — Shows Pending Offline Mutations
 * ═══════════════════════════════════════════════════════════════════════════════
 * Small floating badge that appears when there are pending offline mutations.
 * Auto-hides when the queue is replayed (back online).
 */

import { useState, useEffect } from 'react';
import { OfflineQueueService } from '../../services/OfflineQueueService';

export default function OfflineQueueBadge() {
  const [queueSize, setQueueSize] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    // Check queue size periodically when offline
    const check = async () => {
      const size = await OfflineQueueService.getCount();
      setQueueSize(size);
      setIsOnline(navigator.onLine);
    };

    check();
    const interval = setInterval(check, 2000);

    const goOnline = () => {
      setIsOnline(true);
      check();
    };
    const goOffline = () => {
      setIsOnline(false);
      check();
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      clearInterval(interval);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Don't render if no pending items and online
  if (queueSize === 0 && isOnline) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 80,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 14px',
        background: !isOnline
          ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
          : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        color: '#fff',
        borderRadius: '20px',
        fontSize: '0.8125rem',
        fontWeight: 600,
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        animation: 'animationsSlideInRight 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ fontSize: '1rem' }}>{!isOnline ? '--' : '...'}</span>
      {!isOnline ? 'Offline' : `${queueSize} Pending`}
      {queueSize > 0 && (
        <span
          style={{
            background: 'rgba(255,255,255,0.3)',
            borderRadius: '10px',
            padding: '1px 7px',
            fontSize: '0.75rem',
          }}
        >
          {queueSize}
        </span>
      )}
      <style>{`
                @keyframes slideInRight {
                    from { opacity: 0; transform: translateX(20px); }
                    to { opacity: 1; transform: translateX(0); }
                }
            `}</style>
    </div>
  );
}
