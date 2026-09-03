/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SecurityDashboard — Club Security Overview Widget
 *  Displays security score, recent activity, threat indicators.
 *  Designed to be embedded in ClubDetailPage operations tab.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useMemo } from 'react';
import CircularGauge from '../common/CircularGauge';

interface SecurityDashboardProps {
  memberCount: number;
  onlineCount: number;
  agentCount: number;
  isPublic: boolean;
  requiresApproval: boolean;
}

interface SecurityCheck {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export default function SecurityDashboard({
  memberCount,
  onlineCount,
  agentCount,
  isPublic,
  requiresApproval,
}: SecurityDashboardProps) {
  const [expanded, setExpanded] = useState(false);

  const checks = useMemo<SecurityCheck[]>(() => {
    const list: SecurityCheck[] = [];

    // Approval gate
    list.push({
      label: 'Member Approval',
      status: requiresApproval ? 'pass' : 'warn',
      detail: requiresApproval
        ? 'New members require approval'
        : 'Auto-join enabled - consider requiring approval',
    });

    // Privacy
    list.push({
      label: 'Club Privacy',
      status: isPublic ? 'warn' : 'pass',
      detail: isPublic ? 'Club is publicly discoverable' : 'Club is private - invite only',
    });

    // Agent coverage
    const agentRatio = memberCount > 0 ? agentCount / memberCount : 0;
    list.push({
      label: 'Agent Coverage',
      status: agentRatio > 0.1 ? 'pass' : agentRatio > 0.05 ? 'warn' : 'fail',
      detail: `${agentCount} agent${agentCount !== 1 ? 's' : ''} for ${memberCount} members (${(agentRatio * 100).toFixed(1)}%)`,
    });

    // Activity ratio
    const activityRatio = memberCount > 0 ? onlineCount / memberCount : 0;
    list.push({
      label: 'Activity Health',
      status: activityRatio > 0.15 ? 'pass' : activityRatio > 0.05 ? 'warn' : 'fail',
      detail: `${onlineCount} online of ${memberCount} (${(activityRatio * 100).toFixed(0)}% active)`,
    });

    return list;
  }, [memberCount, onlineCount, agentCount, isPublic, requiresApproval]);

  const score = useMemo(() => {
    const points = checks.reduce(
      (sum, c) => sum + (c.status === 'pass' ? 25 : c.status === 'warn' ? 15 : 0),
      0
    );
    return Math.min(100, points);
  }, [checks]);

  const statusColors = { pass: '#22c55e', warn: '#f59e0b', fail: '#ef4444' };
  const statusIcons = { pass: '✓', warn: '⚠', fail: '✕' };

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <CircularGauge
          value={score}
          label=""
          accent={score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444'}
          size={64}
          strokeWidth={5}
        />
        <div>
          <h4 style={{ margin: 0, color: '#fff', fontSize: '0.9rem' }}>Security Score</h4>
          <span
            style={{
              fontSize: '0.7rem',
              color: score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444',
            }}
          >
            {score >= 70 ? 'Good' : score >= 40 ? 'Needs Attention' : 'Critical'}
          </span>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            marginLeft: 'auto',
            padding: '0.4rem 0.8rem',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            color: '#aaa',
            fontSize: '0.7rem',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide Details' : 'View Details'}
        </button>
      </div>

      {/* Quick Status */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {checks.map((c) => (
          <span
            key={c.label}
            style={{
              padding: '0.3rem 0.6rem',
              borderRadius: '8px',
              fontSize: '0.65rem',
              fontWeight: 600,
              background: `${statusColors[c.status]}15`,
              color: statusColors[c.status],
              border: `1px solid ${statusColors[c.status]}30`,
            }}
          >
            {statusIcons[c.status]} {c.label}
          </span>
        ))}
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            paddingTop: '0.5rem',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {checks.map((c) => (
            <div
              key={c.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.5rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  background: `${statusColors[c.status]}20`,
                  color: statusColors[c.status],
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {statusIcons[c.status]}
              </span>
              <div>
                <span
                  style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 500, display: 'block' }}
                >
                  {c.label}
                </span>
                <span style={{ color: '#6a7a8a', fontSize: '0.65rem' }}>{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
