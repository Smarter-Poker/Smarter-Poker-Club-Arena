/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 👥 MEMBER LIST — Club Membership Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays list of club members with management actions.
 * - Search and Filter
 * - Member Details (Role, Join Date, Last Active, Balance)
 * - Admin Actions (Kick, Ban, Promote)
 */

import React, { useState, useMemo } from 'react';
import './MemberList.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type MemberRole = 'owner' | 'admin' | 'agent' | 'member';

export interface ClubMember {
    id: string;
    name: string;
    role: MemberRole;
    joinDate: string;
    lastActive: string; // e.g., "Online" or "2 days ago"
    balance: number;
    totalWinnings: number;
    avatar?: string;
}

export interface MemberListProps {
    members: ClubMember[];
    currentUserRole: MemberRole;
    onPromote: (memberId: string) => void;
    onKick: (memberId: string) => void;
    onBan: (memberId: string) => void;
    onSendChips: (memberId: string) => void;
    currency?: string;
    onClose: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function MemberList({
    members,
    currentUserRole,
    onPromote,
    onKick,
    onBan,
    onSendChips,
    currency = '💎',
    onClose,
}: MemberListProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [roleFilter, setRoleFilter] = useState<MemberRole | 'all'>('all');

    // Filter members
    const filteredMembers = useMemo(() => {
        return members.filter((m) => {
            const matchesSearch = m.name.toLowerCase().includes(searchQuery.toLowerCase());
            const matchesRole = roleFilter === 'all' || m.role === roleFilter;
            return matchesSearch && matchesRole;
        });
    }, [members, searchQuery, roleFilter]);

    // Permission check helper
    const canManage = (targetRole: MemberRole) => {
        if (currentUserRole === 'owner') return targetRole !== 'owner';
        if (currentUserRole === 'admin') return targetRole === 'member' || targetRole === 'agent';
        return false;
    };

    return (
        <div className="member-list">
            {/* Header */}
            <div className="member-list__header">
                <h2 className="member-list__title">Club Members</h2>
                <button className="member-list__close" onClick={onClose}>×</button>
            </div>

            {/* Toolbar */}
            <div className="member-list__toolbar">
                <input
                    type="text"
                    className="member-list__search"
                    placeholder="Search members..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                <select
                    className="member-list__filter"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value as MemberRole | 'all')}
                >
                    <option value="all">All Roles</option>
                    <option value="admin">Admins</option>
                    <option value="agent">Agents</option>
                    <option value="member">Members</option>
                </select>
            </div>

            {/* List */}
            <div className="member-list__content">
                <div className="member-list__grid">
                    {/* Table Header */}
                    <div className="member-row member-row--header">
                        <div className="member-col member-col--name">Player</div>
                        <div className="member-col member-col--role">Role</div>
                        <div className="member-col member-col--stats">Balance</div>
                        <div className="member-col member-col--active">Last Active</div>
                        <div className="member-col member-col--actions">Actions</div>
                    </div>

                    {/* Table Body */}
                    {filteredMembers.length > 0 ? (
                        filteredMembers.map((member) => (
                            <div key={member.id} className="member-row">
                                {/* Name & Avatar */}
                                <div className="member-col member-col--name">
                                    <div className="member-avatar">
                                        {member.avatar ? (
                                            <img src={member.avatar} alt="" />
                                        ) : (
                                            <span>{member.name[0].toUpperCase()}</span>
                                        )}
                                    </div>
                                    <span className="member-name">{member.name}</span>
                                </div>

                                {/* Role */}
                                <div className="member-col member-col--role">
                                    <span className={`member-role member-role--${member.role}`}>
                                        {member.role}
                                    </span>
                                </div>

                                {/* Stats */}
                                <div className="member-col member-col--stats">
                                    <span className="member-balance">{currency}{member.balance.toLocaleString()}</span>
                                    <span className={`member-winnings ${member.totalWinnings >= 0 ? 'pos' : 'neg'}`}>
                                        {member.totalWinnings >= 0 ? '+' : ''}{currency}{member.totalWinnings.toLocaleString()}
                                    </span>
                                </div>

                                {/* Activity */}
                                <div className="member-col member-col--active">
                                    <span className={`member-status ${member.lastActive === 'Online' ? 'online' : ''}`}>
                                        {member.lastActive}
                                    </span>
                                </div>

                                {/* Actions */}
                                <div className="member-col member-col--actions">
                                    <button
                                        className="member-action-btn member-action-btn--chips"
                                        title="Send Chips"
                                        onClick={() => onSendChips(member.id)}
                                    >
                                        💰
                                    </button>
                                    {canManage(member.role) && (
                                        <>
                                            <button
                                                className="member-action-btn"
                                                title="Promote"
                                                onClick={() => onPromote(member.id)}
                                            >
                                                ⬆️
                                            </button>
                                            <button
                                                className="member-action-btn member-action-btn--danger"
                                                title="Kick"
                                                onClick={() => onKick(member.id)}
                                            >
                                                🚫
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="member-list__empty">
                            No members found matching "{searchQuery}"
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default MemberList;
