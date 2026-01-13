/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Settlement Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Weekly settlement management for clubs and unions
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import styles from './SettlementPage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface SettlementPeriod {
    id: string;
    periodNumber: number;
    year: number;
    startAt: string;
    endAt: string;
    status: 'open' | 'processing' | 'settled';
    totalRake: number;
    totalBBJ: number;
    totalHands: number;
    totalPlayers: number;
}

interface ClubWire {
    clubId: string;
    clubName: string;
    netPlayerPL: number;
    grossRake: number;
    unionTax: number;
    agentCommissions: number;
    finalWire: number;
    direction: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION';
    status: 'pending' | 'processed';
}

interface AgentPayout {
    agentId: string;
    agentName: string;
    rakeGenerated: number;
    commissionRate: number;
    grossCommission: number;
    playerRakeback: number;
    netPayout: number;
    status: 'pending' | 'approved' | 'paid';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_PERIODS: SettlementPeriod[] = [
    {
        id: 'p_current',
        periodNumber: 3,
        year: 2026,
        startAt: '2026-01-13T00:00:00Z',
        endAt: '2026-01-19T23:59:59Z',
        status: 'open',
        totalRake: 28450,
        totalBBJ: 2845,
        totalHands: 42560,
        totalPlayers: 892,
    },
    {
        id: 'p_2',
        periodNumber: 2,
        year: 2026,
        startAt: '2026-01-06T00:00:00Z',
        endAt: '2026-01-12T23:59:59Z',
        status: 'settled',
        totalRake: 31200,
        totalBBJ: 3120,
        totalHands: 48900,
        totalPlayers: 945,
    },
    {
        id: 'p_1',
        periodNumber: 1,
        year: 2026,
        startAt: '2025-12-30T00:00:00Z',
        endAt: '2026-01-05T23:59:59Z',
        status: 'settled',
        totalRake: 24800,
        totalBBJ: 2480,
        totalHands: 38500,
        totalPlayers: 812,
    },
];

const DEMO_CLUB_WIRES: ClubWire[] = [
    {
        clubId: 'c1',
        clubName: 'Diamond Club',
        netPlayerPL: 12500,
        grossRake: 8200,
        unionTax: 820,
        agentCommissions: 3280,
        finalWire: 16600,
        direction: 'COLLECT_FROM_UNION',
        status: 'pending',
    },
    {
        clubId: 'c2',
        clubName: 'High Rollers',
        netPlayerPL: -8900,
        grossRake: 6100,
        unionTax: 610,
        agentCommissions: 2440,
        finalWire: -4010,
        direction: 'PAY_TO_UNION',
        status: 'pending',
    },
    {
        clubId: 'c3',
        clubName: 'Ace High',
        netPlayerPL: 3200,
        grossRake: 4800,
        unionTax: 480,
        agentCommissions: 1920,
        finalWire: 5600,
        direction: 'COLLECT_FROM_UNION',
        status: 'pending',
    },
];

const DEMO_AGENT_PAYOUTS: AgentPayout[] = [
    {
        agentId: 'a1',
        agentName: 'AgentAce',
        rakeGenerated: 4200,
        commissionRate: 0.50,
        grossCommission: 2100,
        playerRakeback: 1260,
        netPayout: 840,
        status: 'approved',
    },
    {
        agentId: 'a2',
        agentName: 'PokerPro',
        rakeGenerated: 2800,
        commissionRate: 0.45,
        grossCommission: 1260,
        playerRakeback: 700,
        netPayout: 560,
        status: 'approved',
    },
    {
        agentId: 'a3',
        agentName: 'SharkAgent',
        rakeGenerated: 650,
        commissionRate: 0.35,
        grossCommission: 227.50,
        playerRakeback: 130,
        netPayout: 97.50,
        status: 'pending',
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'overview' | 'club-wires' | 'agent-payouts' | 'history';

export default function SettlementPage() {
    const { unionId } = useParams<{ unionId: string }>();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<TabType>('overview');
    const [selectedPeriod, setSelectedPeriod] = useState<SettlementPeriod>(DEMO_PERIODS[0]);
    const [clubWires, setClubWires] = useState<ClubWire[]>(DEMO_CLUB_WIRES);
    const [agentPayouts, setAgentPayouts] = useState<AgentPayout[]>(DEMO_AGENT_PAYOUTS);
    const [isProcessing, setIsProcessing] = useState(false);

    // Calculate totals
    const totalToCollect = clubWires
        .filter(w => w.direction === 'PAY_TO_UNION')
        .reduce((sum, w) => sum + Math.abs(w.finalWire), 0);
    const totalToDistribute = clubWires
        .filter(w => w.direction === 'COLLECT_FROM_UNION')
        .reduce((sum, w) => sum + w.finalWire, 0);
    const netPosition = totalToDistribute - totalToCollect;
    const totalAgentPayouts = agentPayouts.reduce((sum, a) => sum + a.netPayout, 0);

    const formatMoney = (amount: number) => {
        const prefix = amount < 0 ? '-$' : '$';
        return prefix + Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2 });
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const handleExecutePayouts = async () => {
        setIsProcessing(true);
        // Simulate processing
        await new Promise(r => setTimeout(r, 2000));
        setAgentPayouts(prev => prev.map(a => ({ ...a, status: 'paid' })));
        setClubWires(prev => prev.map(w => ({ ...w, status: 'processed' })));
        setIsProcessing(false);
    };

    return (
        <div className={styles.page}>
            {/* Header */}
            <header className={styles.header}>
                <button className={styles.backButton} onClick={() => navigate(-1)}>
                    ← Back
                </button>
                <div className={styles.headerContent}>
                    <h1>Settlement Center</h1>
                    <p className={styles.subtitle}>
                        Period {selectedPeriod.periodNumber}/{selectedPeriod.year} • {formatDate(selectedPeriod.startAt)} - {formatDate(selectedPeriod.endAt)}
                    </p>
                </div>
                <div className={`${styles.statusBadge} ${styles[selectedPeriod.status]}`}>
                    {selectedPeriod.status === 'open' && '🟢 Open'}
                    {selectedPeriod.status === 'processing' && '🟡 Processing'}
                    {selectedPeriod.status === 'settled' && '✅ Settled'}
                </div>
            </header>

            {/* Key Metrics */}
            <div className={styles.metricsGrid}>
                <div className={styles.metricCard}>
                    <span className={styles.metricIcon}>💰</span>
                    <div>
                        <span className={styles.metricValue}>{formatMoney(selectedPeriod.totalRake)}</span>
                        <span className={styles.metricLabel}>Total Rake</span>
                    </div>
                </div>
                <div className={styles.metricCard}>
                    <span className={styles.metricIcon}>🎰</span>
                    <div>
                        <span className={styles.metricValue}>{formatMoney(selectedPeriod.totalBBJ)}</span>
                        <span className={styles.metricLabel}>BBJ Collected</span>
                    </div>
                </div>
                <div className={styles.metricCard}>
                    <span className={styles.metricIcon}>🃏</span>
                    <div>
                        <span className={styles.metricValue}>{selectedPeriod.totalHands.toLocaleString()}</span>
                        <span className={styles.metricLabel}>Hands Dealt</span>
                    </div>
                </div>
                <div className={styles.metricCard}>
                    <span className={styles.metricIcon}>👥</span>
                    <div>
                        <span className={styles.metricValue}>{selectedPeriod.totalPlayers.toLocaleString()}</span>
                        <span className={styles.metricLabel}>Active Players</span>
                    </div>
                </div>
            </div>

            {/* Settlement Summary */}
            <div className={styles.settlementSummary}>
                <div className={styles.summaryBox}>
                    <span className={styles.summaryLabel}>Clubs Owe Union</span>
                    <span className={`${styles.summaryValue} ${styles.negative}`}>{formatMoney(totalToCollect)}</span>
                </div>
                <div className={styles.summaryDivider}>⟷</div>
                <div className={styles.summaryBox}>
                    <span className={styles.summaryLabel}>Union Owes Clubs</span>
                    <span className={`${styles.summaryValue} ${styles.positive}`}>{formatMoney(totalToDistribute)}</span>
                </div>
                <div className={styles.summaryDivider}>=</div>
                <div className={styles.summaryBox}>
                    <span className={styles.summaryLabel}>Net Position</span>
                    <span className={`${styles.summaryValue} ${netPosition >= 0 ? styles.positive : styles.negative}`}>
                        {formatMoney(netPosition)}
                    </span>
                </div>
            </div>

            {/* Tab Navigation */}
            <nav className={styles.tabNav}>
                {(['overview', 'club-wires', 'agent-payouts', 'history'] as TabType[]).map(tab => (
                    <button
                        key={tab}
                        className={`${styles.tabButton} ${activeTab === tab ? styles.active : ''}`}
                        onClick={() => setActiveTab(tab)}
                    >
                        {tab === 'overview' && '📊 Overview'}
                        {tab === 'club-wires' && '🏛️ Club Wires'}
                        {tab === 'agent-payouts' && '👥 Agent Payouts'}
                        {tab === 'history' && '📜 History'}
                    </button>
                ))}
            </nav>

            {/* Tab Content */}
            <div className={styles.content}>
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* OVERVIEW TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'overview' && (
                    <div className={styles.overviewSection}>
                        <div className={styles.formulaCard}>
                            <h3>💡 Settlement Formula</h3>
                            <div className={styles.formula}>
                                <code>FINAL WIRE = (Net Player P/L) + (Gross Rake) - (Union Tax 10%)</code>
                            </div>
                            <p className={styles.formulaNote}>
                                Positive wire → Union pays Club<br />
                                Negative wire → Club pays Union
                            </p>
                        </div>

                        <div className={styles.timelineCard}>
                            <h3>⏰ Settlement Timeline</h3>
                            <div className={styles.timeline}>
                                <div className={`${styles.timelineItem} ${styles.completed}`}>
                                    <span className={styles.timelineDot}>✓</span>
                                    <div>
                                        <strong>Week Start</strong>
                                        <p>Monday 12:00 AM UTC</p>
                                    </div>
                                </div>
                                <div className={`${styles.timelineItem} ${styles.active}`}>
                                    <span className={styles.timelineDot}>●</span>
                                    <div>
                                        <strong>Active Settlement</strong>
                                        <p>Rake & P/L tracking in progress</p>
                                    </div>
                                </div>
                                <div className={styles.timelineItem}>
                                    <span className={styles.timelineDot}>○</span>
                                    <div>
                                        <strong>Sunday Snapshot</strong>
                                        <p>11:59:59 PM PST — Invoice generation</p>
                                    </div>
                                </div>
                                <div className={styles.timelineItem}>
                                    <span className={styles.timelineDot}>○</span>
                                    <div>
                                        <strong>Monday Payouts</strong>
                                        <p>4:00 AM PST — Commission injection</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {selectedPeriod.status === 'open' && (
                            <div className={styles.actionBar}>
                                <button
                                    className={styles.executeButton}
                                    onClick={handleExecutePayouts}
                                    disabled={isProcessing}
                                >
                                    {isProcessing ? '⏳ Processing...' : '🚀 Execute Settlement'}
                                </button>
                                <p className={styles.actionNote}>
                                    This will finalize all wires and process agent payouts
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* CLUB WIRES TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'club-wires' && (
                    <div className={styles.wiresSection}>
                        <table className={styles.wireTable}>
                            <thead>
                                <tr>
                                    <th>Club</th>
                                    <th>Net Player P/L</th>
                                    <th>Gross Rake</th>
                                    <th>Union Tax (10%)</th>
                                    <th>Agent Comm.</th>
                                    <th>Final Wire</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {clubWires.map(wire => (
                                    <tr key={wire.clubId}>
                                        <td className={styles.clubCell}>{wire.clubName}</td>
                                        <td className={wire.netPlayerPL >= 0 ? styles.positive : styles.negative}>
                                            {formatMoney(wire.netPlayerPL)}
                                        </td>
                                        <td>{formatMoney(wire.grossRake)}</td>
                                        <td className={styles.muted}>-{formatMoney(wire.unionTax)}</td>
                                        <td className={styles.muted}>-{formatMoney(wire.agentCommissions)}</td>
                                        <td className={`${styles.wireAmount} ${wire.finalWire >= 0 ? styles.positive : styles.negative}`}>
                                            {formatMoney(wire.finalWire)}
                                            <span className={styles.wireDirection}>
                                                {wire.direction === 'COLLECT_FROM_UNION' ? '← Union Pays' : '→ Club Pays'}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`${styles.badge} ${styles[wire.status]}`}>
                                                {wire.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* AGENT PAYOUTS TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'agent-payouts' && (
                    <div className={styles.payoutsSection}>
                        <div className={styles.payoutSummary}>
                            <span>Total Agent Payouts This Period:</span>
                            <strong className={styles.positive}>{formatMoney(totalAgentPayouts)}</strong>
                        </div>

                        <table className={styles.payoutTable}>
                            <thead>
                                <tr>
                                    <th>Agent</th>
                                    <th>Rake Generated</th>
                                    <th>Commission Rate</th>
                                    <th>Gross Commission</th>
                                    <th>Player Rakeback</th>
                                    <th>Net Payout</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {agentPayouts.map(payout => (
                                    <tr key={payout.agentId}>
                                        <td className={styles.agentCell}>{payout.agentName}</td>
                                        <td>{formatMoney(payout.rakeGenerated)}</td>
                                        <td>{(payout.commissionRate * 100).toFixed(0)}%</td>
                                        <td>{formatMoney(payout.grossCommission)}</td>
                                        <td className={styles.muted}>-{formatMoney(payout.playerRakeback)}</td>
                                        <td className={`${styles.netAmount} ${styles.positive}`}>
                                            {formatMoney(payout.netPayout)}
                                        </td>
                                        <td>
                                            <span className={`${styles.badge} ${styles[payout.status]}`}>
                                                {payout.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <div className={styles.payoutNote}>
                            <p>
                                💡 <strong>Net Payout</strong> = Gross Commission - Player Rakeback (the spread agent keeps)
                            </p>
                        </div>
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* HISTORY TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'history' && (
                    <div className={styles.historySection}>
                        <div className={styles.periodList}>
                            {DEMO_PERIODS.map(period => (
                                <div
                                    key={period.id}
                                    className={`${styles.periodCard} ${selectedPeriod.id === period.id ? styles.selected : ''}`}
                                    onClick={() => setSelectedPeriod(period)}
                                >
                                    <div className={styles.periodHeader}>
                                        <span className={styles.periodNumber}>Week {period.periodNumber}</span>
                                        <span className={`${styles.badge} ${styles[period.status]}`}>
                                            {period.status}
                                        </span>
                                    </div>
                                    <p className={styles.periodDates}>
                                        {formatDate(period.startAt)} - {formatDate(period.endAt)}
                                    </p>
                                    <div className={styles.periodStats}>
                                        <span>{formatMoney(period.totalRake)} rake</span>
                                        <span>•</span>
                                        <span>{period.totalHands.toLocaleString()} hands</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
