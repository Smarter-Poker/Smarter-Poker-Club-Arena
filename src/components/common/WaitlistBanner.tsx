/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST BANNER — Multi-Table Queue Position Indicator (#11, v2.0)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Subscribes to WAITLIST_POSITION_CHANGED via masterBus and displays floating
 * animated badges showing queue position for ALL tables the user is waiting on.
 *
 * v2.0: Supports multiple simultaneous waitlists with stacked display.
 */

import { useState } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

interface WaitlistInfo {
  tableId: string;
  position: number;
  tableName: string;
}

export default function WaitlistBanner() {
  const [waitlistEntries, setWaitlistEntries] = useState<Map<string, WaitlistInfo>>(new Map());

  useMasterBusSubscription('WAITLIST_POSITION_CHANGED', (payload) => {
    const { tableId, position, tableName } = payload || ({} as any);
    setWaitlistEntries((prev) => {
      const next = new Map(prev);
      if (position && position > 0) {
        next.set(tableId, { tableId, position, tableName });
      } else {
        // Position 0 or null means user was seated or removed from waitlist
        next.delete(tableId);
      }
      return next;
    });
  });

  const dismiss = (tableId: string) => {
    setWaitlistEntries((prev) => {
      const next = new Map(prev);
      next.delete(tableId);
      return next;
    });
  };

  const entries = Array.from(waitlistEntries.values());

  if (entries.length === 0) return null;

  return (
    <div
      /**
       * MOBILE FIX 2026-08-28 — THIS BANNER SAT ON TOP OF THE ACTION ROW.
       *
       * It was `bottom: 80` with `zIndex: 9999`, mounted app-wide from
       * App.tsx. The action bar is `position: fixed; bottom: 0` with
       * `--sp-bottom-row-h: 52px` on mobile PLUS env(safe-area-inset-bottom)
       * — on a notched iPhone that band is ~86px tall, so 80 lands INSIDE
       * it, and 9999 beats `--z-action-panel: 100`. A player waiting on a
       * seat had fold / call / raise covered mid-hand by a banner about a
       * different table.
       *
       * Now it clears the action bar by construction: the same 52px +
       * safe-area the bar reserves, plus a 12px gap. z-index drops to the
       * token scale — above overlays, below modals and toasts — instead of
       * a number chosen to beat everything.
       */
      style={{
        position: 'fixed',
        bottom: 'calc(52px + env(safe-area-inset-bottom, 0px) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 'min(90vw, 420px)',
      }}
    >
      {entries.map((entry, index) => (
        <div
          key={entry.tableId}
          style={{
            background:
              'linear-gradient(135deg, rgba(0, 20, 40, 0.95) 0%, rgba(10, 30, 60, 0.95) 100%)',
            backdropFilter: 'blur(20px) saturate(1.5)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
            border: '1px solid rgba(0, 212, 255, 0.3)',
            borderRadius: 14,
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            boxShadow:
              '0 8px 32px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 212, 255, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
            animation: `animationsWaitlistSlideUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${index * 100}ms both`,
            minWidth: 260,
          }}
        >
          {/* Pulsing dot indicator */}
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#00d4ff',
              boxShadow: '0 0 8px rgba(0, 212, 255, 0.6)',
              animation: 'animationsWaitlistPulse 1.5s ease-in-out infinite',
              flexShrink: 0,
            }}
          />

          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: '0.72rem',
                fontWeight: 800,
                color: '#e0e8f0',
                lineHeight: 1.3,
              }}
            >
              You Are{' '}
              <span
                style={{
                  color: '#00d4ff',
                  fontSize: '0.85rem',
                }}
              >
                #{entry.position}
              </span>{' '}
              In Line
            </div>
            <div
              style={{
                fontSize: '0.62rem',
                color: '#6a7a8a',
                marginTop: 2,
              }}
            >
              {entry.tableName}
            </div>
          </div>

          {/* Close button */}
          {/* 2026-08-28: was a 22x22 tap target with no accessible name —
              half the 44px floor, and a screen reader announced nothing.
              Painted size is unchanged; the hit area is expanded to 44x44
              with a pseudo-element, the pattern ActionPanel already uses for
              its raise-adjust buttons. */}
          <button
            onClick={() => dismiss(entry.tableId)}
            aria-label={`Dismiss The Waitlist Notice For ${entry.tableName}`}
            className="waitlist-banner__dismiss"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '50%',
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#5a6a7a',
              fontSize: '0.65rem',
              flexShrink: 0,
              transition: 'all 0.2s',
              position: 'relative',
            }}
            title="Dismiss"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}

      <style>{`
                @keyframes waitlistSlideUp {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes waitlistPulse {
                    0%, 100% { opacity: 0.5; transform: scale(0.8); }
                    50% { opacity: 1; transform: scale(1.2); }
                }
                /* 44x44 hit area around the 22px dismiss dot (2026-08-28). */
                .waitlist-banner__dismiss::after {
                    content: '';
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    width: 44px;
                    height: 44px;
                    transform: translate(-50%, -50%);
                }
            `}</style>
    </div>
  );
}
