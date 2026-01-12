/**
 * ♠ CLUB ARENA — Agent Management Page
 * For club owners/admins to manage agents and chip distribution
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { agentService } from '../services/AgentService';
import { clubService } from '../services/ClubService';
import type { Agent, AgentPlayer, ClubMember } from '../types/database.types';
import './AgentPage.css';

interface TransferFormData {
    targetId: string;
    amount: string;
    notes: string;
}

export default function AgentPage() {
    const { clubId } = useParams();

    const [agents, setAgents] = useState<Agent[]>([]);
    const [members, setMembers] = useState<ClubMember[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
    const [agentPlayers, setAgentPlayers] = useState<AgentPlayer[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // Transfer form
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [transferType, setTransferType] = useState<'to_agent' | 'to_player'>('to_agent');
    const [transferForm, setTransferForm] = useState<TransferFormData>({
        targetId: '',
        amount: '',
        notes: '',
    });

    // Create agent form
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showAssignModal, setShowAssignModal] = useState(false);
    const [newAgentForm, setNewAgentForm] = useState({
        userId: '',
        name: '',
        commissionRate: '10',
    });

    // Load data
    useEffect(() => {
        async function loadData() {
            if (!clubId) return;
            setIsLoading(true);
            try {
                const [agentList, memberList] = await Promise.all([
                    agentService.getAgents(clubId),
                    clubService.getMembers(clubId),
                ]);
                setAgents(agentList);
                setMembers(memberList);
            } catch (error) {
                console.error('Failed to load data:', error);
            }
            setIsLoading(false);
        }
        loadData();
    }, [clubId]);

    // Load agent's players when selected
    useEffect(() => {
        async function loadAgentPlayers() {
            if (!selectedAgent) {
                setAgentPlayers([]);
                return;
            }
            try {
                const players = await agentService.getAgentPlayers(selectedAgent.id);
                setAgentPlayers(players);
            } catch (error) {
                console.error('Failed to load agent players:', error);
            }
        }
        loadAgentPlayers();
    }, [selectedAgent]);

    // Calculate totals
    const totalAgentChips = agents.reduce((sum, a) => sum + a.chip_balance, 0);
    const totalPlayerChips = members.reduce((sum, m) => sum + m.chip_balance, 0);

    // Create agent
    const handleCreateAgent = async () => {
        if (!clubId || !newAgentForm.userId || !newAgentForm.name) return;

        try {
            const agent = await agentService.createAgent(
                clubId,
                newAgentForm.userId,
                newAgentForm.name,
                parseFloat(newAgentForm.commissionRate)
            );
            setAgents([...agents, agent]);
            setShowCreateModal(false);
            setNewAgentForm({ userId: '', name: '', commissionRate: '10' });
        } catch (error) {
            console.error('Failed to create agent:', error);
        }
    };

    // Assign player
    const handleAssignPlayer = async (memberId: string) => {
        if (!clubId || !selectedAgent) return;
        try {
            await agentService.assignPlayer(clubId, memberId, selectedAgent.id);

            // Refresh data
            const [players, allMembers] = await Promise.all([
                agentService.getAgentPlayers(selectedAgent.id),
                clubService.getMembers(clubId)
            ]);
            setAgentPlayers(players);
            setMembers(allMembers);
            setShowAssignModal(false);
        } catch (error) {
            console.error('Failed to assign player:', error);
            alert('Failed to assign player');
        }
    };

    // Transfer chips
    const handleTransfer = async () => {
        if (!clubId || !transferForm.targetId || !transferForm.amount) return;

        const amount = parseFloat(transferForm.amount);
        if (isNaN(amount) || amount <= 0) return;

        try {
            if (transferType === 'to_agent') {
                await agentService.transferToAgent(
                    clubId,
                    transferForm.targetId,
                    amount,
                    transferForm.notes
                );
                // Update agent balance locally
                setAgents(agents.map(a =>
                    a.id === transferForm.targetId
                        ? { ...a, chip_balance: a.chip_balance + amount }
                        : a
                ));
            } else if (transferType === 'to_player' && selectedAgent) {
                await agentService.transferToPlayer(
                    clubId,
                    selectedAgent.id,
                    transferForm.targetId,
                    amount,
                    transferForm.notes
                );
                // Update balances locally
                setSelectedAgent({
                    ...selectedAgent,
                    chip_balance: selectedAgent.chip_balance - amount,
                });
            }
            setShowTransferModal(false);
            setTransferForm({ targetId: '', amount: '', notes: '' });
        } catch (error) {
            console.error('Transfer failed:', error);
            alert('Transfer failed: ' + (error as Error).message);
        }
    };

    if (isLoading) {
        return (
            <div className="agent-page">
                <div className="loading">Loading agent data...</div>
            </div>
        );
    }

    return (
        <div className="agent-page">
            {/* Header */}
            <div className="agent-header">
                <div className="agent-header-left">
                    <Link to={`/clubs/${clubId}`} className="back-link">← Back to Club</Link>
                    <h1>👔 Agent Management</h1>
                    <p className="subtitle">Manage chip distribution and agents</p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                    + Add Agent
                </button>
            </div>

            {/* Stats */}
            <div className="agent-stats">
                <div className="stat-card">
                    <span className="stat-label">Total Agents</span>
                    <span className="stat-value">{agents.length}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Agent Chips</span>
                    <span className="stat-value gold">${totalAgentChips.toLocaleString()}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Player Chips</span>
                    <span className="stat-value green">${totalPlayerChips.toLocaleString()}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Total Players</span>
                    <span className="stat-value">{members.length}</span>
                </div>
            </div>

            <div className="agent-content">
                {/* Agent List */}
                <div className="agent-list-section">
                    <div className="section-header">
                        <h2>Agents</h2>
                        <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                                setTransferType('to_agent');
                                setShowTransferModal(true);
                            }}
                        >
                            💰 Send Chips
                        </button>
                    </div>

                    <div className="agent-list">
                        {agents.length === 0 ? (
                            <div className="empty-state">
                                <p>No agents yet. Create one to start distributing chips.</p>
                            </div>
                        ) : (
                            agents.map(agent => (
                                <div
                                    key={agent.id}
                                    className={`agent-card ${selectedAgent?.id === agent.id ? 'selected' : ''}`}
                                    onClick={() => setSelectedAgent(agent)}
                                >
                                    <div className="agent-avatar">👔</div>
                                    <div className="agent-info">
                                        <div className="agent-name">{agent.name}</div>
                                        <div className="agent-meta">
                                            <span>{agent.player_count} players</span>
                                            <span>{agent.commission_rate}% commission</span>
                                        </div>
                                    </div>
                                    <div className="agent-balance">
                                        ${agent.chip_balance.toLocaleString()}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Selected Agent Details */}
                <div className="agent-details-section">
                    {selectedAgent ? (
                        <>
                            <div className="section-header">
                                <h2>{selectedAgent.name}'s Players</h2>
                                <div className="header-actions">
                                    <button
                                        className="btn btn-sm btn-secondary"
                                        onClick={() => setShowAssignModal(true)}
                                    >
                                        + Assign Player
                                    </button>
                                    <button
                                        className="btn btn-sm btn-primary"
                                        onClick={() => {
                                            setTransferType('to_player');
                                            setShowTransferModal(true);
                                        }}
                                    >
                                        Send to Player
                                    </button>
                                </div>
                            </div>

                            <div className="agent-balance-display">
                                <span className="balance-label">Available Balance:</span>
                                <span className="balance-amount">${selectedAgent.chip_balance.toLocaleString()}</span>
                            </div>

                            <div className="player-list">
                                {agentPlayers.length === 0 ? (
                                    <div className="empty-state">
                                        <p>No players under this agent yet.</p>
                                    </div>
                                ) : (
                                    agentPlayers.map(player => (
                                        <div key={player.id} className="player-card">
                                            <div className="player-avatar">👤</div>
                                            <div className="player-info">
                                                <div className="player-name">{player.nickname}</div>
                                                <div className="player-meta">
                                                    {player.rakeback_percent}% rakeback
                                                </div>
                                            </div>
                                            <div className="player-balance">
                                                ${player.chip_balance.toLocaleString()}
                                            </div>
                                            <div className="player-actions">
                                                <button className="btn btn-sm btn-ghost">Send</button>
                                                <button className="btn btn-sm btn-ghost">Receive</button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="empty-state full">
                            <div className="empty-icon">👔</div>
                            <h3>Select an Agent</h3>
                            <p>Click on an agent to view their players and manage chip transfers.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Create Agent Modal */}
            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h2>Create New Agent</h2>



                        <div className="form-group">
                            <label>Select Member</label>
                            <select
                                value={newAgentForm.userId}
                                onChange={e => setNewAgentForm({ ...newAgentForm, userId: e.target.value })}
                            >
                                <option value="">Choose a member...</option>
                                {members
                                    .filter(m => m.role !== 'owner' && !agents.some(a => a.user_id === m.user_id))
                                    .map(m => (
                                        <option key={m.id} value={m.user_id}>
                                            {m.nickname || m.user_id}
                                        </option>
                                    ))
                                }
                            </select>
                        </div>

                        <div className="form-group">
                            <label>Agent Name</label>
                            <input
                                type="text"
                                placeholder="Enter agent name"
                                value={newAgentForm.name}
                                onChange={e => setNewAgentForm({ ...newAgentForm, name: e.target.value })}
                            />
                        </div>

                        <div className="form-group">
                            <label>Commission Rate (%)</label>
                            <input
                                type="number"
                                min="0"
                                max="50"
                                value={newAgentForm.commissionRate}
                                onChange={e => setNewAgentForm({ ...newAgentForm, commissionRate: e.target.value })}
                            />
                            <span className="form-hint">Percentage of rake returned to players</span>
                        </div>

                        <div className="modal-actions">
                            <button className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={handleCreateAgent}
                                disabled={!newAgentForm.userId || !newAgentForm.name}
                            >
                                Create Agent
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Assign Player Modal */}
            {showAssignModal && selectedAgent && (
                <div className="modal-overlay" onClick={() => setShowAssignModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h2>Assign Player to {selectedAgent.name}</h2>
                        <div className="member-list-scroll" style={{ maxHeight: '300px', overflowY: 'auto', margin: '1rem 0', border: '1px solid var(--border-color)', borderRadius: '0.5rem' }}>
                            {members.filter(m => !m.agent_id && m.role === 'member').length === 0 ? (
                                <p className="empty-text" style={{ padding: '1rem', textAlign: 'center' }}>No unassigned members found.</p>
                            ) : (
                                members
                                    .filter(m => !m.agent_id && m.role === 'member')
                                    .map(member => (
                                        <div key={member.id} className="member-item-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', borderBottom: '1px solid var(--border-color)', alignItems: 'center' }}>
                                            <span>{member.nickname || 'Unknown'} <small style={{ opacity: 0.7 }}>(ID: {member.user_id.substring(0, 6)})</small></span>
                                            <button
                                                className="btn btn-sm btn-primary"
                                                onClick={() => handleAssignPlayer(member.id)}
                                            >
                                                Assign
                                            </button>
                                        </div>
                                    ))
                            )}
                        </div>
                        <button className="btn btn-ghost" style={{ marginTop: '1rem', width: '100%' }} onClick={() => setShowAssignModal(false)}>Cancel</button>
                    </div>
                </div>
            )}

            {/* Transfer Modal */}
            {showTransferModal && (
                <div className="modal-overlay" onClick={() => setShowTransferModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h2>
                            {transferType === 'to_agent' ? '💰 Send Chips to Agent' : '💰 Send Chips to Player'}
                        </h2>

                        <div className="form-group">
                            <label>{transferType === 'to_agent' ? 'Select Agent' : 'Select Player'}</label>
                            <select
                                value={transferForm.targetId}
                                onChange={e => setTransferForm({ ...transferForm, targetId: e.target.value })}
                            >
                                <option value="">Choose recipient...</option>
                                {transferType === 'to_agent' ? (
                                    agents.map(a => (
                                        <option key={a.id} value={a.id}>
                                            {a.name} (${a.chip_balance.toLocaleString()})
                                        </option>
                                    ))
                                ) : (
                                    agentPlayers.map(p => (
                                        <option key={p.id} value={p.user_id}>
                                            {p.nickname} (${p.chip_balance.toLocaleString()})
                                        </option>
                                    ))
                                )}
                            </select>
                        </div>

                        <div className="form-group">
                            <label>Amount</label>
                            <input
                                type="number"
                                min="1"
                                placeholder="Enter amount"
                                value={transferForm.amount}
                                onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })}
                            />
                        </div>

                        <div className="form-group">
                            <label>Notes (optional)</label>
                            <input
                                type="text"
                                placeholder="Add a note..."
                                value={transferForm.notes}
                                onChange={e => setTransferForm({ ...transferForm, notes: e.target.value })}
                            />
                        </div>

                        <div className="modal-actions">
                            <button className="btn btn-ghost" onClick={() => setShowTransferModal(false)}>
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={handleTransfer}
                                disabled={!transferForm.targetId || !transferForm.amount}
                            >
                                Send Chips
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
