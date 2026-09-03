import React from 'react';
import './StatCard.css';

interface StatCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, subValue, icon, trend }) => {
  return (
    <div className="stat-card">
      {icon && <div className="stat-icon">{icon}</div>}
      <div className="stat-content">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {subValue && (
          <div className={`stat-subvalue ${trend ? `trend-${trend}` : ''}`}>{subValue}</div>
        )}
      </div>
    </div>
  );
};

export default StatCard;
