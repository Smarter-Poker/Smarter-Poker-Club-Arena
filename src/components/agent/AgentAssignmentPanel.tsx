/**
 * AGENT ASSIGNMENT PANEL
 *
 * Builds the hierarchy: put a player under an agent, or an agent under a
 * super agent. The RPCs validate role rank, club membership and rakeback
 * gaps server side, so this stays a thin, honest form — errors come back
 * from the database and are shown verbatim rather than swallowed.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { UnionOpsService } from '../../services/UnionOpsService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { fetchAllRows } from '../../utils/fetchAllRows';

interface Member {
  user_id: string;
  label: string;
  role: string;
}

const AGENT_ROLES = ['super_agent', 'agent', 'sub_agent'];

export default function AgentAssignmentPanel({ clubId }: { clubId: string }) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [playerId, setPlayerId] = useState('');
  const [playerAgentId, setPlayerAgentId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [superAgentId, setSuperAgentId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Two steps rather than a PostgREST embed: club_members.user_id carries
      // two foreign keys (profiles and users), so an embed needs a constraint
      // hint and silently breaks if either FK is ever renamed. A plain id
      // lookup has no such coupling.
      /* Ordering made the missing members predictable; paging makes them
         present (2026-08-27). Assigning members to agents against a truncated
         roster silently excludes whoever fell off the end - and on this panel
         that reads as "that member does not exist" rather than "the list is
         short". */
      const memberRows = await fetchAllRows<{ user_id: string; role: string }>(
        (from, to) =>
          supabase
            .from('club_members')
            .select('user_id, role')
            .eq('club_id', clubId)
            .order('joined_at', { ascending: true })
            .range(from, to),
        { label: 'AgentAssignmentPanel.members' }
      );

      const ids = (memberRows ?? []).map((m) => (m as { user_id: string }).user_id);
      const names = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, username, display_name')
          .in('id', ids.slice(i, i + 500));
        (profs ?? []).forEach((pr) => {
          const r = pr as { id: string; username?: string; display_name?: string };
          const label = r.display_name || r.username;
          if (label) names.set(r.id, label);
        });
      }

      const rows: Member[] = (memberRows ?? []).map((m) => {
        const uid = (m as { user_id: string }).user_id;
        return {
          user_id: uid,
          role: (m as { role: string }).role ?? 'player',
          label: names.get(uid) || uid.slice(0, 8),
        };
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      setMembers(rows);
    } catch (e) {
      reportError(e, 'AgentAssignmentPanel.load');
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    void load();
  }, [load]);

  const assignPlayer = async () => {
    if (!playerId || !playerAgentId) return;
    setBusy(true);
    try {
      const res = await UnionOpsService.assignPlayerToAgent(playerId, playerAgentId, clubId);
      if (res?.success) {
        toast.success('Player assigned');
        setPlayerId('');
      } else toast.error(res?.error ?? 'Assignment refused');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Assignment failed');
      reportError(e, 'AgentAssignmentPanel.assignPlayer');
    } finally {
      setBusy(false);
    }
  };

  const assignAgent = async () => {
    if (!agentId || !superAgentId) return;
    setBusy(true);
    try {
      const res = await UnionOpsService.assignAgentToSuperAgent(agentId, superAgentId, clubId);
      if (res?.success) {
        toast.success('Agent placed under super agent');
        setAgentId('');
        await load();
      } else toast.error(res?.error ?? 'Assignment refused');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Assignment failed');
      reportError(e, 'AgentAssignmentPanel.assignAgent');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ color: '#8aa', padding: 12 }}>Loading Members…</div>;

  const agents = members.filter((m) => AGENT_ROLES.includes(m.role));
  const supers = members.filter((m) => m.role === 'super_agent');
  const players = members.filter((m) => !AGENT_ROLES.includes(m.role));

  const sel = {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    marginBottom: 10,
    border: '1px solid #2a3a44',
    background: 'rgba(255,255,255,0.04)',
    color: '#e6f1f5',
  } as const;
  const btn = (enabled: boolean) =>
    ({
      padding: '9px 16px',
      borderRadius: 8,
      fontWeight: 700,
      border: '1px solid #37e7c7',
      background: 'rgba(55,231,199,0.12)',
      color: '#37e7c7',
      opacity: enabled ? 1 : 0.4,
      cursor: enabled ? 'pointer' : 'not-allowed',
    }) as const;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))',
        gap: 16,
      }}
    >
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          border: '1px solid #1e2a31',
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <h4 style={{ margin: '0 0 10px', color: '#e6f1f5' }}>Assign Player To An Agent</h4>
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)} style={sel}>
          <option value="">Select Player… ({players.length})</option>
          {players.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={playerAgentId}
          onChange={(e) => setPlayerAgentId(e.target.value)}
          style={sel}
        >
          <option value="">Select Agent… ({agents.length})</option>
          {agents.map((a) => (
            <option key={a.user_id} value={a.user_id}>
              {a.label} - {a.role.replace('_', ' ')}
            </option>
          ))}
        </select>
        <button
          onClick={() => void assignPlayer()}
          disabled={busy || !playerId || !playerAgentId}
          style={btn(!busy && !!playerId && !!playerAgentId)}
        >
          {busy ? 'Working…' : 'Assign'}
        </button>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 10,
          border: '1px solid #1e2a31',
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <h4 style={{ margin: '0 0 10px', color: '#e6f1f5' }}>Place Agent Under A Super Agent</h4>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={sel}>
          <option value="">Select Agent…</option>
          {members
            .filter((m) => m.role === 'agent' || m.role === 'sub_agent')
            .map((a) => (
              <option key={a.user_id} value={a.user_id}>
                {a.label} - {a.role.replace('_', ' ')}
              </option>
            ))}
        </select>
        <select value={superAgentId} onChange={(e) => setSuperAgentId(e.target.value)} style={sel}>
          <option value="">Select Super Agent… ({supers.length})</option>
          {supers.map((a) => (
            <option key={a.user_id} value={a.user_id}>
              {a.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => void assignAgent()}
          disabled={busy || !agentId || !superAgentId}
          style={btn(!busy && !!agentId && !!superAgentId)}
        >
          {busy ? 'Working…' : 'Place'}
        </button>
        <p style={{ color: '#66787f', fontSize: '0.75rem', marginBottom: 0 }}>
          A Downline Member's Rakeback Must Stay At Least 10 Points Below Their Upline's.
        </p>
      </div>
    </div>
  );
}
