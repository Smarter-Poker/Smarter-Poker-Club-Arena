/**
 * AGENT BACK OFFICE
 *
 * Current downline and recorded accounting activity for the selected club.
 * Posted cash wallet movement is not a certified settlement amount. Missing
 * historical commission attribution remains unavailable until reconciled.
 * The server authorizes each requested club; account and club changes discard
 * outstanding responses before they can display another scope's statement.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  UnionOpsService,
  describeRpcError,
  type AgentRosterRow,
  type AgentStatement,
} from '../../services/UnionOpsService';
import { reportError } from '../../utils/errorReporter';

const money = (n: unknown) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? 'Not Available'
    : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        Number(n)
      );

interface Props {
  /** Omit to view the signed-in agent's own book. */
  agentUserId?: string;
  clubId?: string;
  /** Optional heading; hidden when embedded under an existing one. */
  title?: string;
}

export default function AgentBackOffice({ agentUserId, clubId, title }: Props) {
  const { user } = useAuthUser();
  const selection = `${user?.id ?? ''}:${agentUserId ?? ''}:${clubId ?? ''}`;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const request = useRef(0);
  const [loadedSelection, setLoadedSelection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<AgentRosterRow[]>([]);
  const [statement, setStatement] = useState<AgentStatement | null>(null);
  const [sort, setSort] = useState<keyof AgentRosterRow>('rake_generated');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const operation = ++request.current;
    const current = () => operation === request.current && selectionRef.current === selection;
    setLoading(true);
    setLoadError(null);
    if (!user?.id) {
      setLoadedSelection(selection);
      setLoadError('Sign In To View Your Statement');
      setLoading(false);
      return;
    }
    try {
      const [r, s] = await Promise.all([
        UnionOpsService.getAgentRoster(agentUserId, undefined, undefined, clubId),
        UnionOpsService.getAgentStatement(agentUserId, undefined, undefined, clubId),
      ]);
      if (!current()) return;
      if (!s) throw new Error('Agent statement unavailable');
      setRoster(r);
      setStatement(s);
      setLoadedSelection(selection);
    } catch (e) {
      if (!current()) return;
      setLoadedSelection(selection);
      setLoadError(describeRpcError(e));
      reportError(e, 'AgentBackOffice.load');
    } finally {
      if (current()) setLoading(false);
    }
  }, [agentUserId, clubId, selection, user?.id]);

  useLayoutEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  if (loading || loadedSelection !== selection)
    return <div style={{ padding: 16, color: '#8aa' }}>Loading Roster…</div>;

  if (loadError) {
    return (
      <div
        style={{
          padding: 16,
          borderRadius: 10,
          border: '1px solid #5a2020',
          background: 'rgba(255,118,118,0.08)',
          color: '#ff9c9c',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span>{loadError}</span>
        <button
          onClick={() => void load()}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid #5a2020',
            background: 'transparent',
            color: '#ff9c9c',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const sorted = [...roster].sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    if (typeof av === 'number' && typeof bv === 'number') return bv - av;
    return String(bv).localeCompare(String(av));
  });

  const totalRake = roster.reduce((s, r) => s + Number(r.rake_generated || 0), 0);
  const totalNet = roster.reduce((s, r) => s + Number(r.net_result || 0), 0);
  const seated = roster.filter((r) => r.currently_seated).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {title && <h3 style={{ color: '#e6f1f5', margin: 0 }}>{title}</h3>}

      {/* Recorded activity is separate from an invoice with a verified amount due. */}
      {statement && (
        <div
          style={{
            padding: 14,
            borderRadius: 10,
            border: '1px solid #1e2a31',
            background: 'rgba(255,255,255,0.03)',
          }}
        >
          <div
            style={{
              color: '#7d919b',
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Week Of {new Date(statement.period_start).toLocaleDateString()}
          </div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, marginTop: 4, color: '#e6f1f5' }}>
            {statement.settlement_verified === true && statement.net_settlement_position !== null
              ? money(statement.net_settlement_position)
              : 'Settlement Requires Reconciliation'}
          </div>
          <div style={{ color: '#8fa3ad', fontSize: '0.78rem', marginTop: 6 }}>
            Use Issued Invoices For Amounts Due. Activity Below Shows The Current Downline And
            Posted Records.
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 10,
              marginTop: 14,
            }}
          >
            <Line label="Cash Rake Recorded" value={money(statement.rake_generated)} />
            <Line label="Commission Recorded" value={money(statement.commission_earned)} />
            <Line label="Paid To Players" value={money(statement.rakeback_passed_to_players)} />
            <Line label="Recorded Less Paid" value={money(statement.commission_net_of_rakeback)} />
            <Line label="Net Cash Wallet Movement" value={money(statement.player_net_result)} />
            <Line label="Credit Outstanding" value={money(statement.credit_outstanding)} />
          </div>
        </div>
      )}

      {/* SUMMARY */}
      <div
        style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          color: '#8fa3ad',
          fontSize: '0.85rem',
        }}
      >
        <span>
          <strong style={{ color: '#e6f1f5' }}>{roster.length}</strong> Players
        </span>
        <span>
          <strong style={{ color: '#37e7c7' }}>{seated}</strong> Seated Now
        </span>
        <span>
          Rake <strong style={{ color: '#e6f1f5' }}>{money(totalRake)}</strong>
        </span>
        <span>
          Net{' '}
          <strong style={{ color: totalNet > 0 ? '#ff7676' : '#37e7c7' }}>{money(totalNet)}</strong>
        </span>
      </div>

      {/* ROSTER */}
      {roster.length === 0 ? (
        <p style={{ color: '#8aa' }}>No Players Assigned Yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ color: '#7d919b', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Player</th>
                <th style={{ padding: 8 }}>Club</th>
                <Th field="buyins" sort={sort} onSort={setSort}>
                  Cash Buy-Ins
                </Th>
                <Th field="cashouts" sort={sort} onSort={setSort}>
                  Cash Table Returns
                </Th>
                <Th field="net_result" sort={sort} onSort={setSort}>
                  Net
                </Th>
                <Th field="rake_generated" sort={sort} onSort={setSort}>
                  Rake
                </Th>
                <Th field="agent_commission" sort={sort} onSort={setSort}>
                  Player Commission
                </Th>
                <Th field="chip_balance" sort={sort} onSort={setSort}>
                  Chips
                </Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.player_id + p.club_id} style={{ borderTop: '1px solid #1e2a31' }}>
                  <td style={{ padding: 8, color: '#e6f1f5' }}>
                    {p.currently_seated && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: '#37e7c7',
                          marginRight: 7,
                        }}
                      />
                    )}
                    {p.username ?? p.player_id.slice(0, 8)}
                  </td>
                  <td style={{ padding: 8, color: '#8fa3ad' }}>{p.club_name}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{money(p.buyins)}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{money(p.cashouts)}</td>
                  <td
                    style={{
                      padding: 8,
                      textAlign: 'right',
                      color: Number(p.net_result) > 0 ? '#ff7676' : '#37e7c7',
                    }}
                  >
                    {money(p.net_result)}
                  </td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{money(p.rake_generated)}</td>
                  <td style={{ padding: 8, textAlign: 'right', color: '#37e7c7' }}>
                    {money(p.agent_commission)}
                  </td>
                  <td style={{ padding: 8, textAlign: 'right', color: '#8fa3ad' }}>
                    {money(p.chip_balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ color: '#66787f', fontSize: '0.78rem', margin: 0 }}>
        Net Is From The House Side - Red Means The Player Is Up And The Loss Settles Against You.
      </p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: '#7d919b', fontSize: '0.72rem' }}>{label}</div>
      <div style={{ color: '#e6f1f5', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Th({
  field,
  sort,
  onSort,
  children,
}: {
  field: keyof AgentRosterRow;
  sort: keyof AgentRosterRow;
  onSort: (f: keyof AgentRosterRow) => void;
  children: React.ReactNode;
}) {
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: 8,
        textAlign: 'right',
        cursor: 'pointer',
        color: sort === field ? '#37e7c7' : undefined,
      }}
    >
      {children}
      {sort === field ? ' ▾' : ''}
    </th>
  );
}
