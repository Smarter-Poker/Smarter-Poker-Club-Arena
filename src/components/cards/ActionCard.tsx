import React from 'react';
import './ActionCard.css';

interface Action {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}

interface ActionCardProps {
  title: string;
  description?: string;
  actions: Action[];
  icon?: string;
}

export const ActionCard: React.FC<ActionCardProps> = ({ title, description, actions, icon }) => {
  return (
    <div className="action-card">
      <div className="action-card-content">
        {icon && <div className="action-icon">{icon}</div>}
        <div className="action-text">
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="action-buttons">
        {actions.map((action, i) => (
          <button
            key={i}
            className={`action-btn variant-${action.variant || 'secondary'}`}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ActionCard;
