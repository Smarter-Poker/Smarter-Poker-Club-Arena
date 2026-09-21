/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REGISTRATION APPROVALS PANEL (2026-08-23 — parity follow-up)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The "Authorized to Register" template flag shipped with its GATE only:
 * fn_register_for_tournament refuses 'not_authorized_to_register' unless the
 * player has a row in tournament_registration_approvals (or is club staff) —
 * but no surface existed for an owner to WRITE those rows. This panel is that
 * surface.
 *
 * Renders nothing unless (a) the tournament has authorized_to_register on and
 * (b) the viewer is a club admin/owner — the same is_club_admin() predicate
 * RLS enforces on the table, so the UI never shows a control the server would
 * refuse. Union events: the union's club row shares the union UUID, so union
 * staff who hold membership there pass the same check.
 *
 * Writes are direct table writes under RLS (policy trapp_admin_write); reads
 * batch the member profiles exactly like MembershipService does. No emoji, no
 * hand-rolled popups - all feedback goes through the Toast layer.
 *
 * #ClubArenaConsole: one console, closed flat. The approved count in the
 * pill, every player a row on the black glass with Approve or Revoke as a
 * lit word, the search printed on the glass over an engraved rule. Every
 * read, write and guard is kept; only the paint changed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useClubRole } from '../../hooks';
import { MembershipService } from '../../services/MembershipService';
import { readLocalSession } from '../../lib/authUtils';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import { titleCase } from '../../utils/titleCase';
import './RegistrationApprovalsPanel.css';

interface ApprovalRow {
  user_id: string;
  created_at: string;
}

interface MemberOption {
  userId: string;
  username: string;
}

interface Props {
  tournamentId: string;
  clubId: string;
  /** Registration gate flag from the tournaments row. */
  authorizedToRegister: boolean;
}

export default function RegistrationApprovalsPanel({
  tournamentId,
  clubId,
  authorizedToRegister,
}: Props) {
  const { isAdmin } = useClubRole(clubId);
  const toast = useToast();

  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    const { data, error } = await supabase
      .from('tournament_registration_approvals')
      .select('user_id, created_at')
      .eq('tournament_id', tournamentId)
      .order('created_at', { ascending: false });
    if (error) {
      reportError(error, 'RegistrationApprovalsPanel.load_approvals');
      return;
    }
    setApprovals((data as ApprovalRow[]) ?? []);
  }, [tournamentId]);

  useEffect(() => {
    if (!isAdmin || !authorizedToRegister) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [memberships] = await Promise.all([
          MembershipService.getClubMembers(clubId),
          loadApprovals(),
        ]);
        if (cancelled) return;
        const opts: MemberOption[] = [];
        const names: Record<string, string> = {};
        for (const m of memberships ?? []) {
          const name = m.displayName || 'Player';
          opts.push({ userId: m.userId, username: name });
          names[m.userId] = name;
        }
        setMembers(opts);
        setNameById(names);
      } catch (err) {
        reportError(err, 'RegistrationApprovalsPanel.load_members');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, isAdmin, authorizedToRegister, loadApprovals]);

  const approvedIds = useMemo(() => new Set(approvals.map((a) => a.user_id)), [approvals]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !approvedIds.has(m.userId))
      .filter((m) => (q ? m.username.toLowerCase().includes(q) : true))
      .slice(0, 25);
  }, [members, approvedIds, search]);

  const approve = async (userId: string) => {
    setBusyUserId(userId);
    try {
      // readLocalSession is the canonical client-side identity read: the
      // shared 'smarter-poker-auth' session already holds this id, so asking
      // the auth server for it again is both a needless round trip and the
      // thing the pre-push hook refuses.
      const approver = readLocalSession()?.userId ?? null;
      const { error } = await supabase.from('tournament_registration_approvals').insert({
        tournament_id: tournamentId,
        user_id: userId,
        approved_by: approver,
      });
      if (error && !/duplicate|unique/i.test(error.message || '')) {
        reportError(error, 'RegistrationApprovalsPanel.approve');
        toast.error('Could not approve that player.');
        return;
      }
      toast.success('Player approved to register.');
      await loadApprovals();
    } finally {
      setBusyUserId(null);
    }
  };

  const revoke = async (userId: string) => {
    setBusyUserId(userId);
    try {
      const { error } = await supabase
        .from('tournament_registration_approvals')
        .delete()
        .eq('tournament_id', tournamentId)
        .eq('user_id', userId);
      if (error) {
        reportError(error, 'RegistrationApprovalsPanel.revoke');
        toast.error('Could not revoke that approval.');
        return;
      }
      toast.success('Approval revoked.');
      await loadApprovals();
    } finally {
      setBusyUserId(null);
    }
  };

  if (!authorizedToRegister || !isAdmin) return null;

  return (
    <SpadeConsole
      as="section"
      className="regApprovals"
      aria-label="Registration Approvals"
      eyebrow="Registration"
      title="Authorized To Register"
      titleId="registration-approvals-title"
      pill={`${approvals.length} Approved`}
      pillInk={approvals.length > 0 ? 'green' : 'muted'}
      foot="foot"
    >
      <p className="sc-copy regApprovals__hint">
        This Event Only Admits Players You Approve. Club Staff Can Always Register.
      </p>

      {loading ? (
        <p className="sc-copy sc-copy--center regApprovals__state" aria-busy="true">
          Loading Members...
        </p>
      ) : (
        <>
          {approvals.length > 0 && (
            <ul className="regApprovals__list" aria-label="Approved Players">
              {approvals.map((a) => (
                <li key={a.user_id} className="regApprovals__row">
                  <span className="regApprovals__name sc-ink--silver">
                    {titleCase(nameById[a.user_id] || 'Player')}
                  </span>
                  <button
                    type="button"
                    className="regApprovals-word sc-ink--red"
                    disabled={busyUserId === a.user_id}
                    onClick={() => void revoke(a.user_id)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            type="search"
            className="regApprovals__search"
            placeholder="Search Members To Approve"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search Members"
          />
          {candidates.length === 0 ? (
            <p className="sc-copy sc-copy--center regApprovals__state">
              {members.length === 0
                ? 'No Club Members Found.'
                : 'Every Matching Member Is Already Approved.'}
            </p>
          ) : (
            <ul className="regApprovals__list" aria-label="Members To Approve">
              {candidates.map((m) => (
                <li key={m.userId} className="regApprovals__row">
                  <span className="regApprovals__name sc-ink--silver">{titleCase(m.username)}</span>
                  <button
                    type="button"
                    className="regApprovals-word sc-ink--green"
                    disabled={busyUserId === m.userId}
                    onClick={() => void approve(m.userId)}
                  >
                    Approve
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SpadeConsole>
  );
}
