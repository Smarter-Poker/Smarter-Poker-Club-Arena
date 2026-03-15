import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import './PresenceHub.css';

interface OnlineFriend {
  id: string;
  username: string;
  avatar?: string;
  status: 'playing' | 'online';
  table?: string;
}

export default function PresenceHub() {
  const navigate = useNavigate();
  const [onlineFriends, setOnlineFriends] = useState<OnlineFriend[]>([]);

  useEffect(() => {
    // Simulated initial online friends
    setOnlineFriends([
      { id: 'f1', username: 'Durrrr', status: 'playing', table: 'Shark Tank 5/10' },
      { id: 'f2', username: 'PokerPro', status: 'playing', table: 'Sunday Million' },
      { id: 'f3', username: 'DealerDan', status: 'online' },
      { id: 'f4', username: 'FishyGuy', status: 'online' },
    ]);
  }, []);

  if (onlineFriends.length === 0) return null;

  const playingCount = onlineFriends.filter((f) => f.status === 'playing').length;

  return (
    <div className="presence-hub">
      <div className="presence-header" onClick={() => navigate('/friends')}>
        <div className="presence-title">
          <span className="live-dot-pulse"></span>
          <h3>Who's Online</h3>
        </div>
        <span className="presence-subtitle">{playingCount} playing right now</span>
      </div>
      <div className="presence-avatars">
        {onlineFriends.slice(0, 5).map((friend) => (
          <div
            key={friend.id}
            className={`presence-avatar-wrapper ${friend.status === 'playing' ? 'is-playing' : ''}`}
            title={`${friend.username} - ${friend.status === 'playing' ? 'Playing at ' + friend.table : 'Online'}`}
            onClick={() => {
              haptic.light();
              navigate(`/profile/${friend.id}`);
            }}
          >
            {friend.avatar ? (
              <img loading="lazy" decoding="async" src={friend.avatar} alt={friend.username} />
            ) : (
              <div className="presence-avatar-fallback">{friend.username[0]?.toUpperCase()}</div>
            )}
            <div className={`status-badge ${friend.status}`} />
          </div>
        ))}
        {onlineFriends.length > 5 && (
          <div
            className="presence-more"
            onClick={() => {
              haptic.light();
              navigate('/friends');
            }}
          >
            +{onlineFriends.length - 5}
          </div>
        )}
      </div>
    </div>
  );
}
