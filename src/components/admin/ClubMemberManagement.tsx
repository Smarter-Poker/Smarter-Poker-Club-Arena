/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB MEMBER MANAGEMENT — Admin Panel for Members
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CLUB_ROLES, ROLE_LABEL, normaliseRole, type ClubRole } from '../../types/clubRoles';
import { roleColor } from '../club/RoleBadge';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { MembershipService } from '../../services/MembershipService';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './ClubMemberManagement.css';
import { reportError } from '../../utils/errorReporter';
import { safeErrorMessage } from '../../utils/safeErrorMessage';

interface ClubMemberManagementProps {
  clubId: string;
  isAdmin: boolean;
}

interface Member {
  id: string;
  username: string;
  avatarUrl: string;
  role: ClubRole;
  balance: number;
  totalRake: number;
  handsPlayed: number;
  joinedAt: Date;
  lastActive: Date | null;
  isBanned: boolean;
}

// The canonical colour and label for all seven roles live in RoleBadge and
// clubRoles. The local map this replaces knew four names, one of which
// ('member') is not a role, so a co-owner, super agent or sub agent rendered
// with no colour at all.
//
// Only the roles that carry no rate are offered here. An agent tier needs a
// commission and a rakeback percentage chosen at the same moment (the server
// refuses one without them), and Member Management is the screen that asks.
const ASSIGNABLE_HERE: ClubRole[] = ['co_owner', 'admin', 'player'];

export function ClubMemberManagement({ clubId, isAdmin }: ClubMemberManagementProps) {
  const toast = useToast();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'name' | 'balance' | 'rake' | 'joined'>('name');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_members')
        .select(
          'user_id, role, chip_balance, hands_played, created_at, last_active, status, total_rake:total_rake_paid'
        )
        .eq('club_id', resolvedId)
        .order('created_at', { ascending: true });

      if (!error && data && isMounted.current) {
        // Batch-fetch profiles (no FK between club_members → profiles)
        const cmUserIds = data.map((m: any) => m.user_id);
        const cmProfileMap: Record<string, any> = {};
        if (cmUserIds.length > 0) {
          const { data: cmProfiles } = await supabase
            .from('profiles')
            .select('id, username, avatar_url:arena_avatar_url')
            .in('id', cmUserIds);
          if (cmProfiles) {
            for (const p of cmProfiles) cmProfileMap[p.id] = p;
          }
        }
        setMembers(
          data.map((m: any) => {
            const profile = cmProfileMap[m.user_id];
            return {
              id: m.user_id,
              username: profile?.username || 'Unknown',
              avatarUrl: profile?.avatar_url || '',
              role: m.role || 'member',
              balance: m.chip_balance || 0,
              totalRake: m.total_rake || 0,
              handsPlayed: m.hands_played || 0,
              joinedAt: new Date(m.created_at),
              lastActive: m.last_active ? new Date(m.last_active) : null,
              isBanned: m.status === 'banned',
            };
          })
        );
        setVisibleItems(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = data.map((_, i) =>
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
        );
      }
    } catch (err) {
      console.error(err);
      if (isMounted.current) toast.error('Failed to load members');
    }
    if (isMounted.current) setLoading(false);
  }, [clubId, isMounted, toast]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  // This wrote club_members.role directly, which trg_club_members_role_guard
  // refuses outright, so the select has been failing into the catch below and
  // toasting "Failed to update role" for every choice. Route through the one
  // write path, and show the reason the server gives rather than a generic one.
  const updateRole = async (memberId: string, newRole: ClubRole) => {
    try {
      await MembershipService.updateRole(clubId, memberId, newRole);
      if (isMounted.current) toast.success(`Role Updated To ${ROLE_LABEL[newRole]}`);
      loadMembers();
    } catch (err) {
      reportError(err, 'ClubMemberManagement.updateRole');
      if (isMounted.current) toast.error(safeErrorMessage(err, 'Failed To Update Role'));
    }
  };

  const toggleBan = async (memberId: string, currentlyBanned: boolean) => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { error } = await supabase
        .from('club_members')
        .update({ status: currentlyBanned ? 'active' : 'banned' })
        .eq('club_id', resolvedId)
        .eq('user_id', memberId);

      if (error) throw error;

      if (isMounted.current) toast.success(currentlyBanned ? 'Member unbanned' : 'Member banned');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadMembers();
    } catch (err) {
      console.error(err);
      reportError(err, 'ClubMemberManagement.Error');
      if (isMounted.current) toast.error('Failed to update ban status');
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

      if (isMounted.current) toast.success('Member removed from club');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadMembers();
    } catch (err) {
      console.error(err);
      reportError(err, 'ClubMemberManagement.Error');
      if (isMounted.current) toast.error('Failed to remove member');
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
          {CLUB_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
          <option value="name">Sort By Name</option>
          <option value="balance">Sort By Balance</option>
          <option value="rake">Sort By Rake</option>
          <option value="joined">Sort By Joined</option>
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
                <span className="role" style={{ color: roleColor(member.role) }}>
                  {ROLE_LABEL[normaliseRole(member.role)]}
                </span>
              </span>
              <span className="stats">
                Balance: {member.balance.toLocaleString()} • Rake:{' '}
                {member.totalRake.toLocaleString()}
              </span>
            </div>
            {isAdmin && member.role !== 'owner' && (
              <div className="actions">
                <select
                  value={ASSIGNABLE_HERE.includes(normaliseRole(member.role)) ? member.role : ''}
                  onChange={(e) => updateRole(member.id, e.target.value as ClubRole)}
                >
                  {/* An agent tier is not offered: it needs a rate chosen with it. */}
                  {!ASSIGNABLE_HERE.includes(normaliseRole(member.role)) && (
                    <option value="" disabled>
                      {ROLE_LABEL[normaliseRole(member.role)]}
                    </option>
                  )}
                  {ASSIGNABLE_HERE.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  className={member.isBanned ? 'unban' : 'ban'}
                  onClick={() => toggleBan(member.id, member.isBanned)}
                >
                  {member.isBanned ? 'Unban' : 'Ban'}
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
