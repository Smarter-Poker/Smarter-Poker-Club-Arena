import React from 'react';
import './DailyChallenges.css';

interface Challenge {
  id: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  reward: { type: 'chips' | 'diamonds'; amount: number };
  expiresAt?: Date;
  completed: boolean;
  claimed?: boolean;
}

interface DailyChallengesProps {
  challenges: Challenge[];
  onClaimReward?: (challengeId: string) => void;
}

export const DailyChallenges: React.FC<DailyChallengesProps> = ({ challenges, onClaimReward }) => {
  const getRewardIcon = (type: string) => {
    switch (type) {
      case 'chips':
        return '♠';
      case 'diamonds':
        return '◆';

      default:
        return '●';
    }
  };

  const formatTimeRemaining = (expiresAt: Date) => {
    const now = new Date();
    const diff = expiresAt.getTime() - now.getTime();
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="daily-challenges">
      <div className="challenges-header">
        <h3> Daily Challenges</h3>
        <span className="reset-timer">
          Resets in{' '}
          {formatTimeRemaining(
            (() => {
              const now = new Date();
              const midnight = new Date(now);
              midnight.setHours(24, 0, 0, 0);
              return midnight;
            })()
          )}
        </span>
      </div>

      <div className="challenges-list">
        {challenges.map((challenge) => (
          <div
            key={challenge.id}
            className={`challenge-item ${challenge.completed ? 'completed' : ''} ${challenge.claimed ? 'claimed' : ''}`}
          >
            <div className="challenge-info">
              <h4>{challenge.title}</h4>
              <p>{challenge.description}</p>
            </div>

            <div className="challenge-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${challenge.target > 0 ? Math.min((challenge.progress / challenge.target) * 100, 100) : 0}%`,
                  }}
                />
              </div>
              <span className="progress-text">
                {challenge.progress} / {challenge.target}
              </span>
            </div>

            <div className="challenge-reward">
              <span className="reward-icon">{getRewardIcon(challenge.reward.type)}</span>
              <span className="reward-amount">{challenge.reward.amount.toLocaleString()}</span>
            </div>

            {challenge.completed && !challenge.claimed ? (
              <button className="claim-btn" onClick={() => onClaimReward?.(challenge.id)}>
                Claim
              </button>
            ) : challenge.claimed ? (
              <span className="claimed-check">✓</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

export default DailyChallenges;
