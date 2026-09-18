import React, { useMemo, useState } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import './VIPActivityHistory.css';

const DIAMOND_ACTIVITY_ART = `${import.meta.env.BASE_URL}images/diamond-icon.webp`;

export interface DiamondActivity {
  id: string;
  date: Date;
  action: 'earned' | 'spent' | 'redeemed';
  description: string;
  diamonds: number;
  balanceAfter: number;
}

type ActivityFilter = 'all' | 'earned' | 'spent';
type ActivityState = 'loading' | 'ready' | 'error';

interface VIPActivityHistoryProps {
  activities: DiamondActivity[];
  state?: ActivityState;
  onRetry?: () => void;
}

export const VIPActivityHistory: React.FC<VIPActivityHistoryProps> = ({
  activities,
  state = 'ready',
  onRetry,
}) => {
  const [activeFilter, setActiveFilter] = useState<ActivityFilter>('all');

  const filteredActivities = useMemo(() => {
    if (activeFilter === 'all') return activities;
    if (activeFilter === 'earned') {
      return activities.filter((activity) => activity.action === 'earned');
    }
    return activities.filter(
      (activity) => activity.action === 'spent' || activity.action === 'redeemed'
    );
  }, [activities, activeFilter]);

  const monthlySummaries = useMemo(() => {
    const summaries: Record<string, { earned: number; spent: number; count: number }> = {};
    activities.forEach((activity) => {
      const monthKey = activity.date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
      });
      summaries[monthKey] ??= { earned: 0, spent: 0, count: 0 };
      if (activity.action === 'earned') summaries[monthKey].earned += activity.diamonds;
      else summaries[monthKey].spent += activity.diamonds;
      summaries[monthKey].count += 1;
    });
    return summaries;
  }, [activities]);

  const recentEarned = activities
    .filter((activity) => activity.action === 'earned')
    .reduce((sum, activity) => sum + activity.diamonds, 0);
  const recentSpent = activities
    .filter((activity) => activity.action === 'spent' || activity.action === 'redeemed')
    .reduce((sum, activity) => sum + activity.diamonds, 0);

  return (
    <section className="vip-activity-history" aria-labelledby="diamond-activity-title">
      <div className="activity-header">
        <h3 id="diamond-activity-title">Diamond Activity</h3>
        <p>Showing Up To 10 Recent Diamond Transactions</p>
      </div>

      {state === 'loading' ? (
        <div className="activity-state" role="status">
          Loading Diamond Activity
        </div>
      ) : state === 'error' ? (
        <div className="activity-state activity-state--error" role="alert">
          <p>Diamond Activity Could Not Be Verified.</p>
          {onRetry && (
            <button type="button" className="activity-retry" onClick={onRetry}>
              Retry Diamond Activity
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="activity-summary">
            <div className="summary-card earned">
              <span className="summary-label">Recent Diamonds Earned</span>
              <span className="summary-value">{recentEarned.toLocaleString()}</span>
            </div>
            <div className="summary-card spent">
              <span className="summary-label">Recent Diamonds Spent</span>
              <span className="summary-value">{recentSpent.toLocaleString()}</span>
            </div>
            <div className="summary-card count">
              <span className="summary-label">Transactions Shown</span>
              <span className="summary-value">{activities.length}</span>
            </div>
          </div>

          <div className="activity-filters" role="group" aria-label="Filter Diamond Activity">
            {(['all', 'earned', 'spent'] as ActivityFilter[]).map((filter) => (
              <button
                type="button"
                key={filter}
                className={`filter-tab ${activeFilter === filter ? 'active' : ''}`}
                aria-pressed={activeFilter === filter}
                onClick={() => setActiveFilter(filter)}
              >
                {filter === 'all'
                  ? 'All Diamond Activity'
                  : filter === 'earned'
                    ? 'Diamonds Earned'
                    : 'Diamonds Spent'}
                <span className="filter-count">
                  {filter === 'all'
                    ? activities.length
                    : filter === 'earned'
                      ? activities.filter((activity) => activity.action === 'earned').length
                      : activities.filter((activity) => activity.action !== 'earned').length}
                </span>
              </button>
            ))}
          </div>

          <div className="activity-timeline">
            {filteredActivities.length > 0 ? (
              filteredActivities.map((activity, index) => (
                <article
                  key={activity.id}
                  className={`timeline-item ${activity.action}`}
                  style={{ '--reveal-delay': `${index * 0.03}s` } as React.CSSProperties}
                >
                  <div className="timeline-marker" aria-hidden="true">
                    <img src={DIAMOND_ACTIVITY_ART} alt="" draggable={false} decoding="async" />
                  </div>
                  <div className="timeline-content">
                    <div className="activity-main">
                      <span className="activity-description">
                        {formatPopupText(activity.description)}
                      </span>
                      <span className="activity-date">
                        {activity.date.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="activity-diamonds">
                      <span className={`diamonds-value ${activity.action}`}>
                        {activity.action === 'earned' ? '+' : '-'}
                        {activity.diamonds.toLocaleString()}
                      </span>
                      <span className="diamonds-label">Diamonds</span>
                    </div>
                  </div>
                  <div className="timeline-balance">
                    <span className="balance-label">Diamond Balance</span>
                    <span className="balance-value">{activity.balanceAfter.toLocaleString()}</span>
                  </div>
                </article>
              ))
            ) : (
              <div className="no-activity">
                <p>No Diamond Activity In This Category Yet</p>
              </div>
            )}
          </div>

          {Object.keys(monthlySummaries).length > 0 && (
            <div className="monthly-summary">
              <h4>Recent Diamond Activity By Month</h4>
              <div className="summary-grid">
                {Object.entries(monthlySummaries).map(([month, summary], index) => (
                  <div
                    key={month}
                    className="month-card"
                    style={{ '--reveal-delay': `${index * 0.05}s` } as React.CSSProperties}
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
                    <span className="month-count">{summary.count} Transactions</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default VIPActivityHistory;
