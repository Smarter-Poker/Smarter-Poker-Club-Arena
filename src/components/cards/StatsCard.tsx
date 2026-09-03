import React from 'react';
import './StatsCard.css';

interface StatItem {
  label: string;
  value: string | number;
  change?: number;
  icon?: string;
}

interface StatsCardProps {
  title?: string;
  stats: StatItem[];
  columns?: 2 | 3 | 4;
}

export const StatsCard: React.FC<StatsCardProps> = ({ title, stats, columns = 3 }) => {
  return (
    <div className="stats-card">
      {title && <h3 className="stats-title">{title}</h3>}
      <div className={`stats-grid cols-${columns}`}>
        {stats.map((stat, i) => (
          <div key={i} className="stat-item">
            {stat.icon && <span className="stat-icon">{stat.icon}</span>}
            <span className="stat-value">{stat.value}</span>
            <span className="stat-label">{stat.label}</span>
            {stat.change !== undefined && (
              <span className={`stat-change ${stat.change >= 0 ? 'positive' : 'negative'}`}>
                {stat.change >= 0 ? '+' : ''}
                {stat.change}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default StatsCard;
