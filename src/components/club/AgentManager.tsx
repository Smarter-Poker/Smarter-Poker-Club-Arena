/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🕴️ AGENT MANAGER — Hierarchy & Commission
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manage club agents and uplines:
 * - Tree view of agent hierarchy
 * - Invite link tracking
 * - Commission structure configuration
 * - Agent performance metrics
 */

import React, { useState } from 'react';
import './AgentManager.css';

export interface AgentNode {
    id: string;
    name: string;
    level: 'Upline' | 'Agent' | 'Sub-Agent';
    players: number;
    totalRake: number;
    commissionRate: number; // Percentage (e.g. 40)
    downline: AgentNode[];
}

export interface AgentManagerProps {
    isOpen: boolean;
    onClose: () => void;
    agents: AgentNode[];
    currency?: string;
    onUpdateRate: (agentId: string, rate: number) => void;
    onRemoveAgent: (agentId: string) => void;
}

export function AgentManager({
    isOpen,
    onClose,
    agents,
    currency = '💎',
    onUpdateRate,
    onRemoveAgent,
}: AgentManagerProps) {
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    if (!isOpen) return null;

    const toggleExpand = (id: string) => {
        const next = new Set(expandedNodes);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setExpandedNodes(next);
    };

    const renderNode = (node: AgentNode, depth = 0) => {
        const isExpanded = expandedNodes.has(node.id);
        const hasChildren = node.downline && node.downline.length > 0;

        return (
            <div key={node.id} className="agent-node-wrapper">
                <div className="agent-row" style={{ paddingLeft: `${depth * 24 + 16}px` }}>
                    {/* Collapse/Expand Toggle */}
                    <button
                        className={`tree-toggle ${hasChildren ? 'visible' : ''} ${isExpanded ? 'open' : ''}`}
                        onClick={() => hasChildren && toggleExpand(node.id)}
                    >
                        ▶
                    </button>

                    {/* Agent Info */}
                    <div className="agent-info">
                        <span className="agent-name">{node.name}</span>
                        <span className={`agent-badge level-${node.level.toLowerCase().replace(' ', '-')}`}>
                            {node.level}
                        </span>
                    </div>

                    {/* Metrics */}
                    <div className="agent-metrics">
                        <div className="metric">
                            <span className="metric-label">Players</span>
                            <span className="metric-val">{node.players}</span>
                        </div>
                        <div className="metric">
                            <span className="metric-label">Total Rake</span>
                            <span className="metric-val">{currency}{node.totalRake.toLocaleString()}</span>
                        </div>
                    </div>

                    {/* Commission Control */}
                    <div className="agent-actions">
                        <div className="commission-control">
                            <label>Rate %</label>
                            <input
                                type="number"
                                min="0"
                                max="100"
                                value={node.commissionRate}
                                onChange={(e) => onUpdateRate(node.id, parseInt(e.target.value) || 0)}
                            />
                        </div>
                        <button className="remove-btn" onClick={() => onRemoveAgent(node.id)} title="Remove Agent">
                            ✕
                        </button>
                    </div>
                </div>

                {/* Render Children */}
                {isExpanded && hasChildren && (
                    <div className="agent-children">
                        {node.downline.map((child) => renderNode(child, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="agent-overlay" onClick={onClose}>
            <div className="agent-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="agent-modal__header">
                    <div className="agent-modal__title-group">
                        <span className="agent-modal__icon">🕴️</span>
                        <h2 className="agent-modal__title">Agent Management</h2>
                    </div>
                    <button className="agent-modal__close" onClick={onClose}>×</button>
                </div>

                {/* Tree Header */}
                <div className="tree-header">
                    <span>Hierarchy Tree</span>
                    <button className="add-agent-btn">+ Add New Agent</button>
                </div>

                {/* Content */}
                <div className="agent-content">
                    {agents.length > 0 ? (
                        agents.map((root) => renderNode(root))
                    ) : (
                        <div className="agent-empty">
                            No agents found. Start building your network!
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AgentManager;
