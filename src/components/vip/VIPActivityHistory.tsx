/**
 * VIPActivityHistory — Timeline of point earning and spending
 * Tracks all VIP activities with filtering and monthly summaries
 */

import React, { useState, useMemo } from 'react';
import './VIPActivityHistory.css';

export interface VIPActivity {
  id: string;
  date: Date;
  action: 'earned' | 'spent' | 'redeemed';
  description: string;
  points: number;
  balanceAfter: number;
  icon: string;
}

type ActivityFilter = 'all' | 'earned' | 'spent';

interface VIPActivityHistoryProps {
  activities: VIPActivity[];
}

const getActivityColor = (action: VIPActivity['action']) => {
  switch (action) {
    case 'earned':
      return '#4ADE80';
    case 'spent':
    case 'redeemed':
      return '#FFD700';
    default:
      return 'rgba(255, 255, 255, 0.5)';
  }
};

const getActivityIcon = (action: VIPActivity['action']) => {
  switch (action) {
    case 'earned':
      return '⬆';
    case 'spent':
    case 'redeemed':
      return '⬇';
    default:
      return '●';
  }
};

export const VIPActivityHistory: React.FC<VIPActivityHistoryProps> = ({ activities }) => {
  const [activeFilter, setActiveFilter] = useState<ActivityFilter>('all');

  const filteredActivities = useMemo(() => {
    if (activeFilter === 'all') return activities;
    if (activeFilter === 'earned') return activities.filter((a) => a.action === 'earned');
    return activities.filter((a) => a.action === 'spent' || a.action === 'redeemed');
  }, [activities, activeFilter]);

  // Calculate monthly summaries
  const monthlySummaries = useMemo(() => {
    const summaries: Record<string, { earned: number; spent: number; count: number }> = {};

    activities.forEach((activity) => {
      const monthKey = new Date(activity.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
      });

      if (!summaries[monthKey]) {
        summaries[monthKey] = { earned: 0, spent: 0, count: 0 };
      }

      if (activity.action === 'earned') {
        summaries[monthKey].earned += activity.points;
      } else {
        summaries[monthKey].spent += activity.points;
      }
      summaries[monthKey].count++;
    });

    return summaries;
  }, [activities]);

  const totalEarned = activities
    .filter((a) => a.action === 'earned')
    .reduce((sum, a) => sum + a.points, 0);

  const totalSpent = activities
    .filter((a) => a.action === 'spent' || a.action === 'redeemed')
    .reduce((sum, a) => sum + a.points, 0);

  return (
    <div className="vip-activity-history">
      {/* Header */}
      <div className="activity-header">
        <h3>Activity History</h3>
        <p>Track Your VIP Points Earnings And Redemptions</p>
      </div>

      {/* Summary Stats */}
      <div className="activity-summary">
        <div className="summary-card earned">
          <span className="summary-label">Total Earned</span>
          <span className="summary-value">{totalEarned.toLocaleString()}</span>
        </div>
        <div className="summary-card spent">
          <span className="summary-label">Total Spent</span>
          <span className="summary-value">{totalSpent.toLocaleString()}</span>
        </div>
        <div className="summary-card count">
          <span className="summary-label">Total Activities</span>
          <span className="summary-value">{activities.length}</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="activity-filters">
        {(['all', 'earned', 'spent'] as ActivityFilter[]).map((filter) => (
          <button
            key={filter}
            className={`filter-tab ${activeFilter === filter ? 'active' : ''}`}
            onClick={() => setActiveFilter(filter)}
          >
            {filter === 'all' && 'All Activity'}
            {filter === 'earned' && 'Points Earned'}
            {filter === 'spent' && 'Points Spent'}
            <span className="filter-count">
              {activeFilter === 'all'
                ? activities.length
                : filter === 'earned'
                  ? activities.filter((a) => a.action === 'earned').length
                  : activities.filter((a) => a.action !== 'earned').length}
            </span>
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="activity-timeline">
        {filteredActivities.length > 0 ? (
          filteredActivities.map((activity, idx) => (
            <div
              key={activity.id}
              className={`timeline-item ${activity.action}`}
              style={{ '--reveal-delay': `${idx * 0.03}s` } as React.CSSProperties}
            >
              <div
                className="timeline-marker"
                style={{ '--color': getActivityColor(activity.action) } as React.CSSProperties}
              >
                <span className="marker-icon">{activity.icon}</span>
              </div>

              <div className="timeline-content">
                <div className="activity-main">
                  <span className="activity-description">{activity.description}</span>
                  <span className="activity-date">
                    {activity.date.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                <div className="activity-points">
                  <span
                    className={`points-value ${activity.action}`}
                    style={{ color: getActivityColor(activity.action) }}
                  >
                    {activity.action === 'earned' ? '+' : '−'}
                    {activity.points.toLocaleString()}
                  </span>
                  <span className="points-label">Pts</span>
                </div>
              </div>

              <div className="timeline-balance">
                <span className="balance-label">Balance</span>
                <span className="balance-value">{activity.balanceAfter.toLocaleString()}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="no-activity">
            <span className="no-activity-icon">◆</span>
            <p>No Activity In This Category Yet</p>
          </div>
        )}
      </div>

      {/* Monthly Summary */}
      {Object.keys(monthlySummaries).length > 0 && (
        <div className="monthly-summary">
          <h4>Monthly Summary</h4>
          <div className="summary-grid">
            {Object.entries(monthlySummaries).map(([month, summary], idx) => (
              <div
                key={month}
                className="month-card"
                style={{ '--reveal-delay': `${idx * 0.05}s` } as React.CSSProperties}
              >
                <span className="month-label">{month}</span>
                <div className="month-stats">
                  <div className="month-stat">
                    <span className="stat-value earned">{summary.earned.toLocaleString()}</span>
                    <span className="stat-label">Earned</span>
                  </div>
                  <div className="month-stat">
                    <span className="stat-value spent">{summary.spent.toLocaleString()}</span>
                    <span className="stat-label">Spent</span>
                  </div>
                </div>
                <span className="month-count">{summary.count} Activities</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VIPActivityHistory;
