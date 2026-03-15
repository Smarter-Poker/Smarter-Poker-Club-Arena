/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ANIMATED WAITLIST — Visual queue with sliding player icons
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows the waitlist as an animated queue of player avatars that slide forward
 * as positions change. Provides visual feedback for queue movement.
 */

import { useEffect, useState } from 'react';
import './AnimatedWaitlist.css';

interface WaitlistEntry {
  id: string;
  username: string;
  avatarUrl?: string;
  position: number;
  joinedAt: string;
}

interface AnimatedWaitlistProps {
  entries: WaitlistEntry[];
  currentUserId?: string;
  tableName?: string;
}

export default function AnimatedWaitlist({
  entries,
  currentUserId,
  tableName = 'Table',
}: AnimatedWaitlistProps) {
  const [animating, setAnimating] = useState(false);

  // Trigger slide animation when entries change
  useEffect(() => {
    if (entries.length > 0) {
      setAnimating(true);
      const t = setTimeout(() => setAnimating(false), 600);
      return () => clearTimeout(t);
    }
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="aw-empty">
        <span className="aw-empty-icon">🪑</span>
        <span className="aw-empty-text">No one in the waitlist</span>
      </div>
    );
  }

  const userPosition = entries.find((e) => e.id === currentUserId)?.position;

  return (
    <div className="animated-waitlist">
      <div className="aw-header">
        <span className="aw-title">Waitlist</span>
        <span className="aw-count">{entries.length} waiting</span>
      </div>

      <div className="aw-queue">
        {/* Destination indicator */}
        <div className="aw-destination">
          <span className="aw-dest-icon">🎯</span>
          <span className="aw-dest-label">{tableName}</span>
        </div>

        {/* Connecting line */}
        <div className="aw-line" />

        {/* Player queue */}
        <div className="aw-players">
          {entries.map((entry, i) => {
            const isCurrentUser = entry.id === currentUserId;
            return (
              <div
                key={entry.id}
                className={`aw-player ${isCurrentUser ? 'is-you' : ''} ${animating ? 'slide' : ''}`}
                style={{
                  animationDelay: `${i * 80}ms`,
                  zIndex: entries.length - i,
                }}
              >
                <div className="aw-avatar-wrap">
                  {entry.avatarUrl ? (
                    <img
                      loading="lazy"
                      decoding="async"
                      src={entry.avatarUrl}
                      alt={entry.username}
                      className="aw-avatar"
                    />
                  ) : (
                    <div className="aw-avatar-fallback">
                      {entry.username.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="aw-position">#{entry.position}</span>
                </div>
                <span className="aw-name">{isCurrentUser ? 'You' : entry.username}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Current user position highlight */}
      {userPosition !== undefined && (
        <div className="aw-your-position">
          Your position: <strong>#{userPosition}</strong>
          {userPosition <= 3 && <span className="aw-almost"> — Almost there! 🎉</span>}
        </div>
      )}
    </div>
  );
}
