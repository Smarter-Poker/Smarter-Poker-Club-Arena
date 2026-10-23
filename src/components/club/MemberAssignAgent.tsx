import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { UnionOpsService } from '../../services/UnionOpsService';
import { AgentAssignmentService } from '../../services/AgentAssignmentService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../../utils/playerDisplayName';
import { titleCase } from '../../utils/titleCase';
import { uuid } from '../../utils/uuid';
// The record's own sheet: the control is styled there with the Upline Agents card.
import '../../pages/MemberManagementPage.css';

/**
 * ASSIGN OR TRANSFER A PLAYER TO AN AGENT, FROM THE PLAYER RECORD (Dan 2026-10-22)
 *
 * "THERE IS NO WAY TO CURRENTLY ASSIGN OR REASSIGN A PLAYER TO ANOTHER AGENT ...
 * YOU NEED TO CREATE THE ABILITY TO TRANSFER A PLAYER OR ASSIGN A PLAYER TO AN
 * AGENT."
 *
 * Shown under Upline Agents to club management only (fn_can_manage_club_assignments:
 * owner, co-owner, admin, or the overseeing union). Save validates and applies the same
 * all-or-nothing database path as the bulk Assign And Transfer panel:
 * fn_preview_club_assignment, then fn_apply_reviewed_club_assignment, which moves
 * club_members.agent_id and the agents hierarchy together, refuses cycles and
 * rank inversions, and writes the audit trail. Moving an agent carries their
 * downline with them. A player with no agent sits directly under the club owner.
 */
interface AgentOption {
  user_id: string;
  label: string;
  role: string;
}
// Match the destination roles accepted by fn_preview_club_assignment.
const UPLINE_ROLES = ['super_agent', 'agent', 'sub_agent'];

type Request = {
  id: string;
  target: string;
  source?: string;
  reviewToken: string;
};

