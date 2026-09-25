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
import { MembershipService } from '../../services/MembershipService';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { liveSeatTableIds } from '../../services/IntegrityActionService';
import { confirmDialog } from '../common/confirmDialog';
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
  /**
   * Everything a club_members row carries that a hard DELETE would destroy:
   * chip_balance + held_chips + locked_chips + promo_balance, plus any credit
   * drawn. Removal is refused while this is above zero.
   */
  chipsAtRisk: number;
  totalRake: number;
  handsPlayed: number;
  joinedAt: Date;
  lastActive: Date | null;
  isBanned: boolean;
}

/** The chips a membership row holds. Exported so the refusal is testable. */
export function chipsHeldByMembership(row: {
  chip_balance?: number | string | null;
  held_chips?: number | string | null;
  locked_chips?: number | string | null;
  promo_balance?: number | string | null;
  credit_used?: number | string | null;
}): number {
  const n = (v: unknown) => Number(v) || 0;
  return (
    n(row.chip_balance) +
    n(row.held_chips) +
    n(row.locked_chips) +
    n(row.promo_balance) +
    n(row.credit_used)
  );
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

/** Rows past this index appear together rather than one every 60 ms. */
const STAGGER_CAP = 12;

export function ClubMemberManagement({ clubId, isAdmin }: ClubMemberManagementProps) {
  const toast = useToast();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed read is its own state. It used to fall through to an empty
  // list, which reads as "this club has no members".
  const [loadError, setLoadError] = useState(false);
  const isMounted = useIsMounted();
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'name' | 'balance' | 'rake' | 'joined'>('name');
  // Keyed by member id, not list index: the rendered list is searched,
  // filtered and sorted, so an index into the unfiltered array named a
  // different row and a search left survivors stuck at opacity 0.
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_members')
        .select(
          'user_id, role, chip_balance, held_chips, locked_chips, promo_balance, credit_used, hands_played, created_at, last_active, status, total_rake:total_rake_paid'
        )
        .eq('club_id', resolvedId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (!data || !isMounted.current) return;

      // Batch-fetch profiles (no FK between club_members → profiles)
      const cmUserIds = data.map((m: any) => m.user_id);
      const cmProfileMap: Record<string, any> = {};
      if (cmUserIds.length > 0) {
        const { data: cmProfiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, avatar_url:arena_avatar_url')
          .in('id', cmUserIds);
        if (profilesError) throw profilesError;
        if (cmProfiles) {
          for (const p of cmProfiles) cmProfileMap[p.id] = p;
        }
      }
      if (!isMounted.current) return;
      setMembers(
        data.map((m: any) => {
          const profile = cmProfileMap[m.user_id];
          return {
            id: m.user_id,
            username: profile?.username || 'Unknown',
            avatarUrl: profile?.avatar_url || '',
            role: m.role || 'player',
            balance: Number(m.chip_balance) || 0,
            chipsAtRisk: chipsHeldByMembership(m),
            totalRake: Number(m.total_rake) || 0,
            handsPlayed: Number(m.hands_played) || 0,
            joinedAt: new Date(m.created_at),
            lastActive: m.last_active ? new Date(m.last_active) : null,
            isBanned: m.status === 'banned',
          };
        })
      );
    } catch (err) {
      reportError(err, 'ClubMemberManagement.loadMembers');
      if (isMounted.current) {
        setLoadError(true);
        toast.error('The Member List Could Not Be Loaded');
      }
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

  // club_members.status is server owned (trg_club_members_status_guard refuses
  // a browser write), so Ban and Unban go through the one status door,
  // fn_club_set_member_status via MembershipService.updateStatus. It resolves
  // only when the server confirms the member now has the status asked for, and
  // otherwise throws the server's refusal, which is what the toast shows.
  const toggleBan = async (memberId: string, currentlyBanned: boolean) => {
    if (busyId) return;
    setBusyId(memberId);
    try {
      await MembershipService.updateStatus(clubId, memberId, currentlyBanned ? 'active' : 'banned');

      if (isMounted.current) toast.success(currentlyBanned ? 'Member Unbanned' : 'Member Banned');
      loadMembers();
    } catch (err) {
      reportError(err, 'ClubMemberManagement.toggleBan');
      if (isMounted.current) toast.error(safeErrorMessage(err, 'Failed To Update Ban Status'));
    } finally {
      if (isMounted.current) setBusyId(null);
    }
  };

  /**
   * The quick checks below explain obvious blockers before confirmation. The
   * authoritative decision is still made by fn_remove_settled_club_member in
   * the same transaction as the departure; balances or seats can change between
   * this screen's read and the click, and the browser is never allowed to
   * DELETE a wallet-bearing membership directly.
   */
  const kickMember = async (member: Member) => {
    if (busyId) return;
    if (member.chipsAtRisk > 0) {
      toast.error(
        `${member.username} Holds Or Owes ${member.chipsAtRisk.toLocaleString()} Chips In This Club. Settle Them Before Marking The Membership Departed.`
      );
      return;
    }
    setBusyId(member.id);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const seats = await liveSeatTableIds(resolvedId, member.id);
      if (seats.length > 0) {
        toast.error(
          `${member.username} Is Seated At ${seats.length} ${seats.length === 1 ? 'Table' : 'Tables'}. Remove Them From Play First.`
        );
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Mark Member Departed',
        message: `Mark ${member.username} As Departed From The Club? Access Ends, While Their Membership And Role History Stay Retained.`,
        confirmText: 'Mark Departed',
        variant: 'danger',
      });
      if (!confirmed) return;

      await MembershipService.removeMember(resolvedId, member.id);

      if (isMounted.current) toast.success('Member Marked Departed; History Retained');
      loadMembers();
    } catch (err) {
      reportError(err, 'ClubMemberManagement.kickMember');
      if (isMounted.current) toast.error(safeErrorMessage(err, 'Failed To Mark Member Departed'));
    } finally {
      if (isMounted.current) setBusyId(null);
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

  // Stagger only the rows actually rendered, by id, whenever the rendered
  // set changes. Rows already shown stay shown. The delay is capped: with
  // 417 members, an uncapped i * 60 left the last row invisible for 25
  // seconds.
  const renderedSignature = filteredMembers.map((m) => m.id).join('|');
  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    const ids = renderedSignature ? renderedSignature.split('|') : [];
    staggerTimersRef.current = ids
      .filter((id) => !visibleIds.has(id))
      .map((id, i) =>
        setTimeout(
          () => {
            if (isMounted.current) setVisibleIds((prev) => new Set(prev).add(id));
          },
          Math.min(i, STAGGER_CAP) * 60
        )
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedSignature]);

  if (loading) {
    return <div className="member-management loading">Loading...</div>;
  }

  if (loadError) {
    return (
      <div className="member-management">
        <p className="member-management__error">The Member List Could Not Be Loaded.</p>
        <button type="button" className="member-management__retry" onClick={() => loadMembers()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="member-management">
      <div className="member-management__header">
        <h3>Members ({members.length.toLocaleString()})</h3>
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
        {filteredMembers.length === 0 && (
          <p className="member-management__empty">
            {searchTerm || roleFilter !== 'all' ? 'No Members Match' : 'No Members Yet'}
          </p>
        )}
        {filteredMembers.map((member) => (
          <div
            key={member.id}
            className={`member-row ${member.isBanned ? 'banned' : ''}`}
            style={{
              opacity: visibleIds.has(member.id) ? 1 : 0,
              transform: visibleIds.has(member.id) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            {/* The avatar is a picture, not the text of its URL. */}
            <span className="avatar" aria-hidden="true">
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" loading="lazy" />
              ) : (
                member.username.charAt(0).toUpperCase()
              )}
            </span>
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
                {member.chipsAtRisk > member.balance && (
                  <> • Held {(member.chipsAtRisk - member.balance).toLocaleString()}</>
                )}
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
                  type="button"
                  className={member.isBanned ? 'unban' : 'ban'}
                  disabled={busyId !== null}
                  onClick={() => toggleBan(member.id, member.isBanned)}
                >
                  {member.isBanned ? 'Unban' : 'Ban'}
                </button>
                <button
                  type="button"
                  className="kick"
                  disabled={busyId !== null}
                  aria-label={`Remove ${member.username} From The Club`}
                  title={
                    member.chipsAtRisk > 0
                      ? 'Holds Or Owes Chips In This Club. Settle Before Removing.'
                      : 'Remove From Club'
                  }
                  onClick={() => kickMember(member)}
                >
                  Remove
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
