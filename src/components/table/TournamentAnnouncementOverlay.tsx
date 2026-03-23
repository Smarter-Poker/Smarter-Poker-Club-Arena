import React, { useState, useEffect } from 'react';
import './TournamentAnnouncementOverlay.css';

interface TournamentAnnouncementProps {
  type: 'hand_for_hand' | 'bubble_burst' | 'final_table' | 'level_up' | null;
  data?: any;
  onDismiss: () => void;
}

const TournamentAnnouncementOverlay: React.FC<TournamentAnnouncementProps> = ({
  type,
  data,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (type) {
      setVisible(true);
      const timer = setTimeout(
        () => {
          setVisible(false);
          setTimeout(onDismiss, 500); // Wait for fade-out
        },
        type === 'level_up' ? 2000 : 4000
      );
      return () => clearTimeout(timer);
    }
  }, [type, onDismiss]);

  if (!type) return null;

  const config: Record<string, { icon: string; title: string; subtitle: string; color: string }> = {
    hand_for_hand: {
      icon: '✋',
      title: 'HAND FOR HAND',
      subtitle: 'All tables play one hand at a time — bubble approaching!',
      color: '#f59e0b',
    },
    bubble_burst: {
      icon: '💰',
      title: 'BUBBLE BURST!',
      subtitle: 'Congratulations — all remaining players are in the money!',
      color: '#10b981',
    },
    final_table: {
      icon: '🏆',
      title: 'FINAL TABLE',
      subtitle: `${data?.playersRemaining || 'All'} players remain — final table begins!`,
      color: '#8b5cf6',
    },
    level_up: {
      icon: '⬆',
      title: `LEVEL ${data?.level || 1}`,
      subtitle: `Blinds: ${data?.smallBlind ?? '—'}/${data?.bigBlind ?? '—'}${data?.ante ? ` Ante: ${data.ante}` : ''}`,
      color: '#3b82f6',
    },
  };

  const c = config[type] || config.level_up;

  return (
    <div
      className={`tournamentAnnouncement ${visible ? 'visible' : ''}`}
      style={{ '--accent-color': c.color } as React.CSSProperties}
    >
      <div className="announcementContent">
        <div className="announcementIcon">{c.icon}</div>
        <div className="announcementTitle">{c.title}</div>
        <div className="announcementSubtitle">{c.subtitle}</div>
      </div>
    </div>
  );
};

export default TournamentAnnouncementOverlay;
