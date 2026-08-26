/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MEMBER LIST — Club Membership Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays list of club members with management actions.
 * - Search and Filter
 * - Member Details (Role, Join Date, Last Active, Balance)
 * - Admin Actions (Kick, Ban, Promote)
 */

import React, { useState, useMemo, memo, useRef, useEffect } from 'react';
import { type ClubRole, isClubPrincipal, normaliseRole, roleRank } from '../../types/clubRoles';
import { useNavigate } from 'react-router-dom';
import './MemberList.css';
import { generateDefaultAvatar, sizedStorageUrl } from '../../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type MemberRole = ClubRole;

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

function MemberListInner({
  members,
  currentUserRole,
  onPromote,
  onKick,
  onBan,
  onSendChips,
  currency = '',
  onClose,
}: MemberListProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<MemberRole | 'all'>('all');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  // Filter members
  const filteredMembers = useMemo(() => {
    const filtered = members.filter((m) => {
      const matchesSearch = m.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesRole = roleFilter === 'all' || m.role === roleFilter;
      return matchesSearch && matchesRole;
    });
    setVisibleItems(new Set());
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = filtered.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
    return filtered;
  }, [members, searchQuery, roleFilter]);

  // Mirrors fn_club_grantable_roles: an owner may act on anyone but the
  // owner, a co-owner or admin on anyone strictly below them. The server is
  // still the authority - this only decides whether to draw the control.
  const canManage = (targetRole: MemberRole) => {
    if (targetRole === 'owner') return false;
    if (isClubPrincipal(currentUserRole)) return true;
    if (normaliseRole(currentUserRole) === 'admin') {
      return roleRank(targetRole) < roleRank('admin');
    }
    return false;
  };

  return (
    <div className="member-list">
      {/* Header */}
      <div className="member-list__header">
        <h2 className="member-list__title">Club Members</h2>
        <button className="member-list__close" onClick={onClose}>
          ×
        </button>
      </div>

      {/* Toolbar */}
      <div className="member-list__toolbar">
        <input
          type="text"
          className="member-list__search"
          placeholder="Search Members..."
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
            filteredMembers.map((member, i) => (
              <div
                key={member.id}
                className="member-row"
                style={{
                  opacity: visibleItems.has(i) ? 1 : 0,
                  transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                {/* Name & Avatar */}
                <div
                  className="member-col member-col--name"
                  onClick={() => navigate(`/profile/${member.id}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="member-avatar">
                    {member.avatar ? (
                      <img
                        loading="lazy"
                        decoding="async"
                        src={sizedStorageUrl(member.avatar, 44)}
                        alt=""
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = generateDefaultAvatar();
                        }}
                      />
                    ) : (
                      <span>{(member.name || '?')[0]?.toUpperCase() || '?'}</span>
                    )}
                  </div>
                  <span className="member-name">{member.name}</span>
                </div>

                {/* Role */}
                <div className="member-col member-col--role">
                  <span className={`member-role member-role--${member.role}`}>{member.role}</span>
                </div>

                {/* Stats */}
                <div className="member-col member-col--stats">
                  <span className="member-balance">
                    {currency}
                    {member.balance.toLocaleString()}
                  </span>
                  <span className={`member-winnings ${member.totalWinnings >= 0 ? 'pos' : 'neg'}`}>
                    {member.totalWinnings >= 0 ? '+' : ''}
                    {currency}
                    {member.totalWinnings.toLocaleString()}
                  </span>
                </div>

                {/* Activity */}
                <div className="member-col member-col--active">
                  <span
                    className={`member-status ${member.lastActive === 'Online' ? 'online' : ''}`}
                  >
                    {member.lastActive}
                  </span>
                </div>

                {/* Actions */}
                <div className="member-col member-col--actions">
                  <button
                    className="member-action-btn member-action-btn--chips"
                    title="Send Chips"
                    aria-label="Send Chips"
                    onClick={() => onSendChips(member.id)}
                  ></button>
                  {canManage(member.role) && (
                    <>
                      <button
                        className="member-action-btn"
                        title="Promote"
                        aria-label="Promote"
                        onClick={() => onPromote(member.id)}
                      ></button>
                      <button
                        className="member-action-btn member-action-btn--danger"
                        title="Kick"
                        aria-label="Kick"
                        onClick={() => onKick(member.id)}
                      ></button>
                      <button
                        className="member-action-btn member-action-btn--danger"
                        title="Ban"
                        aria-label="Ban"
                        onClick={() => onBan(member.id)}
                      ></button>
                    </>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="member-list__empty">No Members Found Matching "{searchQuery}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

const MemberList = memo(MemberListInner);
export { MemberList };
export default MemberList;
