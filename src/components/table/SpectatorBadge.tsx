/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPECTATOR BADGE — Shows observer count at table
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState } from 'react';
import './SpectatorBadge.css';
import type { PlayerPresence } from '../../services/TableWebSocket';

interface SpectatorBadgeProps {
  observers: PlayerPresence[];
  className?: string;
}

export const SpectatorBadge: React.FC<SpectatorBadgeProps> = ({ observers, className = '' }) => {
  const [showList, setShowList] = useState(false);
  const count = observers.length;

  if (count === 0) return null;

  return (
    <div className={`spectator-badge ${className}`} style={{ position: 'relative' }}>
      {/* Badge button */}
      <button
        onClick={() => setShowList(!showList)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: '20px',
          color: '#fff',
          fontSize: '13px',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          backdropFilter: 'blur(8px)',
          animation: 'spectatorFloating 3s ease-in-out infinite',
        }}
      >
        {/* Audit 2026-08-25: this span was EMPTY — the leftover shell of an
            emoji that a no-emoji pass stripped without removing its wrapper, so
            the badge rendered a 14px gap before its own label. Filled with the
            same ring glyph SpectatorOverlay uses for the identical badge, which
            is a plain Unicode text symbol, not an emoji. */}
        <span style={{ fontSize: '14px' }} aria-hidden="true">
          ◉
        </span>
        <span>{count} Watching</span>
      </button>

      {/* Dropdown list */}
      {showList && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '0',
            marginTop: '8px',
            minWidth: '180px',
            backgroundColor: 'rgba(20, 20, 20, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '8px',
            padding: '8px 0',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              fontSize: '12px',
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Spectators
          </div>
          {observers.map((obs) => (
            <div
              key={obs.userId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                fontSize: '13px',
                color: '#fff',
              }}
            >
              {obs.avatar ? (
                <img
                  loading="lazy"
                  decoding="async"
                  src={obs.avatar}
                  alt={obs.username}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: '#4a4a4a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                  }}
                >
                  {obs.username.charAt(0).toUpperCase()}
                </div>
              )}
              <span>{obs.username}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SpectatorBadge;