export default function MemberAssignAgent({
  clubId,
  userId,
  currentAgentId,
  shownUplineId = currentAgentId,
  underOwner = !currentAgentId,
  onAssigned,
}: {
  clubId: string;
  userId: string;
  /** The stored club_members.agent_id (null = no agent, under the club owner). */
  currentAgentId: string | null;
  /** Who the record shows as Direct Upline; never offered as the destination. */
  shownUplineId?: string | null;
  /** The player sits with the club owner (no agent, or the owner directly). */
  underOwner?: boolean;
  onAssigned?: () => void;
}) {
  const toast = useToast();
  const [allowed, setAllowed] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Request | null>(null);
  const version = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const mine = ++version.current;
    setAllowed(false);
    setAgents([]);
    try {
      const permission = await supabase.rpc('fn_can_manage_club_assignments', {
        p_club_id: clubId,
      });
      if (permission.error) throw permission.error;
      if (mine !== version.current || permission.data !== true) return;
      const activeAgents = await supabase
        .from('agents')
        .select('user_id')
        .eq('club_id', clubId)
        .eq('status', 'active');
      if (activeAgents.error) throw activeAgents.error;
      const ids = (activeAgents.data ?? []).map((row) => row.user_id as string);
      const roles = new Map<string, string>();
      const names = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 300) {
        const slice = ids.slice(i, i + 300);
        const [members, profiles] = await Promise.all([
          supabase
            .from('club_members')
            .select('user_id, role')
            .eq('club_id', clubId)
            .in('status', ['active', 'approved'])
            .in('user_id', slice),
          supabase.from('profiles').select(`id, ${PLAYER_NAME_COLUMNS}`).in('id', slice),
        ]);
        if (members.error) throw members.error;
        if (profiles.error) throw profiles.error;
        for (const m of members.data ?? []) roles.set(m.user_id, m.role);
        for (const p of profiles.data ?? [])
          names.set(p.id, playerDisplayName(p as NameableProfile));
      }
      if (mine !== version.current) return;
      setAgents(
        ids
          .filter((id) => id !== userId && UPLINE_ROLES.includes(roles.get(id) ?? ''))
          .map((id) => ({
            user_id: id,
            role: roles.get(id) ?? 'agent',
            label: names.get(id) || id.slice(0, 8),
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
      );
      setAllowed(true);
    } catch (cause) {
      if (mine !== version.current) return;
      reportError(cause, 'MemberAssignAgent.load');
    }
  }, [clubId, userId]);

  useEffect(() => {
    pending.current = null;
    setTarget('');
    setError('');
    setUncertain(false);
    setBusy(false);
    inFlight.current = false;
    void load();
    return () => {
      ++version.current;
    };
  }, [load]);

  const save = async () => {
    if (inFlight.current || !allowed || (!pending.current && !target)) return;
    const mine = version.current;
    const destination = target;
    const source = currentAgentId ?? undefined;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      // Validation is part of Save. Only a write with an unknown outcome keeps
      // its exact request for retry; a failed preview never creates a move.
      let request = pending.current;
      if (!request) {
        const checked = await AgentAssignmentService.preview(clubId, [userId], destination, source);
        if (mine !== version.current) return;
        request = { id: uuid(), target: destination, source, reviewToken: checked.review_token };
        pending.current = request;
      }
      await UnionOpsService.reassignClubMembers(
        clubId,
        [userId],
        request.target,
        request.id,
        request.source,
        request.reviewToken
      );
      if (mine !== version.current) return;
      const name = agents.find((a) => a.user_id === request.target)?.label ?? 'The New Agent';
      pending.current = null;
      setUncertain(false);
      setTarget('');
      toast.success(`Player Assigned To ${titleCase(name)}`);
      onAssigned?.();
      masterBus.emit('AGENT_UPDATED', { clubId, agentId: request.target });
    } catch (cause) {
      if (mine !== version.current) return;
      const attemptedWrite = pending.current !== null;
      const code = (cause as { code?: string })?.code;
      // A database refusal rolled the whole move back. A transport failure keeps
      // the same operation id so a retry reads the original receipt.
      const refused = typeof code === 'string' && /^(22|23|40|42|P0)/.test(code);
      if (refused) {
        pending.current = null;
      }
      setUncertain(attemptedWrite && !refused);
      const message = (cause as { message?: string })?.message ?? '';
      setError(
        !attemptedWrite
          ? titleCase((message || 'Could Not Save This Assignment.').replace(/_/g, ' '))
          : refused
            ? message === 'assignment_review_changed_preview_again' ||
              message === 'assignment_changed_reload_members'
              ? 'This Player Changed. Reload The Record And Save Again.'
              : titleCase((message || 'Move Refused.').replace(/_/g, ' '))
            : 'Move Not Confirmed Yet. Tap Retry To Read Its Result.'
      );
      reportError(cause, 'MemberAssignAgent.assign');
    } finally {
      if (mine === version.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  if (!allowed) return null;

  const choices = agents.filter((a) => a.user_id !== currentAgentId && a.user_id !== shownUplineId);

  return (
    <div className="mm-assign" aria-label="Assign To Agent">
      <label className="mm-info__label mm-assign__label" htmlFor="mm-assign-target">
        {underOwner ? 'Assign To An Agent' : 'Transfer To Another Agent'}
      </label>
      <div className="mm-assign__row">
        <select
          id="mm-assign-target"
          className="mm-assign__select"
          aria-label="Destination Agent"
          value={target}
          disabled={busy || uncertain}
          onChange={(e) => {
            setTarget(e.target.value);
            setError('');
          }}
        >
          <option value="">Select Agent</option>
          {choices.map((a) => (
            <option key={a.user_id} value={a.user_id}>
              {a.label} ({titleCase(a.role.replace(/_/g, ' '))})
            </option>
          ))}
        </select>
        {!uncertain && (
          <button
            type="button"
            className="mm-assign__button"
            disabled={busy || !target}
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
      {uncertain && (
        <button
          type="button"
          className="mm-assign__button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving...' : 'Retry Same Move'}
        </button>
      )}
      {error && (
        <p className="mm-winloss__note mm-assign__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
