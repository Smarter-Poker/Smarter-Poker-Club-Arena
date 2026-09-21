import React from 'react';
import './StatCard.css';

interface StatCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  trend?: 'up' | 'down' | 'neutral';
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, subValue, trend }) => {
  return (
    <div className="stat-card">
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
