import { useEffect, useState } from 'react';
import { StreakFire } from './StreakFire';

interface StreakLeader {
  id: string;
  username: string;
  streak: number;
}

export function TopStreaksLeaderboard() {
  const [leaders, setLeaders] = useState<StreakLeader[]>([]);

  useEffect(() => {
    // Mocking real-time leaderboard data for UX demonstration
    setLeaders([
      { id: '1', username: 'SharkyP', streak: 42 },
      { id: '2', username: 'RiverRat', streak: 28 },
      { id: '3', username: 'AllInAl', streak: 15 },
    ]);
  }, []);

  return (
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.4)',
        borderRadius: '12px',
        padding: '1rem',
        marginTop: '1rem',
        border: '1px solid rgba(255, 255, 255, 0.1)',
      }}
    >
      <h4
        style={{
          color: '#f59e0b',
          fontSize: '0.9rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <span style={{ fontSize: '1.2rem' }}>🔥</span> Top Streaks
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {leaders.map((leader, index) => (
          <div
            key={leader.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255, 255, 255, 0.05)',
              padding: '0.5rem 0.75rem',
              borderRadius: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                style={{ color: 'rgba(255, 255, 255, 0.5)', fontWeight: 'bold', width: '1.5rem' }}
              >
                #{index + 1}
              </span>
              <span style={{ color: '#fff', fontWeight: 500 }}>{leader.username}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{leader.streak}</span>
              <StreakFire streakCount={leader.streak} size="sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
