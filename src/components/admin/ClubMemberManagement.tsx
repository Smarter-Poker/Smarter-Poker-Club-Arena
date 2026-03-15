/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB MEMBER MANAGEMENT — Admin Panel for Members
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './ClubMemberManagement.css';

interface ClubMemberManagementProps {
  clubId: string;
  isAdmin: boolean;
}

interface Member {
  id: string;
  username: string;
  avatarUrl: string;
  role: 'owner' | 'admin' | 'agent' | 'member';
  balance: number;
  totalRake: number;
  handsPlayed: number;
  joinedAt: Date;
  lastActive: Date | null;
  isBanned: boolean;
}

const ROLE_COLORS: Record<string, string> = {
  owner: '#ffd700',
  admin: '#ef4444',
  agent: '#22c55e',
  member: '#6b7280',
};

export function ClubMemberManagement({ clubId, isAdmin }: ClubMemberManagementProps) {
  const toast = useToast();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'name' | 'balance' | 'rake' | 'joined'>('name');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadMembers();
  }, [clubId]);

  const loadMembers = async () => {
    setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_members')
        .select('*, player:profiles!user_id(username, avatar_url)')
        .eq('club_id', resolvedId)
        .order('created_at', { ascending: true });

      if (!error && data) {
        setMembers(
          data.map((m) => {
            const player = Array.isArray(m.player) ? m.player[0] : m.player;
            return {
              id: m.user_id,
              username: player?.username || 'Unknown',
              avatarUrl: player?.avatar_url || '',
              role: m.role || 'member',
              balance: m.balance || 0,
              totalRake: m.total_rake || 0,
              handsPlayed: m.hands_played || 0,
              joinedAt: new Date(m.created_at),
              lastActive: m.last_active ? new Date(m.last_active) : null,
              isBanned: m.is_banned || false,
            };
          })
        );
        setVisibleItems(new Set());
        data.forEach((_, i) => {
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        });
      }
    } catch (error) {
      toast.error('Failed to load members');
    }
    if (isMounted.current) setLoading(false);
  };

  const updateRole = async (memberId: string, newRole: string) => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { error } = await supabase
        .from('club_members')
        .update({ role: newRole })
        .eq('club_id', resolvedId)
        .eq('user_id', memberId);

      if (error) throw error;

      toast.success('Role updated');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadMembers();
    } catch {
      toast.error('Failed to update role');
    }
  };

  const toggleBan = async (memberId: string, currentlyBanned: boolean) => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { error } = await supabase
        .from('club_members')
        .update({ is_banned: !currentlyBanned })
        .eq('club_id', resolvedId)
        .eq('user_id', memberId);

      if (error) throw error;

      toast.success(currentlyBanned ? 'Member unbanned' : 'Member banned');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadMembers();
    } catch {
      toast.error('Failed to update ban status');
    }
  };

  const kickMember = async (memberId: string) => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { error } = await supabase
        .from('club_members')
        .delete()
        .eq('club_id', resolvedId)
        .eq('user_id', memberId);

      if (error) throw error;

      toast.success('Member removed from club');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadMembers();
    } catch {
      toast.error('Failed to remove member');
    }
  };

  let filteredMembers = members.filter((m) =>
    m.username.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (roleFilter !== 'all') {
    filteredMembers = filteredMembers.filter((m) => m.role === roleFilter);
  }

  filteredMembers.sort((a, b) => {
    switch (sortBy) {
      case 'balance':
        return b.balance - a.balance;
      case 'rake':
        return b.totalRake - a.totalRake;
      case 'joined':
        return b.joinedAt.getTime() - a.joinedAt.getTime();
      default:
        return a.username.localeCompare(b.username);
    }
  });

  if (loading) {
    return <div className="member-management loading">Loading...</div>;
  }

  return (
    <div className="member-management">
      <div className="member-management__header">
        <h3> Members ({members.length})</h3>
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="member-management__filters">
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="all">All Roles</option>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="agent">Agent</option>
          <option value="member">Member</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
          <option value="name">Sort by Name</option>
          <option value="balance">Sort by Balance</option>
          <option value="rake">Sort by Rake</option>
          <option value="joined">Sort by Joined</option>
        </select>
      </div>

      <div className="member-management__list">
        {filteredMembers.map((member, i) => (
          <div
            key={member.id}
            className={`member-row ${member.isBanned ? 'banned' : ''}`}
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className="avatar">{member.avatarUrl}</span>
            <div className="info">
              <span className="name">
                {member.username}
                <span className="role" style={{ color: ROLE_COLORS[member.role] }}>
                  {member.role}
                </span>
              </span>
              <span className="stats">
                Balance: {member.balance.toLocaleString()} • Rake:{' '}
                {member.totalRake.toLocaleString()}
              </span>
            </div>
            {isAdmin && member.role !== 'owner' && (
              <div className="actions">
                <select value={member.role} onChange={(e) => updateRole(member.id, e.target.value)}>
                  <option value="member">Member</option>
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  className={member.isBanned ? 'unban' : 'ban'}
                  onClick={() => toggleBan(member.id, member.isBanned)}
                >
                  {member.isBanned ? '' : ''}
                </button>
                <button className="kick" onClick={() => kickMember(member.id)}>
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default ClubMemberManagement;
