/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT TIMELINE — Color-coded vertical timeline of past payouts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import './SettlementTimeline.css';

interface TimelineEntry {
  id: string;
  amount: number;
  netAmount: number;
  settledAt: string;
  status: 'paid' | 'pending' | 'processing' | 'failed';
  periodLabel?: string;
}

interface SettlementTimelineProps {
  entries: TimelineEntry[];
  onSelect?: (id: string) => void;
}

const STATUS_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
  paid: { color: '#00c853', icon: '✓', label: 'Settled' },
  pending: { color: '#ffa726', icon: '◷', label: 'Pending' },
  processing: { color: '#448aff', icon: '⚙', label: 'Processing' },
  failed: { color: '#ef4444', icon: '✕', label: 'Failed' },
};

export default function SettlementTimeline({ entries, onSelect }: SettlementTimelineProps) {
  if (entries.length === 0) {
    return (
      <div className="st-empty">
        <span className="st-empty-icon">◆</span>
        <span className="st-empty-text">No Settlement History Yet</span>
      </div>
    );
  }

  return (
    <div className="settlement-timeline">
      <h3 className="st-heading">Settlement History</h3>
      <div className="st-list">
        {entries.map((entry, i) => {
          const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.pending;
          const isLast = i === entries.length - 1;
          return (
            <div
              key={entry.id}
              className="st-item"
              onClick={() => onSelect?.(entry.id)}
              role="button"
              tabIndex={0}
            >
              {/* Timeline node */}
              <div className="st-node-col">
                <div
                  className={`st-node ${entry.status}`}
                  style={{ borderColor: cfg.color, background: `${cfg.color}20` }}
                >
                  <span className="st-node-icon">{cfg.icon}</span>
                </div>
                {!isLast && <div className="st-line" />}
              </div>

              {/* Content */}
              <div className="st-content">
                <div className="st-content-header">
                  <span className="st-amount">{entry.netAmount.toLocaleString()} Chips</span>
                  <span className="st-status" style={{ color: cfg.color }}>
                    {cfg.label}
                  </span>
                </div>
                <span className="st-date">
                  {new Date(entry.settledAt).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
                {entry.periodLabel && <span className="st-period">{entry.periodLabel}</span>}
              </div>

              {/* Chevron */}
              <span className="st-chevron">›</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
