/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST BANNER — Multi-Table Queue Position Indicator (#11, v2.0)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Subscribes to WAITLIST_POSITION_CHANGED via masterBus and displays floating
 * animated badges showing queue position for ALL tables the user is waiting on.
 *
 * v2.0: Supports multiple simultaneous waitlists with stacked display.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

interface WaitlistInfo {
  tableId: string;
  position: number;
  tableName: string;
  /**
   * Set only while an EXCLUSIVE seat hold is live (Dan 2026-08-30: sixty
   * seconds to get to the seat). An ISO instant rather than a duration, so a
   * backgrounded tab resumes on the real remaining time instead of restarting
   * the clock.
   */
  holdExpiresAt?: string | null;
}

/** Whole seconds left until an ISO instant. Never negative. */
function secondsLeft(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

export default function WaitlistBanner() {
  const [waitlistEntries, setWaitlistEntries] = useState<Map<string, WaitlistInfo>>(new Map());
  const navigate = useNavigate();

  /**
   * ONE TICK FOR THE WHOLE BANNER, and only while something is actually
   * counting down. A timer per entry would multiply renders for no gain, and
   * a timer that runs when no hold is live is a wakeup every second for a
   * component showing a static number.
   */
  const [, setTick] = useState(0);
  const hasLiveHold = Array.from(waitlistEntries.values()).some(
    (e) => secondsLeft(e.holdExpiresAt) > 0
  );
  useEffect(() => {
    if (!hasLiveHold) return;
    const id = setInterval(() => {
      /* AND DROP A HOLD THAT HAS RUN OUT. Without this the card fell through
         to the "You Are #N In Line" branch carrying the offer's position of
         0, and rendered the literal nonsense "You Are #0 In Line" - then
         froze there, because the tick stops once no hold is live. An expired
         offer is not a queue position: fn_offer_open_seat sets that row to
         'expired', so the player really is out of the line, and the honest
         thing is to take the card away. The offer-expired notification is
         what tells them why. */
      setWaitlistEntries((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, entry] of prev) {
          if (entry.holdExpiresAt && secondsLeft(entry.holdExpiresAt) <= 0) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [hasLiveHold]);

  /**
   * THE SEAT OFFER. Before this, the banner DELETED the badge the moment the
   * player was offered a seat: WAITLIST_POSITION_CHANGED reports position 0
   * for a 'notified' row, and position 0 was treated as "seated or removed".
   * So the one moment that is actually urgent - a seat held for you, right
   * now, for sixty seconds - was the moment the UI went blank.
   */
  useMasterBusSubscription('WAITLIST_SEAT_OFFERED', (payload) => {
    const { tableId, tableName, holdExpiresAt } = payload || ({} as any);
    if (!tableId) return;
    setWaitlistEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(tableId);
      next.set(tableId, {
        tableId,
        position: 0,
        tableName: tableName || existing?.tableName || '',
        holdExpiresAt: holdExpiresAt ?? null,
      });
      return next;
    });
  });

  useMasterBusSubscription('WAITLIST_POSITION_CHANGED', (payload) => {
    const { tableId, position, tableName } = payload || ({} as any);
    setWaitlistEntries((prev) => {
      const next = new Map(prev);
      if (position && position > 0) {
        next.set(tableId, { tableId, position, tableName, holdExpiresAt: null });
      } else {
        /* Position 0 means seated, removed - OR being offered a seat right
           now. Deleting unconditionally is what used to blank the banner at
           the only moment it mattered, so a live hold survives; anything
           else is still cleared. */
        const existing = next.get(tableId);
        if (existing && secondsLeft(existing.holdExpiresAt) > 0) {
          next.set(tableId, { ...existing, position: 0 });
        } else {
          next.delete(tableId);
        }
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

  /* BELT AND BRACES. The prune above removes a lapsed offer on the next tick,
     but a tick can be missed - a backgrounded tab, a throttled timer - and the
     one thing that must never appear is a card claiming a position the player
     does not hold. An entry is renderable only if it has a real queue position
     or a hold that is still running. */
  const entries = Array.from(waitlistEntries.values()).filter(
    (e) => e.position > 0 || secondsLeft(e.holdExpiresAt) > 0
  );

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
      {entries.map((entry, index) => {
        const left = secondsLeft(entry.holdExpiresAt);
        const held = left > 0;
        return (
          <div
            key={entry.tableId}
            onClick={held ? () => navigate(`/table/${entry.tableId}?buyin=1`) : undefined}
            role={held ? 'button' : undefined}
            tabIndex={held ? 0 : undefined}
            onKeyDown={
              held
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/table/${entry.tableId}?buyin=1`);
                    }
                  }
                : undefined
            }
            aria-label={
              held ? `Your Seat Is Held For ${left} More Seconds. Tap To Take It.` : undefined
            }
            style={{
              background:
                'linear-gradient(135deg, rgba(0, 20, 40, 0.95) 0%, rgba(10, 30, 60, 0.95) 100%)',
              backdropFilter: 'blur(20px) saturate(1.5)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
              border: held
                ? `1px solid ${left <= 10 ? 'rgba(255, 92, 92, 0.85)' : 'rgba(0, 212, 255, 0.85)'}`
                : '1px solid rgba(0, 212, 255, 0.3)',
              cursor: held ? 'pointer' : 'default',
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
                background: held && left <= 10 ? '#ff5c5c' : '#00d4ff',
                boxShadow:
                  held && left <= 10
                    ? '0 0 8px rgba(255, 92, 92, 0.7)'
                    : '0 0 8px rgba(0, 212, 255, 0.6)',
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
                {held ? (
                  <>
                    Seat Held{' '}
                    <span
                      style={{
                        color: left <= 10 ? '#ff5c5c' : '#00d4ff',
                        fontSize: '0.85rem',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      0:{String(left).padStart(2, '0')}
                    </span>{' '}
                    Tap To Take It
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              {/* An offer card arrives before the table name is known, and an
                  empty line just adds a gap under the countdown. */}
              {entry.tableName ? (
                <div
                  style={{
                    fontSize: '0.62rem',
                    color: '#6a7a8a',
                    marginTop: 2,
                  }}
                >
                  {entry.tableName}
                </div>
              ) : null}
            </div>

            {/* Close button */}
            {/* 2026-08-28: was a 22x22 tap target with no accessible name —
              half the 44px floor, and a screen reader announced nothing.
              Painted size is unchanged; the hit area is expanded to 44x44
              with a pseudo-element, the pattern ActionPanel already uses for
              its raise-adjust buttons. */}
            <button
              onClick={(e) => {
                // The card itself navigates while a hold is live; dismissing
                // must not also open the table.
                e.stopPropagation();
                dismiss(entry.tableId);
              }}
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
        );
      })}

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
