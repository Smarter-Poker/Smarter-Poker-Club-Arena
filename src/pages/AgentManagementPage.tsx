/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Agent Management Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Admin dashboard for managing agents, commissions, and credit lines
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import styles from './AgentManagementPage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Agent {
    id: string;
    displayName: string;
    avatarUrl?: string;
    role: 'agent' | 'sub_agent';
    status: 'active' | 'suspended' | 'frozen';
    parentAgentId?: string;
    parentAgentName?: string;

    // Commission rates
    commissionRate: number;      // Rate they receive from club
    playerRakebackRate: number;  // Rate they give to players

    // Wallets
    businessBalance: number;
    playerBalance: number;
    promoBalance: number;

    // Credit (assigned directly by hierarchy)
    creditLimit: number;
    creditUsed: number;
    isPrepaid: boolean;

    // Stats
    totalPlayers: number;
    activePlayerCount: number;
    weeklyRakeGenerated: number;
    lifetimeEarnings: number;

    // Dates
    joinedAt: string;
    lastActiveAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_AGENTS: Agent[] = [
    {
        id: 'a1',
        displayName: 'AgentAce',
        role: 'agent',
        status: 'active',
        commissionRate: 0.50,
        playerRakebackRate: 0.30,
        businessBalance: 12500,
        playerBalance: 5000,
        promoBalance: 500,
        creditLimit: 25000,
        creditUsed: 8500,
        isPrepaid: false,
        totalPlayers: 48,
        activePlayerCount: 23,
        weeklyRakeGenerated: 4200,
        lifetimeEarnings: 185000,
        joinedAt: '2024-06-15',
        lastActiveAt: new Date().toISOString(),
    },
    {
        id: 'a2',
        displayName: 'PokerPro',
        role: 'agent',
        status: 'active',
        commissionRate: 0.45,
        playerRakebackRate: 0.25,
        businessBalance: 8200,
        playerBalance: 3500,
        promoBalance: 200,
        creditLimit: 15000,
        creditUsed: 3200,
        isPrepaid: false,
        totalPlayers: 32,
        activePlayerCount: 15,
        weeklyRakeGenerated: 2800,
        lifetimeEarnings: 95000,
        joinedAt: '2024-09-01',
        lastActiveAt: new Date().toISOString(),
    },
    {
        id: 'a3',
        displayName: 'SharkAgent',
        role: 'sub_agent',
        status: 'suspended',
        parentAgentId: 'a1',
        parentAgentName: 'AgentAce',
        commissionRate: 0.35,
        playerRakebackRate: 0.20,
        businessBalance: 1500,
        playerBalance: 800,
        promoBalance: 0,
        creditLimit: 5000,
        creditUsed: 4800,
        isPrepaid: false,
        totalPlayers: 12,
        activePlayerCount: 4,
        weeklyRakeGenerated: 650,
        lifetimeEarnings: 22000,
        joinedAt: '2025-01-01',
        lastActiveAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'agents' | 'credit-limits' | 'commissions' | 'payouts';

export default function AgentManagementPage() {
    const { clubId } = useParams<{ clubId: string }>();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<TabType>('agents');
    const [agents, setAgents] = useState<Agent[]>(DEMO_AGENTS);
    const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingLimit, setEditingLimit] = useState<string | null>(null);
    const [newLimit, setNewLimit] = useState<number>(0);

    // Stats summary
    const totalAgents = agents.length;
    const activeAgents = agents.filter(a => a.status === 'active').length;
    const totalPlayers = agents.reduce((sum, a) => sum + a.totalPlayers, 0);
    const weeklyRake = agents.reduce((sum, a) => sum + a.weeklyRakeGenerated, 0);
    const totalCreditExtended = agents.reduce((sum, a) => sum + a.creditLimit, 0);

    // Format helpers
    const formatMoney = (amount: number) => amount.toLocaleString('en-US', { minimumFractionDigits: 2 });
    const formatPercent = (rate: number) => `${(rate * 100).toFixed(0)}%`;
    const getCreditUtilization = (agent: Agent) => agent.creditLimit > 0 ? (agent.creditUsed / agent.creditLimit) * 100 : 0;

    const getUtilizationStatus = (agent: Agent) => {
        const util = getCreditUtilization(agent);
        if (util >= 90) return 'critical';
        if (util >= 75) return 'warning';
        return 'healthy';
    };

    // Direct credit limit assignment
    const handleSetCreditLimit = (agentId: string, limit: number) => {
        setAgents(prev => prev.map(a =>
            a.id === agentId ? { ...a, creditLimit: limit } : a
        ));
        setEditingLimit(null);
    };

    const handleSuspendAgent = (agentId: string) => {
        setAgents(prev => prev.map(a =>
            a.id === agentId ? { ...a, status: 'suspended' } : a
        ));
    };

    const handleReinstateAgent = (agentId: string) => {
        setAgents(prev => prev.map(a =>
            a.id === agentId ? { ...a, status: 'active' } : a
        ));
    };

    return (
        <div className={styles.page}>
            {/* Header */}
            <header className={styles.header}>
                <button className={styles.backButton} onClick={() => navigate(-1)}>
                    ← Back
                </button>
                <div>
                    <h1>Agent Management</h1>
                    <p className={styles.subtitle}>Manage agents, commissions, and credit lines</p>
                </div>
                <button className={styles.addButton} onClick={() => setShowAddModal(true)}>
                    + Add Agent
                </button>
            </header>

            {/* Summary Cards */}
            <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                    <span className={styles.summaryIcon}>👥</span>
                    <div>
                        <span className={styles.summaryValue}>{activeAgents}/{totalAgents}</span>
                        <span className={styles.summaryLabel}>Active Agents</span>
                    </div>
                </div>
                <div className={styles.summaryCard}>
                    <span className={styles.summaryIcon}>🎮</span>
                    <div>
                        <span className={styles.summaryValue}>{totalPlayers}</span>
                        <span className={styles.summaryLabel}>Total Players</span>
                    </div>
                </div>
                <div className={styles.summaryCard}>
                    <span className={styles.summaryIcon}>💰</span>
                    <div>
                        <span className={styles.summaryValue}>${formatMoney(weeklyRake)}</span>
                        <span className={styles.summaryLabel}>Weekly Rake</span>
                    </div>
                </div>
                <div className={styles.summaryCard}>
                    <span className={styles.summaryIcon}>💳</span>
                    <div>
                        <span className={styles.summaryValue}>${formatMoney(totalCreditExtended)}</span>
                        <span className={styles.summaryLabel}>Credit Extended</span>
                    </div>
                </div>
            </div>

            {/* Tab Navigation */}
            <nav className={styles.tabNav}>
                {(['agents', 'credit-limits', 'commissions', 'payouts'] as TabType[]).map(tab => (
                    <button
                        key={tab}
                        className={`${styles.tabButton} ${activeTab === tab ? styles.active : ''}`}
                        onClick={() => setActiveTab(tab)}
                    >
                        {tab === 'agents' && '👥 Agents'}
                        {tab === 'credit-limits' && '💳 Credit Limits'}
                        {tab === 'commissions' && '💵 Commissions'}
                        {tab === 'payouts' && '📤 Payouts'}
                    </button>
                ))}
            </nav>

            {/* Tab Content */}
            <div className={styles.content}>
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* AGENTS TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'agents' && (
                    <div className={styles.agentsList}>
                        {agents.map(agent => (
                            <div
                                key={agent.id}
                                className={`${styles.agentCard} ${agent.status !== 'active' ? styles.inactive : ''}`}
                            >
                                <div className={styles.agentHeader}>
                                    <div className={styles.agentAvatar}>
                                        {agent.displayName.charAt(0).toUpperCase()}
                                    </div>
                                    <div className={styles.agentInfo}>
                                        <h3>{agent.displayName}</h3>
                                        <div className={styles.agentMeta}>
                                            <span className={`${styles.badge} ${styles[agent.role]}`}>
                                                {agent.role === 'agent' ? 'Agent' : 'Sub-Agent'}
                                            </span>
                                            <span className={`${styles.badge} ${styles[agent.status]}`}>
                                                {agent.status}
                                            </span>
                                            {agent.parentAgentName && (
                                                <span className={styles.parentAgent}>
                                                    Under: {agent.parentAgentName}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className={styles.agentActions}>
                                        {agent.status === 'active' ? (
                                            <button
                                                className={styles.actionBtn}
                                                onClick={() => handleSuspendAgent(agent.id)}
                                            >
                                                ⏸️ Suspend
                                            </button>
                                        ) : (
                                            <button
                                                className={`${styles.actionBtn} ${styles.primary}`}
                                                onClick={() => handleReinstateAgent(agent.id)}
                                            >
                                                ▶️ Reinstate
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className={styles.agentStats}>
                                    <div className={styles.statItem}>
                                        <span className={styles.statLabel}>Commission</span>
                                        <span className={styles.statValue}>{formatPercent(agent.commissionRate)}</span>
                                    </div>
                                    <div className={styles.statItem}>
                                        <span className={styles.statLabel}>Rakeback</span>
                                        <span className={styles.statValue}>{formatPercent(agent.playerRakebackRate)}</span>
                                    </div>
                                    <div className={styles.statItem}>
                                        <span className={styles.statLabel}>Players</span>
                                        <span className={styles.statValue}>{agent.activePlayerCount}/{agent.totalPlayers}</span>
                                    </div>
                                    <div className={styles.statItem}>
                                        <span className={styles.statLabel}>Weekly Rake</span>
                                        <span className={styles.statValue}>${formatMoney(agent.weeklyRakeGenerated)}</span>
                                    </div>
                                </div>

                                <div className={styles.walletRow}>
                                    <div className={styles.walletItem}>
                                        <span className={styles.walletIcon}>💼</span>
                                        <span>${formatMoney(agent.businessBalance)}</span>
                                    </div>
                                    <div className={styles.walletItem}>
                                        <span className={styles.walletIcon}>🎮</span>
                                        <span>${formatMoney(agent.playerBalance)}</span>
                                    </div>
                                    <div className={styles.walletItem}>
                                        <span className={styles.walletIcon}>🎁</span>
                                        <span>${formatMoney(agent.promoBalance)}</span>
                                    </div>
                                </div>

                                {!agent.isPrepaid && (
                                    <div className={styles.creditBar}>
                                        <div className={styles.creditHeader}>
                                            <span>Credit Line: ${formatMoney(agent.creditUsed)} / ${formatMoney(agent.creditLimit)}</span>
                                            <span className={`${styles.utilBadge} ${styles[getUtilizationStatus(agent)]}`}>
                                                {getCreditUtilization(agent).toFixed(0)}% Used
                                            </span>
                                        </div>
                                        <div className={styles.creditProgress}>
                                            <div
                                                className={`${styles.creditFill} ${styles[getUtilizationStatus(agent)]}`}
                                                style={{ width: `${Math.min(getCreditUtilization(agent), 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* CREDIT LIMITS TAB — Direct Assignment */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'credit-limits' && (
                    <div className={styles.creditLimitsSection}>
                        <div className={styles.creditHierarchy}>
                            <h2>💳 Credit Limit Assignment</h2>
                            <p>Assign credit limits directly. Clubs set limits for Agents. Agents set limits for Sub-Agents.</p>
                        </div>

                        <table className={styles.creditTable}>
                            <thead>
                                <tr>
                                    <th>Agent</th>
                                    <th>Role</th>
                                    <th>Assigned By</th>
                                    <th>Credit Limit</th>
                                    <th>Used</th>
                                    <th>Utilization</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {agents.map(agent => (
                                    <tr key={agent.id} className={agent.status !== 'active' ? styles.inactive : ''}>
                                        <td className={styles.agentCell}>{agent.displayName}</td>
                                        <td>
                                            <span className={`${styles.badge} ${styles[agent.role]}`}>
                                                {agent.role === 'agent' ? 'Agent' : 'Sub-Agent'}
                                            </span>
                                        </td>
                                        <td className={styles.assignedBy}>
                                            {agent.role === 'agent' ? '🏛️ Club' : `👤 ${agent.parentAgentName || 'Agent'}`}
                                        </td>
                                        <td>
                                            {editingLimit === agent.id ? (
                                                <input
                                                    type="number"
                                                    className={styles.limitInput}
                                                    value={newLimit}
                                                    onChange={(e) => setNewLimit(Number(e.target.value))}
                                                    autoFocus
                                                />
                                            ) : (
                                                <span className={styles.limitAmount}>${formatMoney(agent.creditLimit)}</span>
                                            )}
                                        </td>
                                        <td>${formatMoney(agent.creditUsed)}</td>
                                        <td>
                                            <span className={`${styles.utilBadge} ${styles[getUtilizationStatus(agent)]}`}>
                                                {getCreditUtilization(agent).toFixed(0)}%
                                            </span>
                                        </td>
                                        <td>
                                            {editingLimit === agent.id ? (
                                                <div className={styles.editActions}>
                                                    <button
                                                        className={`${styles.actionBtn} ${styles.approve}`}
                                                        onClick={() => handleSetCreditLimit(agent.id, newLimit)}
                                                    >
                                                        ✓ Save
                                                    </button>
                                                    <button
                                                        className={styles.actionBtn}
                                                        onClick={() => setEditingLimit(null)}
                                                    >
                                                        ✗
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    className={styles.actionBtn}
                                                    onClick={() => {
                                                        setEditingLimit(agent.id);
                                                        setNewLimit(agent.creditLimit);
                                                    }}
                                                >
                                                    ✏️ Edit
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <div className={styles.creditNote}>
                            <h3>📋 Credit Assignment Rules</h3>
                            <ul>
                                <li><strong>Club → Agent:</strong> Club Owner assigns credit limits when creating an agent</li>
                                <li><strong>Agent → Sub-Agent:</strong> Agents assign limits to their sub-agents (cannot exceed their own limit)</li>
                                <li><strong>Adjustable:</strong> Limits can be changed anytime by the assigning level</li>
                                <li><strong>Suspension:</strong> Agents at 90%+ utilization should be reviewed</li>
                            </ul>
                        </div>
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* COMMISSIONS TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'commissions' && (
                    <div className={styles.commissionsSection}>
                        <div className={styles.commissionHeader}>
                            <h2>Commission Structure</h2>
                            <p>The spread between rates determines agent profit</p>
                        </div>

                        <div className={styles.rateTable}>
                            <div className={styles.rateRow}>
                                <span className={styles.rateLabel}>Club → Agent Rate (Cap: 70%)</span>
                                <span className={styles.rateValue}>50%</span>
                            </div>
                            <div className={styles.rateRow}>
                                <span className={styles.rateLabel}>Agent → Sub-Agent Rate (Cap: 60%)</span>
                                <span className={styles.rateValue}>35%</span>
                            </div>
                            <div className={styles.rateRow}>
                                <span className={styles.rateLabel}>Agent → Player Rakeback (Cap: 50%)</span>
                                <span className={styles.rateValue}>30%</span>
                            </div>
                        </div>

                        <div className={styles.spreadExample}>
                            <h3>💡 Example Spread Calculation</h3>
                            <p>
                                Agent receives <strong>50%</strong> from club, gives <strong>30%</strong> to players.
                                <br />
                                Agent's net margin: <strong className={styles.highlight}>20%</strong> of all rake generated.
                            </p>
                        </div>
                    </div>
                )}

                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {/* PAYOUTS TAB */}
                {/* ═══════════════════════════════════════════════════════════════════════════════ */}
                {activeTab === 'payouts' && (
                    <div className={styles.payoutsSection}>
                        <div className={styles.payoutSchedule}>
                            <h2>Settlement Schedule</h2>
                            <div className={styles.scheduleGrid}>
                                <div className={styles.scheduleItem}>
                                    <span className={styles.scheduleIcon}>📸</span>
                                    <div>
                                        <strong>Sunday 11:59 PM PST</strong>
                                        <p>Snapshot & Invoice Generation</p>
                                    </div>
                                </div>
                                <div className={styles.scheduleItem}>
                                    <span className={styles.scheduleIcon}>💸</span>
                                    <div>
                                        <strong>Monday 4:00 AM PST</strong>
                                        <p>Payout Execution</p>
                                    </div>
                                </div>
                                <div className={styles.scheduleItem}>
                                    <span className={styles.scheduleIcon}>⏰</span>
                                    <div>
                                        <strong>Tuesday 11:59 PM PST</strong>
                                        <p>48-Hour Grace Period Ends</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className={styles.upcomingPayouts}>
                            <h3>Upcoming Agent Payouts</h3>
                            <table className={styles.payoutTable}>
                                <thead>
                                    <tr>
                                        <th>Agent</th>
                                        <th>Rake Generated</th>
                                        <th>Commission</th>
                                        <th>Net Payout</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {agents.filter(a => a.status === 'active').map(agent => {
                                        const commission = agent.weeklyRakeGenerated * agent.commissionRate;
                                        const rakeback = agent.weeklyRakeGenerated * agent.playerRakebackRate;
                                        const netPayout = commission - rakeback;
                                        return (
                                            <tr key={agent.id}>
                                                <td>{agent.displayName}</td>
                                                <td>${formatMoney(agent.weeklyRakeGenerated)}</td>
                                                <td>${formatMoney(commission)}</td>
                                                <td className={styles.netPayout}>${formatMoney(netPayout)}</td>
                                                <td><span className={`${styles.badge} ${styles.pending}`}>Pending</span></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
