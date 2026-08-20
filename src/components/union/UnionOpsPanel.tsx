/**
 * UNION OPS PANEL
 *
 * The union owner's operating view. Everything here was previously SQL-only:
 * risk by agent, hierarchy coverage, the three-round settlement cascade,
 * distribution safety and the union-law self-test.
 *
 * Drops into any union surface as <UnionOpsPanel unionId={...} canRun={isOwner} />.
 * Read-only for anyone who is not an overseer — the RPCs enforce that server
 * side too, this just avoids showing buttons that would fail.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  UnionOpsService,
  MIDWAY_UNION_ID,
  type AgentRiskRow,
  type UnionCoverage,
  type SettlementRound,
  type DistributionCheck,
  type LawSelfTest,
} from '../../services/UnionOpsService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

type Tab = 'risk' | 'hierarchy' | 'settlement' | 'integrity';

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);

interface Props {
  unionId?: string;
  canRun?: boolean;
}

export default function UnionOpsPanel({ unionId = MIDWAY_UNION_ID, canRun = false }: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('risk');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [risk, setRisk] = useState<AgentRiskRow[]>([]);
  const [coverage, setCoverage] = useState<UnionCoverage | null>(null);
  const [rounds, setRounds] = useState<SettlementRound[]>([]);
  const [dist, setDist] = useState<DistributionCheck | null>(null);
  const [law, setLaw] = useState<LawSelfTest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c, s, d, l] = await Promise.all([
        UnionOpsService.getAgentRisk(unionId),
        UnionOpsService.getCoverage(unionId),
        UnionOpsService.getSettlementRounds(unionId),
        UnionOpsService.getDistributionCheck(unionId),
        UnionOpsService.getLawSelfTest(),
      ]);
      setRisk(r);
      setCoverage(c);
      setRounds(s);
      setDist(d);
      setLaw(l);
    } catch (e) {
      reportError(e, 'UnionOpsPanel.load');
    } finally {
      setLoading(false);
    }
  }, [unionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runCascade = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await UnionOpsService.runSettlementCascade(unionId);
      const r2 = (res as Record<string, Record<string, unknown>>)?.round2_club_to_agents;
      const r3 = (res as Record<string, Record<string, unknown>>)?.round3_agents_to_players;
      toast.success(
        `Settled: clubs to agents ${money(Number(r2?.amount ?? 0))}, agents to players ${money(Number(r3?.amount ?? 0))}`
      );
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Settlement failed';
      toast.error(msg);
      reportError(e, 'UnionOpsPanel.runCascade');
    } finally {
      setBusy(false);
    }
  };

  const runSweep = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await UnionOpsService.runIntegritySweep(unionId, 24);
      const n = Number((res as Record<string, unknown>)?.signals ?? 0);
      if (n === 0) toast.success('Integrity sweep clean — no signals');
      else toast.info(`Integrity sweep raised ${n} signal(s) — see alerts`);
      await load();
    } catch (e) {
      reportError(e, 'UnionOpsPanel.runSweep');
      toast.error('Sweep failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 16, color: '#8aa' }}>Loading union operations…</div>;

  const tabs: Array<[Tab, string]> = [
    ['risk', 'Risk by agent'],
    ['hierarchy', 'Hierarchy'],
    ['settlement', 'Settlement'],
    ['integrity', 'Integrity'],
  ];

  return (
    <div className="union-ops-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              border: tab === id ? '1px solid #37e7c7' : '1px solid #2a3a44',
              background: tab === id ? 'rgba(55,231,199,0.12)' : 'transparent',
              color: tab === id ? '#37e7c7' : '#8fa3ad',
              fontWeight: 600,
              fontSize: '0.85rem',
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => void load()}
          style={{
            marginLeft: 'auto',
            padding: '8px 14px',
            borderRadius: 8,
            cursor: 'pointer',
            border: '1px solid #2a3a44',
            background: 'transparent',
            color: '#8fa3ad',
            fontSize: '0.85rem',
          }}
        >
          Refresh
        </button>
      </div>

      {/* RISK BY AGENT — the accountable layer */}
      {tab === 'risk' && (
        <div style={{ overflowX: 'auto' }}>
          {risk.length === 0 ? (
            <p style={{ color: '#8aa' }}>No agent activity in this period.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ color: '#7d919b', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Agent</th>
                  <th style={{ padding: 8 }}>Club</th>
                  <th style={{ padding: 8 }}>Role</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Players</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Seated</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Rake</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Player net</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Commission</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Credit out</th>
                </tr>
              </thead>
              <tbody>
                {risk.map((r) => (
                  <tr
                    key={r.agent_user_id + r.club_name}
                    style={{ borderTop: '1px solid #1e2a31' }}
                  >
                    <td style={{ padding: 8, color: '#e6f1f5' }}>
                      {r.agent_name ?? r.agent_user_id.slice(0, 8)}
                    </td>
                    <td style={{ padding: 8, color: '#8fa3ad' }}>{r.club_name}</td>
                    <td style={{ padding: 8, color: '#8fa3ad' }}>{r.role}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{r.players}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{r.seated_now}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{money(r.rake_generated)}</td>
                    <td
                      style={{
                        padding: 8,
                        textAlign: 'right',
                        color: Number(r.player_net) > 0 ? '#ff7676' : '#37e7c7',
                      }}
                    >
                      {money(r.player_net)}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>
                      {money(r.commission_accrued)}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{money(r.credit_extended)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ color: '#66787f', fontSize: '0.78rem', marginTop: 10 }}>
            Player net is shown from the union's side: red means that agent's players are up.
          </p>
        </div>
      )}

      {/* HIERARCHY HEALTH */}
      {tab === 'hierarchy' && coverage && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
            gap: 12,
          }}
        >
          <Stat
            label="Player coverage"
            value={`${coverage.player_coverage_pct}%`}
            sub={`${coverage.players_with_agent}/${coverage.players_total} have an agent`}
            bad={coverage.players_without_agent > 0}
          />
          <Stat label="Super agents" value={coverage.super_agents} />
          <Stat
            label="Agents"
            value={coverage.agents}
            sub={`${coverage.agents_under_a_super_agent} under a super agent`}
            bad={coverage.agents_orphaned > 0}
          />
          <Stat
            label="Sub agents"
            value={coverage.sub_agents}
            sub={`${coverage.sub_agents_under_an_agent} under an agent`}
            bad={coverage.sub_agents_orphaned > 0}
          />
          <Stat label="Agents with sub agents" value={coverage.agents_that_have_sub_agents} />
          <Stat
            label="Rakeback deals"
            value={coverage.player_rakeback_deals}
            sub={`${coverage.player_rakeback_gap_breaches} gap breaches`}
            bad={coverage.player_rakeback_gap_breaches > 0}
          />
          <Stat
            label="Rates out of policy"
            value={coverage.commission_rates_out_of_policy}
            sub={`band ${Math.round(coverage.policy_band.min * 100)}–${Math.round(coverage.policy_band.max * 100)}%`}
            bad={coverage.commission_rates_out_of_policy > 0}
          />
        </div>
      )}

      {/* SETTLEMENT — the three rounds */}
      {tab === 'settlement' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {dist && (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${dist.healthy ? '#1f5245' : '#5a2020'}`,
                background: dist.healthy ? 'rgba(55,231,199,0.06)' : 'rgba(255,118,118,0.08)',
              }}
            >
              <strong style={{ color: dist.healthy ? '#37e7c7' : '#ff7676' }}>
                {dist.healthy
                  ? 'Distribution healthy'
                  : `Over-distributed by ${money(dist.over_distributed_by)}`}
              </strong>
              <div style={{ color: '#8fa3ad', fontSize: '0.82rem', marginTop: 6 }}>
                Rake collected {money(dist.rake_collected)} · commissions{' '}
                {money(dist.agent_commissions)} · player rakeback {money(dist.player_rakeback)} ·
                distributed {money(dist.total_distributed)}
              </div>
            </div>
          )}

          {canRun && (
            <button
              onClick={() => void runCascade()}
              disabled={busy}
              style={{
                alignSelf: 'flex-start',
                padding: '10px 16px',
                borderRadius: 8,
                border: '1px solid #37e7c7',
                background: 'rgba(55,231,199,0.12)',
                color: '#37e7c7',
                fontWeight: 700,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy ? 'Running…' : 'Run settlement cascade'}
            </button>
          )}
          <p style={{ color: '#66787f', fontSize: '0.78rem', margin: 0 }}>
            Round 1 union pays the clubs · Round 2 clubs pay super agents and agents · Round 3
            agents pay their players. Each round is funded by the one above it.
          </p>

          {rounds.length === 0 ? (
            <p style={{ color: '#8aa' }}>No settlement runs recorded yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ color: '#7d919b', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Round</th>
                  <th style={{ padding: 8 }}>Stage</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Payees</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Short</th>
                  <th style={{ padding: 8 }}>Executed</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1e2a31' }}>
                    <td style={{ padding: 8, color: '#e6f1f5' }}>{r.round_no}</td>
                    <td style={{ padding: 8, color: '#8fa3ad' }}>
                      {r.round_name.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{r.payees}</td>
                    <td style={{ padding: 8, textAlign: 'right', color: '#37e7c7' }}>
                      {money(r.amount)}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        textAlign: 'right',
                        color: r.shortfalls ? '#ffb347' : '#8fa3ad',
                      }}
                    >
                      {r.shortfalls}
                    </td>
                    <td style={{ padding: 8, color: '#66787f' }}>
                      {new Date(r.executed_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* INTEGRITY + UNION LAW */}
      {tab === 'integrity' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {law && (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${law.healthy ? '#1f5245' : '#5a2020'}`,
                background: law.healthy ? 'rgba(55,231,199,0.06)' : 'rgba(255,118,118,0.08)',
              }}
            >
              <strong style={{ color: law.healthy ? '#37e7c7' : '#ff7676' }}>
                Union law {law.healthy ? 'healthy' : `— ${law.breaches.length} breach(es)`}
              </strong>
              {law.breaches.length > 0 && (
                <ul style={{ color: '#ff9c9c', fontSize: '0.82rem', margin: '8px 0 0 18px' }}>
                  {law.breaches.map((b, i) => (
                    <li key={i}>{JSON.stringify(b)}</li>
                  ))}
                </ul>
              )}
              {law.warnings.length > 0 && (
                <ul style={{ color: '#ffb347', fontSize: '0.82rem', margin: '8px 0 0 18px' }}>
                  {law.warnings.map((w, i) => (
                    <li key={i}>{JSON.stringify(w)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {canRun && (
            <button
              onClick={() => void runSweep()}
              disabled={busy}
              style={{
                alignSelf: 'flex-start',
                padding: '10px 16px',
                borderRadius: 8,
                border: '1px solid #2a3a44',
                background: 'transparent',
                color: '#8fa3ad',
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy ? 'Sweeping…' : 'Run integrity sweep (24h)'}
            </button>
          )}
          <p style={{ color: '#66787f', fontSize: '0.78rem', margin: 0 }}>
            Scored by agent, not by player: a bot or colluding ring has to be funded and settled by
            someone, and that is the accountable layer.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  bad,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  bad?: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${bad ? '#5a2020' : '#1e2a31'}`,
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
        {label}
      </div>
      <div
        style={{
          color: bad ? '#ff7676' : '#e6f1f5',
          fontSize: '1.5rem',
          fontWeight: 700,
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ color: '#66787f', fontSize: '0.75rem', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
