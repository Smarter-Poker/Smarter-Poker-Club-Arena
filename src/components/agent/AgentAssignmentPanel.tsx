/** Club management changes both hierarchy representations atomically. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { UnionOpsService } from '../../services/UnionOpsService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { fetchAllRows } from '../../utils/fetchAllRows';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../../utils/playerDisplayName';
import { titleCase } from '../../utils/titleCase';
import { uuid } from '../../utils/uuid';
import { SpadeConsole } from '../console/SpadeConsole';
import './AgentAssignmentPanel.css';

interface Member {
  user_id: string;
  label: string;
  role: string;
  agent_id: string | null;
  holds_agent?: boolean;
}
interface Pending {
  id: string;
  club: string;
  members: string[];
  target: string;
  source?: string;
}
const AGENT_ROLES = ['super_agent', 'agent', 'sub_agent'];

export default function AgentAssignmentPanel({ clubId }: { clubId: string }) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Pending | null>(null);
  const version = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const mine = ++version.current;
    setLoading(true);
    setError('');
    setAllowed(false);
    setMembers([]);
    try {
      const permission = await supabase.rpc('fn_can_manage_club_assignments', {
        p_club_id: clubId,
      });
      if (permission.error) throw permission.error;
      if (mine !== version.current) return;
      if (permission.data !== true) return;
      setAllowed(true);
      const rows = await fetchAllRows<{ user_id: string; role: string; agent_id: string | null }>(
        (from, to) =>
          supabase
            .from('club_members')
            .select('user_id, role, agent_id')
            .eq('club_id', clubId)
            .in('status', ['active', 'approved'])
            .order('user_id')
            .range(from, to),
        { label: 'AgentAssignmentPanel.members' }
      );
      const activeAgents = await fetchAllRows<{ user_id: string }>(
        (from, to) =>
          supabase
            .from('agents')
            .select('user_id')
            .eq('club_id', clubId)
            .eq('status', 'active')
            .order('user_id')
            .range(from, to),
        { label: 'AgentAssignmentPanel.activeAgents' }
      );
      const agentIds = new Set(activeAgents.map((row) => row.user_id));
      const names = new Map<string, string>();
      for (let i = 0; i < rows.length; i += 500) {
        const result = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}`)
          .in(
            'id',
            rows.slice(i, i + 500).map((m) => m.user_id)
          );
        if (result.error) throw result.error;
        for (const p of result.data ?? []) names.set(p.id, playerDisplayName(p as NameableProfile));
      }
      if (mine !== version.current) return;
      setMembers(
        rows
          .map((m) => ({
            ...m,
            holds_agent: agentIds.has(m.user_id),
            label: names.get(m.user_id) || m.user_id.slice(0, 8),
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
      );
    } catch (e) {
      if (mine !== version.current) return;
      setError('Could Not Load Assignment Controls.');
      reportError(e, 'AgentAssignmentPanel.load');
    } finally {
      if (mine === version.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    pending.current = null;
    setUncertain(false);
    setSelected([]);
    setSource('');
    setTarget('');
    void load();
    return () => {
      ++version.current;
    };
  }, [load]);

  const assign = async () => {
    if (inFlight.current || (!pending.current && (!selected.length || !target))) return;
    const request = pending.current ?? {
      id: uuid(),
      club: clubId,
      members: [...selected],
      target,
      source: source || undefined,
    };
    pending.current = request;
    const mine = version.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await UnionOpsService.reassignClubMembers(
        request.club,
        request.members,
        request.target,
        request.id,
        request.source
      );
      if (mine !== version.current) return;
      pending.current = null;
      setUncertain(false);
      setSelected([]);
      toast.success(`${receipt.moved.toLocaleString()} Members Reassigned`);
      await load();
    } catch (e) {
      if (mine !== version.current) return;
      const code = (e as { code?: string })?.code;
      // A database refusal rolls back the complete operation. A transport
      // failure retains the exact request and id for an explicit safe retry.
      const refused = typeof code === 'string' && /^(22|23|40|42|P0)/.test(code);
      if (refused) pending.current = null;
      setUncertain(!refused);
      setError(
        refused
          ? ((e as { message?: string }).message ?? 'Assignment Refused.')
          : 'Assignment Outcome Unconfirmed. Retry The Same Request To Read Its Receipt.'
      );
      reportError(e, 'AgentAssignmentPanel.assign');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (loading) return <p className="sc-copy">Loading Assignment Controls...</p>;
  if (!allowed)
    return error ? (
      <p role="alert" className="sc-copy">
        {error}
      </p>
    ) : null;
  const agents = members.filter(
    (m) => m.holds_agent && ['owner', 'co_owner', 'admin', ...AGENT_ROLES].includes(m.role)
  );
  const assignable = members.filter(
    (m) =>
      ['member', 'player', ...AGENT_ROLES].includes(m.role) && (!source || m.agent_id === source)
  );
  const label = (id: string | null) => members.find((m) => m.user_id === id)?.label ?? 'Unassigned';
  const locked = busy || uncertain;
  return (
    <SpadeConsole title="Assign And Transfer" pill="Staff" eyebrow="Club Management" foot="foot">
      <div className="agent-assignment">
        <p className="sc-copy">
          Assign Or Reassign Players. Moving An Agent Keeps Their Existing Downline Together.
        </p>
        <label className="sc-label">
          Current Agent
          <select
            aria-label="Current Agent"
            value={source}
            disabled={locked}
            onChange={(e) => {
              setSource(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">All Active Members</option>
            {agents.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-label">
          Members To Move
          <select
            multiple
            size={Math.min(8, Math.max(3, assignable.length))}
            aria-label="Members To Move"
            value={selected}
            disabled={locked}
            onChange={(e) => setSelected(Array.from(e.target.selectedOptions, (o) => o.value))}
          >
            {assignable.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.label} / {titleCase(m.role.replace(/_/g, ' '))} / {label(m.agent_id)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="sc-label sc-ink--blue"
          disabled={locked || !assignable.length}
          onClick={() => setSelected(assignable.map((m) => m.user_id))}
        >
          Select All Shown
        </button>
        <label className="sc-label">
          Destination Agent
          <select
            aria-label="Destination Agent"
            value={target}
            disabled={locked}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Select Destination Agent</option>
            {agents
              .filter((m) => !selected.includes(m.user_id) && m.user_id !== source)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.label} / {titleCase(m.role.replace(/_/g, ' '))}
                </option>
              ))}
          </select>
        </label>
        <p className="sc-copy">
          {selected.length.toLocaleString()} Members Selected. The Complete Transfer Succeeds Or No
          Members Move.
        </p>
        {error && (
          <p role="alert" className="sc-copy sc-ink--red">
            {titleCase(error)}
          </p>
        )}
        <button
          type="button"
          className="sc-label sc-ink--blue"
          disabled={busy || (!uncertain && (!selected.length || !target))}
          onClick={() => void assign()}
        >
          {busy
            ? 'Saving Assignment...'
            : uncertain
              ? 'Retry Same Assignment'
              : 'Assign Or Transfer Selected'}
        </button>
      </div>
    </SpadeConsole>
  );
}
