/**
 * ♠ CLUB ARENA — Anti-Collusion Detection
 * Monitor for suspicious play patterns and flag potential collusion
 */

import React, { useState, useEffect, useRef } from 'react';
import './AntiCollusionMonitor.css';

interface SuspiciousPattern {
  id: string;
  type: 'soft_play' | 'chip_dumping' | 'coordinated_betting' | 'unusual_timing' | 'same_ip';
  severity: 'low' | 'medium' | 'high';
  players: string[];
  description: string;
  timestamp: string;
  confidence: number;
  handsAnalyzed: number;
}

interface CollusionReport {
  tableId: string;
  tableName: string;
  analysisDate: string;
  handsAnalyzed: number;
  suspiciousPatterns: SuspiciousPattern[];
  riskScore: number;
}

interface AntiCollusionMonitorProps {
  tableId?: string;
  clubId?: string;
  onInvestigate?: (pattern: SuspiciousPattern) => void;
  onDismiss?: (patternId: string) => void;
}

export const AntiCollusionMonitor: React.FC<AntiCollusionMonitorProps> = ({
  tableId,
  clubId,
  onInvestigate,
  onDismiss,
}) => {
  const [reports, setReports] = useState<CollusionReport[]>([]);
  const [selectedReport, setSelectedReport] = useState<CollusionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [visibleCards, setVisibleCards] = useState<Set<number>>(new Set());
  const [visiblePatterns, setVisiblePatterns] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    loadReports();
  }, [tableId, clubId]);

  const loadReports = async () => {
    // Replaced seeded test data with dynamic initialization
    const liveReports: CollusionReport[] = [];
    setReports(liveReports);
    setVisibleCards(new Set());
    setLoading(false);
  };

  const getPatternIcon = (type: SuspiciousPattern['type']): string => {
    switch (type) {
      case 'soft_play':
        return 'SP';
      case 'chip_dumping':
        return 'CD';
      case 'coordinated_betting':
        return 'CB';
      case 'unusual_timing':
        return 'UT';
      case 'same_ip':
        return 'IP';
      default:
        return '!';
    }
  };

  const getSeverityClass = (severity: SuspiciousPattern['severity']): string => {
    return `severity-${severity}`;
  };

  const getRiskColor = (score: number): string => {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  };

  const filteredPatterns = (patterns: SuspiciousPattern[]) => {
    if (filter === 'all') return patterns;
    return patterns.filter((p) => p.severity === filter);
  };

  if (loading) {
    return (
      <div className="collusion-monitor loading">
        <div className="spinner" />
        <p>Analyzing Patterns...</p>
      </div>
    );
  }

  return (
    <div className="collusion-monitor">
      <div className="monitor-header">
        <h2>Anti-Collusion Monitor</h2>
        <div className="filter-buttons">
          {(['all', 'high', 'medium', 'low'] as const).map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Report Cards */}
      <div className="report-cards">
        {reports.map((report, i) => (
          <div
            key={report.tableId}
            className={`report-card ${selectedReport?.tableId === report.tableId ? 'selected' : ''}`}
            onClick={() => {
              setSelectedReport(report);
              setVisiblePatterns(new Set());
              staggerTimersRef.current.forEach((t) => clearTimeout(t));
              staggerTimersRef.current = filteredPatterns(report.suspiciousPatterns).map((_, pi) =>
                setTimeout(() => setVisiblePatterns((prev) => new Set(prev).add(pi)), pi * 60)
              );
            }}
            style={{
              opacity: visibleCards.has(i) ? 1 : 0,
              transform: visibleCards.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div className="report-header">
              <span className="table-name">{report.tableName}</span>
              <div className={`risk-score ${getRiskColor(report.riskScore)}`}>
                <span>{report.riskScore}</span>
                <span className="score-label">Risk</span>
              </div>
            </div>
            <div className="report-stats">
              <span>{report.handsAnalyzed} Hands</span>
              <span>{report.suspiciousPatterns.length} Flags</span>
            </div>
          </div>
        ))}
      </div>

      {/* Pattern Details */}
      {selectedReport && (
        <div className="pattern-details">
          <h3>Suspicious Patterns - {selectedReport.tableName}</h3>
          <div className="patterns-list">
            {filteredPatterns(selectedReport.suspiciousPatterns).map((pattern, i) => (
              <div
                key={pattern.id}
                className={`pattern-card ${getSeverityClass(pattern.severity)}`}
                style={{
                  opacity: visiblePatterns.has(i) ? 1 : 0,
                  transform: visiblePatterns.has(i) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="pattern-header">
                  <span className="pattern-icon">{getPatternIcon(pattern.type)}</span>
                  <span className="pattern-type">{pattern.type.replace('_', ' ')}</span>
                  <span className={`severity-badge ${pattern.severity}`}>
                    {pattern.severity.toUpperCase()}
                  </span>
                </div>
                <p className="pattern-description">{pattern.description}</p>
                <div className="pattern-players">
                  <span className="label">Players:</span>
                  {pattern.players.map((p) => (
                    <span key={p} className="player-tag">
                      {p}
                    </span>
                  ))}
                </div>
                <div className="pattern-meta">
                  <span>Confidence: {pattern.confidence}%</span>
                  <span>{pattern.handsAnalyzed} Hands Analyzed</span>
                </div>
                <div className="pattern-actions">
                  <button className="btn-investigate" onClick={() => onInvestigate?.(pattern)}>
                    Investigate
                  </button>
                  <button className="btn-dismiss" onClick={() => onDismiss?.(pattern.id)}>
                    ✕ Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!selectedReport && (
        <div className="empty-state">
          <span className="empty-icon">--</span>
          <p>Select A Table To View Detailed Analysis</p>
        </div>
      )}
    </div>
  );
};

export default AntiCollusionMonitor;
