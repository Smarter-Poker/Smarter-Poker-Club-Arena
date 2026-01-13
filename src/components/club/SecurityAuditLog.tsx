/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🛡️ SECURITY AUDIT LOG — Fair Play & Monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Security logs for detecting collusion, chip dumping, and suspicious activity.
 * - Log of critical events (IP mismatch, rapid transfers, etc.)
 * - Severity levels (Low, Medium, High, Critical)
 * - Filtering options
 */

import React, { useState } from 'react';
import './SecurityAuditLog.css';

export type LogSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AuditLogEntry {
    id: string;
    timestamp: string;
    severity: LogSeverity;
    event: string;
    details: string;
    playerA?: string;
    playerB?: string;
    tableId?: string;
}

export interface SecurityAuditLogProps {
    isOpen: boolean;
    onClose: () => void;
    logs: AuditLogEntry[];
}

export function SecurityAuditLog({
    isOpen,
    onClose,
    logs,
}: SecurityAuditLogProps) {
    const [filterSeverity, setFilterSeverity] = useState<LogSeverity | 'all'>('all');

    if (!isOpen) return null;

    const filteredLogs = logs.filter(
        (log) => filterSeverity === 'all' || log.severity === filterSeverity
    );

    return (
        <div className="audit-overlay" onClick={onClose}>
            <div className="audit-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="audit-modal__header">
                    <div className="audit-modal__title-group">
                        <span className="audit-modal__icon">🛡️</span>
                        <h2 className="audit-modal__title">Security Audit Log</h2>
                    </div>
                    <button className="audit-modal__close" onClick={onClose}>×</button>
                </div>

                {/* Toolbar */}
                <div className="audit-toolbar">
                    <span className="audit-toolbar-label">Filter Severity:</span>
                    <div className="audit-filters">
                        {['all', 'low', 'medium', 'high', 'critical'].map((sev) => (
                            <button
                                key={sev}
                                className={`audit-filter-btn ${filterSeverity === sev ? 'active' : ''} sev-${sev}`}
                                onClick={() => setFilterSeverity(sev as LogSeverity | 'all')}
                            >
                                {sev.charAt(0).toUpperCase() + sev.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Log Table */}
                <div className="audit-content">
                    <table className="audit-table">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Severity</th>
                                <th>Event</th>
                                <th>Details</th>
                                <th>Participants</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredLogs.length > 0 ? (
                                filteredLogs.map((log) => (
                                    <tr key={log.id} className={`audit-row level-${log.severity}`}>
                                        <td className="audit-time">{log.timestamp}</td>
                                        <td>
                                            <span className={`audit-badge sev-${log.severity}`}>
                                                {log.severity.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="audit-event">{log.event}</td>
                                        <td className="audit-details">{log.details}</td>
                                        <td className="audit-participants">
                                            {log.playerA && <span className="p-tag">{log.playerA}</span>}
                                            {log.playerB && <span className="p-tag">{log.playerB}</span>}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="audit-empty">No logs found matching filter.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

export default SecurityAuditLog;
