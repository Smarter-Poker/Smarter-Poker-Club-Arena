/**
 * UNION-WIDE AGENT STATEMENTS
 *
 * One row per agent for the settlement period: what they generated, what
 * they earned, what they passed down, and the single net number that moves
 * between them and their club on Monday.
 *
 * Backed by fn_union_weekly_agent_statements, which is overseer-gated.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UnionOpsService,
  MIDWAY_UNION_ID,
  describeRpcError,
  type AgentStatement,
} from '../../services/UnionOpsService';
import { reportError } from '../../utils/errorReporter';

const money = (n: unknown) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);

interface Row {
  agent_user_id: string;
  agent_name: string | null;
  club_name: string | null;
  statement: AgentStatement;
}

export default function UnionAgentStatements({ unionId = MIDWAY_UNION_ID }: { unionId?: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows((await UnionOpsService.getAllAgentStatements(unionId)) as Row[]);
    } catch (e) {
      setLoadError(describeRpcError(e));
      reportError(e, 'UnionAgentStatements.load');
    } finally {
      setLoading(false);
    }
  }, [unionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? rows.filter(
          (r) =>
            (r.agent_name ?? '').toLowerCase().includes(needle) ||
            (r.club_name ?? '').toLowerCase().includes(needle)
        )
      : rows;
    return [...list].sort(
      (a, b) =>
        Number(b.statement?.commission_earned ?? 0) - Number(a.statement?.commission_earned ?? 0)
    );
  }, [rows, q]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.rake += Number(r.statement?.rake_generated ?? 0);
          acc.comm += Number(r.statement?.commission_earned ?? 0);
          acc.down += Number(r.statement?.rakeback_passed_to_players ?? 0);
          acc.net += Number(r.statement?.net_settlement_position ?? 0);
          return acc;
        },
        { rake: 0, comm: 0, down: 0, net: 0 }
      ),
    [filtered]
  );

  if (loading) return <div style={{ color: '#8aa', padding: 12 }}>Loading Agent Statements…</div>;

  if (loadError) {
    return (
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          border: '1px solid #5a2020',
          background: 'rgba(255,118,118,0.08)',
          color: '#ff9c9c',
        }}
      >
        {loadError}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter By Agent Or Club…"
          style={{
            flex: '1 1 220px',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #2a3a44',
            background: 'rgba(255,255,255,0.04)',
            color: '#e6f1f5',
          }}
        />
        <button
          onClick={() => void load()}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid #2a3a44',
            background: 'transparent',
            color: '#8fa3ad',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: '#8aa' }}>No Agent Statements For This Period.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ color: '#7d919b', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Agent</th>
                <th style={{ padding: 8 }}>Club</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Players</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Rake</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Commission</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Passed Down</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Credit Out</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Net Settle</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const st = r.statement ?? ({} as AgentStatement);
                const net = Number(st.net_settlement_position ?? 0);
                return (
                  <tr key={r.agent_user_id} style={{ borderTop: '1px solid #1e2a31' }}>
                    <td style={{ padding: 8, color: '#e6f1f5' }}>
                      {r.agent_name ?? r.agent_user_id.slice(0, 8)}
                    </td>
                    <td style={{ padding: 8, color: '#8fa3ad' }}>{r.club_name}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{st.players ?? 0}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{money(st.rake_generated)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>
                      {money(st.commission_earned)}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right', color: '#8fa3ad' }}>
                      {money(st.rakeback_passed_to_players)}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right', color: '#8fa3ad' }}>
                      {money(st.credit_outstanding)}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        textAlign: 'right',
                        fontWeight: 700,
                        color: net >= 0 ? '#37e7c7' : '#ff7676',
                      }}
                    >
                      {net >= 0 ? '+' : ''}
                      {money(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #2a3a44', color: '#e6f1f5', fontWeight: 700 }}>
                <td style={{ padding: 8 }} colSpan={3}>
                  {filtered.length} Agents
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>{money(totals.rake)}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{money(totals.comm)}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{money(totals.down)}</td>
                <td style={{ padding: 8 }} />
                <td
                  style={{
                    padding: 8,
                    textAlign: 'right',
                    color: totals.net >= 0 ? '#37e7c7' : '#ff7676',
                  }}
                >
                  {money(totals.net)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
