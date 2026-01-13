/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Agent Management Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Admin dashboard for managing agents, commissions, and credit lines
 * Real Supabase integration — no demo data
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import styles from './AgentManagementPage.module.css';
import { AgentService, type Agent } from '@/services/AgentService';
import { useUserStore } from '@/stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

type TabType = 'agents' | 'credit-limits' | 'commissions' | 'payouts';

export default function AgentManagementPage() {
    const { clubId } = useParams<{ clubId: string }>();
    const navigate = useNavigate();
    const { user } = useUserStore();
    const [activeTab, setActiveTab] = useState<TabType>('agents');
    const [agents, setAgents] = useState<Agent[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingLimit, setEditingLimit] = useState<string | null>(null);
    const [newLimit, setNewLimit] = useState<number>(0);

    // Create Agent Form State
    const [availableMembers, setAvailableMembers] = useState<{ id: string; userId: string; displayName: string }[]>([]);
    const [isCreating, setIsCreating] = useState(false);
    const [newAgentForm, setNewAgentForm] = useState({
        userId: '',
        role: 'agent' as 'super_agent' | 'agent' | 'sub_agent',
        parentAgentId: '',
        commissionRate: 50,       // Default 50%
        playerRakebackRate: 30,   // Default 30%
        creditLimit: 0,           // MANDATORY - must be set
    });

    // Load agents from Supabase
    useEffect(() => {
        if (!clubId) return;

        setIsLoading(true);
        setError(null);

        AgentService.getAgents(clubId)
            .then(setAgents)
            .catch(err => setError(err.message))
            .finally(() => setIsLoading(false));
    }, [clubId]);

    // Load available members when modal opens
    useEffect(() => {
        if (!showAddModal || !clubId) return;

        // TODO: Fetch non-agent members from MembershipService
        // For now, this will be populated when we integrate
        setAvailableMembers([]);
    }, [showAddModal, clubId]);

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

    // Direct credit limit assignment (real Supabase call)
    const handleSetCreditLimit = async (agentId: string, limit: number) => {
        if (!user?.id) return;

        const success = await AgentService.setCreditLimit(agentId, limit, user.id);
        if (success) {
            setAgents(prev => prev.map(a =>
                a.id === agentId ? { ...a, creditLimit: limit } : a
            ));
        }
        setEditingLimit(null);
    };

    // Suspend agent (real Supabase call)
    const handleSuspendAgent = async (agentId: string) => {
        const success = await AgentService.updateAgentStatus(agentId, 'suspended');
        if (success) {
            setAgents(prev => prev.map(a =>
                a.id === agentId ? { ...a, status: 'suspended' } : a
            ));
        }
    };

    // Reinstate agent (real Supabase call)
    const handleReinstateAgent = async (agentId: string) => {
        const success = await AgentService.updateAgentStatus(agentId, 'active');
        if (success) {
            setAgents(prev => prev.map(a =>
                a.id === agentId ? { ...a, status: 'active' } : a
            ));
        }
    };

    // Create new agent (real Supabase call)
    const handleCreateAgent = async () => {
        if (!clubId || !newAgentForm.userId) return;

        // Validate mandatory fields
        if (newAgentForm.creditLimit <= 0) {
            alert('Credit Limit is required and must be greater than 0');
            return;
        }
        if (newAgentForm.commissionRate <= 0 || newAgentForm.commissionRate > 70) {
            alert('Commission Rate must be between 1% and 70%');
            return;
        }
        if (newAgentForm.playerRakebackRate < 0 || newAgentForm.playerRakebackRate > 50) {
            alert('Rakeback Rate must be between 0% and 50%');
            return;
        }

        setIsCreating(true);
        try {
            const newAgent = await AgentService.createAgent({
                userId: newAgentForm.userId,
                clubId,
                role: newAgentForm.role,
                parentAgentId: newAgentForm.parentAgentId || undefined,
                commissionRate: newAgentForm.commissionRate / 100,  // Convert to decimal
                playerRakebackRate: newAgentForm.playerRakebackRate / 100,
                creditLimit: newAgentForm.creditLimit,
            });

            setAgents(prev => [newAgent, ...prev]);
            setShowAddModal(false);
            setNewAgentForm({
                userId: '',
                role: 'agent',
                parentAgentId: '',
                commissionRate: 50,
                playerRakebackRate: 30,
                creditLimit: 0,
            });
        } catch (err: any) {
            alert('Failed to create agent: ' + err.message);
        } finally {
            setIsCreating(false);
        }
    };

    // Reset form when modal closes
    const handleCloseModal = () => {
        setShowAddModal(false);
        setNewAgentForm({
            userId: '',
            role: 'agent',
            parentAgentId: '',
            commissionRate: 50,
            playerRakebackRate: 30,
            creditLimit: 0,
        });
    };

    // Loading state
    if (isLoading) {
        return (
            <div className={styles.page}>
                <div className={styles.loading}>Loading agents...</div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className={styles.page}>
                <div className={styles.error}>Error: {error}</div>
            </div>
        );
    }

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
                                        {(agent.displayName || '?').charAt(0).toUpperCase()}
                                    </div>
                                    <div className={styles.agentInfo}>
                                        <h3>{agent.displayName || 'Unknown Agent'}</h3>
                                        <div className={styles.agentMeta}>
                                            <span className={`${styles.badge} ${styles[agent.role]}`}>
                                                {agent.role === 'super_agent' ? 'Super Agent' : agent.role === 'agent' ? 'Agent' : 'Sub-Agent'}
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

            {/* ═══════════════════════════════════════════════════════════════════════════════ */}
            {/* CREATE AGENT MODAL */}
            {/* ═══════════════════════════════════════════════════════════════════════════════ */}
            {showAddModal && (
                <div className={styles.modalOverlay} onClick={handleCloseModal}>
                    <div className={styles.modal} onClick={e => e.stopPropagation()}>
                        <div className={styles.modalHeader}>
                            <h2>➕ Create New Agent</h2>
                            <button className={styles.closeBtn} onClick={handleCloseModal}>×</button>
                        </div>

                        <div className={styles.modalBody}>
                            {/* Role Selection */}
                            <div className={styles.formGroup}>
                                <label>Agent Role *</label>
                                <div className={styles.roleSelector}>
                                    <button
                                        type="button"
                                        className={`${styles.roleOption} ${newAgentForm.role === 'super_agent' ? styles.selected : ''}`}
                                        onClick={() => setNewAgentForm({ ...newAgentForm, role: 'super_agent', parentAgentId: '' })}
                                    >
                                        <span className={styles.roleIcon}>👑</span>
                                        <span className={styles.roleLabel}>Super Agent</span>
                                        <span className={styles.roleDesc}>Can have agents under them</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.roleOption} ${newAgentForm.role === 'agent' ? styles.selected : ''}`}
                                        onClick={() => setNewAgentForm({ ...newAgentForm, role: 'agent' })}
                                    >
                                        <span className={styles.roleIcon}>👔</span>
                                        <span className={styles.roleLabel}>Agent</span>
                                        <span className={styles.roleDesc}>Standard agent role</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.roleOption} ${newAgentForm.role === 'sub_agent' ? styles.selected : ''}`}
                                        onClick={() => setNewAgentForm({ ...newAgentForm, role: 'sub_agent' })}
                                    >
                                        <span className={styles.roleIcon}>🧑‍💼</span>
                                        <span className={styles.roleLabel}>Sub-Agent</span>
                                        <span className={styles.roleDesc}>Under another agent</span>
                                    </button>
                                </div>
                            </div>

                            {/* Parent Agent (for sub-agents) */}
                            {(newAgentForm.role === 'agent' || newAgentForm.role === 'sub_agent') && agents.filter(a => a.role === 'super_agent' || (newAgentForm.role === 'sub_agent' && a.role === 'agent')).length > 0 && (
                                <div className={styles.formGroup}>
                                    <label>Parent Agent {newAgentForm.role === 'sub_agent' ? '*' : '(Optional)'}</label>
                                    <select
                                        value={newAgentForm.parentAgentId}
                                        onChange={e => setNewAgentForm({ ...newAgentForm, parentAgentId: e.target.value })}
                                        className={styles.formSelect}
                                    >
                                        <option value="">Select parent agent...</option>
                                        {agents.filter(a =>
                                            a.role === 'super_agent' ||
                                            (newAgentForm.role === 'sub_agent' && a.role === 'agent')
                                        ).map(a => (
                                            <option key={a.id} value={a.id}>{a.displayName || 'Unknown'}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Commission Rate */}
                            <div className={styles.formGroup}>
                                <label>Commission Rate * <span className={styles.formHint}>(max 70%)</span></label>
                                <div className={styles.sliderGroup}>
                                    <input
                                        type="range"
                                        min="0"
                                        max="70"
                                        value={newAgentForm.commissionRate}
                                        onChange={e => setNewAgentForm({ ...newAgentForm, commissionRate: Number(e.target.value) })}
                                        className={styles.slider}
                                    />
                                    <span className={styles.sliderValue}>{newAgentForm.commissionRate}%</span>
                                </div>
                                <p className={styles.fieldDesc}>Percentage of rake this agent receives from the club</p>
                            </div>

                            {/* Rakeback Rate */}
                            <div className={styles.formGroup}>
                                <label>Player Rakeback Rate * <span className={styles.formHint}>(max 50%)</span></label>
                                <div className={styles.sliderGroup}>
                                    <input
                                        type="range"
                                        min="0"
                                        max="50"
                                        value={newAgentForm.playerRakebackRate}
                                        onChange={e => setNewAgentForm({ ...newAgentForm, playerRakebackRate: Number(e.target.value) })}
                                        className={styles.slider}
                                    />
                                    <span className={styles.sliderValue}>{newAgentForm.playerRakebackRate}%</span>
                                </div>
                                <p className={styles.fieldDesc}>Percentage of rake agent gives back to players</p>
                            </div>

                            {/* Credit Limit */}
                            <div className={styles.formGroup}>
                                <label>Credit Limit * <span className={styles.formHint}>(required)</span></label>
                                <div className={styles.creditInputGroup}>
                                    <span className={styles.currencySymbol}>$</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="1000"
                                        placeholder="Enter credit limit"
                                        value={newAgentForm.creditLimit || ''}
                                        onChange={e => setNewAgentForm({ ...newAgentForm, creditLimit: Number(e.target.value) })}
                                        className={styles.creditInput}
                                    />
                                </div>
                                <p className={styles.fieldDesc}>Maximum credit this agent can extend to players</p>
                            </div>

                            {/* Summary */}
                            <div className={styles.formSummary}>
                                <h4>📋 Agent Summary</h4>
                                <div className={styles.summaryGrid}>
                                    <div>Role: <strong>{newAgentForm.role.replace('_', ' ')}</strong></div>
                                    <div>Commission: <strong>{newAgentForm.commissionRate}%</strong></div>
                                    <div>Rakeback: <strong>{newAgentForm.playerRakebackRate}%</strong></div>
                                    <div>Credit Limit: <strong>${newAgentForm.creditLimit.toLocaleString()}</strong></div>
                                </div>
                            </div>
                        </div>

                        <div className={styles.modalFooter}>
                            <button className={styles.cancelBtn} onClick={handleCloseModal}>
                                Cancel
                            </button>
                            <button
                                className={styles.createBtn}
                                onClick={handleCreateAgent}
                                disabled={isCreating || newAgentForm.creditLimit <= 0}
                            >
                                {isCreating ? 'Creating...' : '✅ Create Agent'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
