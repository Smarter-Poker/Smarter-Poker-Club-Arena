import React from 'react';
import './OnboardingChecklist.css';

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  reward?: { type: 'chips' | 'diamonds'; amount: number };
}

interface OnboardingChecklistProps {
  items: ChecklistItem[];
  onItemClick?: (itemId: string) => void;
  onClaimReward?: (itemId: string) => void;
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = ({
  items,
  onItemClick,
  onClaimReward,
}) => {
  const completedCount = items.filter((i) => i.completed).length;
  const progress = items.length > 0 ? (completedCount / items.length) * 100 : 0;

  return (
    <div className="onboarding-checklist">
      <div className="checklist-header">
        <h3> Getting Started</h3>
        <span className="checklist-progress">
          {completedCount}/{items.length}
        </span>
      </div>

      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progress}%` }}></div>
      </div>

      <div className="checklist-items">
        {items.map((item) => (
          <div
            key={item.id}
            className={`checklist-item ${item.completed ? 'completed' : ''}`}
            onClick={() => !item.completed && onItemClick?.(item.id)}
          >
            <div className="item-checkbox">{item.completed ? '' : ''}</div>
            <span className="item-label">{item.label}</span>
            {item.reward && (
              <div className="item-reward">
                <span className="reward-icon">{item.reward.type === 'diamonds' ? '' : ''}</span>
                <span className="reward-amount">+{item.reward.amount}</span>
                {item.completed && (
                  <button
                    className="claim-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClaimReward?.(item.id);
                    }}
                  >
                    Claim
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {completedCount === items.length && (
        <div className="all-complete">All Tasks Complete! You're Ready To Dominate.</div>
      )}
    </div>
  );
};

export default OnboardingChecklist;
