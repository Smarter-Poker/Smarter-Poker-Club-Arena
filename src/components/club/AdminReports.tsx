/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📊 ADMIN REPORTS — Club Analytics
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Detailed reports for club admins:
 * - Date range selector
 * - Gross Rake, Jackpot Fees, Insurance Profit
 * - Agent performance table
 * - Player activity summary
 */

import React, { useState } from 'react';
import './AdminReports.css';

export interface ReportSummary {
    totalHands: number;
    grossRake: number;
    jackpotFees: number;
    insuranceProfit: number;
    totalTips: number;
}

export interface AgentPerformance {
    agentId: string;
    agentName: string;
    playersInvited: number;
    totalRakeGenerated: number;
    commission: number;
}

export interface AdminReportsProps {
    isOpen: boolean;
    onClose: () => void;
    summary: ReportSummary;
    agents: AgentPerformance[];
    currency?: string;
    onDateChange: (range: 'today' | 'week' | 'month') => void;
    onExport: () => void;
}

export function AdminReports({
    isOpen,
    onClose,
    summary,
    agents,
    currency = '💎',
    onDateChange,
    onExport,
}: AdminReportsProps) {
    const [dateRange, setDateRange] = useState<'today' | 'week' | 'month'>('week');

    if (!isOpen) return null;

    const handleRangeChange = (range: 'today' | 'week' | 'month') => {
        setDateRange(range);
        onDateChange(range);
    };

    return (
        <div className="reports-overlay" onClick={onClose}>
            <div className="reports-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="reports-modal__header">
                    <div className="reports-modal__title-group">
                        <span className="reports-modal__icon">📊</span>
                        <h2 className="reports-modal__title">Club Reports</h2>
                    </div>
                    <button className="reports-modal__close" onClick={onClose}>×</button>
                </div>

                {/* Toolbar */}
                <div className="reports-toolbar">
                    <div className="reports-ranges">
                        <button
                            className={`range-btn ${dateRange === 'today' ? 'active' : ''}`}
                            onClick={() => handleRangeChange('today')}
                        >
                            Today
                        </button>
                        <button
                            className={`range-btn ${dateRange === 'week' ? 'active' : ''}`}
                            onClick={() => handleRangeChange('week')}
                        >
                            This Week
                        </button>
                        <button
                            className={`range-btn ${dateRange === 'month' ? 'active' : ''}`}
                            onClick={() => handleRangeChange('month')}
                        >
                            This Month
                        </button>
                    </div>
                    <button className="export-btn" onClick={onExport}>
                        📥 Export CSV
                    </button>
                </div>

                <div className="reports-content">
                    {/* Summary Cards */}
                    <div className="reports-summary">
                        <div className="summary-card">
                            <span className="summary-label">Total Hands</span>
                            <span className="summary-value">{summary.totalHands.toLocaleString()}</span>
                        </div>
                        <div className="summary-card">
                            <span className="summary-label">Gross Rake</span>
                            <span className="summary-value">{currency}{summary.grossRake.toLocaleString()}</span>
                        </div>
                        <div className="summary-card">
                            <span className="summary-label">Jackpot Fees</span>
                            <span className="summary-value">{currency}{summary.jackpotFees.toLocaleString()}</span>
                        </div>
                        <div className="summary-card">
                            <span className="summary-label">Insurance P/L</span>
                            <span className="summary-value profit">
                                {summary.insuranceProfit >= 0 ? '+' : ''}
                                {currency}{summary.insuranceProfit.toLocaleString()}
                            </span>
                        </div>
                    </div>

                    {/* Agent Table */}
                    <div className="reports-section">
                        <h3 className="section-title">Agent Performance</h3>
                        <div className="reports-table-container">
                            <table className="reports-table">
                                <thead>
                                    <tr>
                                        <th>Agent</th>
                                        <th>Players</th>
                                        <th>Rake Generated</th>
                                        <th>Commission</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {agents.length > 0 ? (
                                        agents.map((agent) => (
                                            <tr key={agent.agentId}>
                                                <td className="agent-name">{agent.agentName}</td>
                                                <td className="text-center">{agent.playersInvited}</td>
                                                <td className="text-right">{currency}{agent.totalRakeGenerated.toLocaleString()}</td>
                                                <td className="text-right commission">{currency}{agent.commission.toLocaleString()}</td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan={4} className="empty-row">No agent data for this period</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AdminReports;
