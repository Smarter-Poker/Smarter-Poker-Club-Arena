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
  describeRpcError,
  type AgentRiskRow,
  type UnionCoverage,
  type SettlementRound,
  type DistributionCheck,
  type LawSelfTest,
  type SettlementPreview,
} from '../../services/UnionOpsService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

type Tab = 'risk' | 'hierarchy' | 'settlement' | 'integrity';

const money = (n: unknown) =>
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Authorisation is identical across these reads, so probe with one call
      // first: four identical permission errors are less useful than one clear
      // message, and an empty table must not be mistaken for "no data".
      const c = await UnionOpsService.getCoverageStrict(unionId);
      const [r, rs, d, l] = await Promise.all([
        UnionOpsService.getAgentRisk(unionId),
        UnionOpsService.getSettlementRounds(unionId),
        UnionOpsService.getDistributionCheck(unionId),
        UnionOpsService.getLawSelfTest(),
      ]);
      setCoverage(c);
      setRisk(r);
      setRounds(rs);
      setDist(d);
      setLaw(l);
    } catch (e) {
      setLoadError(describeRpcError(e));
      reportError(e, 'UnionOpsPanel.load');
    } finally {
      setLoading(false);
    }
  }, [unionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPreview = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setPreview(await UnionOpsService.getSettlementPreview(unionId));
      setConfirming(true);
    } catch (e) {
      toast.error(describeRpcError(e));
      reportError(e, 'UnionOpsPanel.openPreview');
    } finally {
      setBusy(false);
    }
  };

  const runCascade = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await UnionOpsService.runSettlementCascade(unionId);
      setConfirming(false);
      const r2 = res.round2_club_to_agents;
      const r3 = res.round3_agents_to_players;
      toast.success(
        `Settled: clubs to agents ${money(r2.amount)}, agents to players ${money(r3.amount)}`
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
      if (n === 0) toast.success('Integrity sweep clean - no signals');
      else toast.info(`Integrity sweep raised ${n} signal(s) - see alerts`);
      await load();
    } catch (e) {
      reportError(e, 'UnionOpsPanel.runSweep');
      toast.error('Sweep failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 16, color: '#8aa' }}>Loading Union Operations…</div>;

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
            <p style={{ color: '#8aa' }}>No Agent Activity In This Period.</p>
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
                  <th style={{ padding: 8, textAlign: 'right' }}>Player Net</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Commission</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Credit Out</th>
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
            Player Net Is Shown From The Union's Side: Red Means That Agent's Players Are Up.
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
            label="Player Coverage"
            value={`${coverage.player_coverage_pct}%`}
            sub={`${coverage.players_with_agent}/${coverage.players_total} have an agent`}
            bad={coverage.players_without_agent > 0}
          />
          <Stat label="Super Agents" value={coverage.super_agents} />
          <Stat
            label="Agents"
            value={coverage.agents}
            sub={`${coverage.agents_under_a_super_agent} under a super agent`}
            bad={coverage.agents_orphaned > 0}
          />
          <Stat
            label="Sub Agents"
            value={coverage.sub_agents}
            sub={`${coverage.sub_agents_under_an_agent} under an agent`}
            bad={coverage.sub_agents_orphaned > 0}
          />
          <Stat label="Agents With Sub Agents" value={coverage.agents_that_have_sub_agents} />
          <Stat
            label="Rakeback Deals"
            value={coverage.player_rakeback_deals}
            sub={`${coverage.player_rakeback_gap_breaches} gap breaches`}
            bad={coverage.player_rakeback_gap_breaches > 0}
          />
          <Stat
            label="Rates Out Of Policy"
            value={coverage.commission_rates_out_of_policy}
            sub={`band ${Math.round(coverage.policy_band.min * 100)}-${Math.round(coverage.policy_band.max * 100)}%`}
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
                  ? 'Distribution Healthy'
                  : `Over-Distributed By ${money(dist.over_distributed_by)}`}
              </strong>
              <div style={{ color: '#8fa3ad', fontSize: '0.82rem', marginTop: 6 }}>
                Rake Collected {money(dist.rake_collected)} · Commissions{' '}
                {money(dist.agent_commissions)} · Player Rakeback {money(dist.player_rakeback)} ·
                Distributed {money(dist.total_distributed)}
              </div>
            </div>
          )}

          {canRun && (
            <button
              onClick={() => void openPreview()}
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
              {busy ? 'Checking…' : 'Review & Run Settlement'}
            </button>
          )}
          <p style={{ color: '#66787f', fontSize: '0.78rem', margin: 0 }}>
            Round 1 Union Pays The Clubs · Round 2 Clubs Pay Super Agents And Agents · Round 3
            Agents Pay Their Players. Each Round Is Funded By The One Above It.
          </p>

          {rounds.length === 0 ? (
            <p style={{ color: '#8aa' }}>No Settlement Runs Recorded Yet.</p>
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

      {confirming && preview && (
        <SettlementConfirm
          preview={preview}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void runCascade()}
        />
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
                Union Law {law.healthy ? 'Healthy' : `- ${law.breaches.length} Breach(es)`}
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
              {busy ? 'Sweeping…' : 'Run Integrity Sweep (24h)'}
            </button>
          )}
          <p style={{ color: '#66787f', fontSize: '0.78rem', margin: 0 }}>
            {/* 2026-08-28: said "A Bot Or Colluding Ring". House rule, binding:
                AI players are never called bots — they are horses. */}
            Scored By Agent, Not By Player: A Horse Or Colluding Ring Has To Be Funded And Settled
            By Someone, And That Is The Accountable Layer.
          </p>
        </div>
      )}
    </div>
  );
}

{
  /* PREVIEW / CONFIRM — settlement moves money across every club, agent and
    player in the union. It used to fire on a single click with no idea of
    what it would do. */
}
function SettlementConfirm({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: SettlementPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const nothingToDo = Number(preview.total_to_move) === 0;
  return (
    <div
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '86vh',
          overflowY: 'auto',
          borderRadius: 14,
          padding: 20,
          background: '#101a1f',
          border: '1px solid #24343d',
        }}
      >
        <h3 style={{ margin: '0 0 2px', color: '#e6f1f5' }}>Run Settlement</h3>
        <p style={{ color: '#7d919b', fontSize: '0.8rem', marginTop: 0 }}>
          {new Date(preview.period_start).toLocaleDateString()} -{' '}
          {new Date(preview.period_end).toLocaleDateString()}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '14px 0' }}>
          <Row
            label="Round 1 · Union → Clubs"
            value={
              preview.round1.already_executed
                ? 'already settled'
                : `treasury ${money(preview.round1.rake_treasury_available)}`
            }
          />
          <Row
            label={`Round 2 · Clubs → Agents (${preview.round2.payees})`}
            value={money(preview.round2.amount)}
          />
          <Row
            label={`Round 3 · Agents → Players (${preview.round3.payees})`}
            value={money(preview.round3.amount)}
          />
          <div
            style={{
              borderTop: '1px solid #24343d',
              marginTop: 4,
              paddingTop: 8,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <strong style={{ color: '#e6f1f5' }}>Total To Move</strong>
            <strong style={{ color: '#37e7c7' }}>{money(preview.total_to_move)}</strong>
          </div>
        </div>

        {preview.has_blockers && (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              marginBottom: 14,
              border: '1px solid #6b4a12',
              background: 'rgba(255,179,71,0.08)',
            }}
          >
            <strong style={{ color: '#ffb347' }}>
              {preview.round2.clubs_short + preview.round3.agents_short} Payer(s) Cannot Cover Their
              Obligation
            </strong>
            <p style={{ color: '#c8a15e', fontSize: '0.78rem', margin: '6px 0 8px' }}>
              These Will Be Skipped And Reported As Shortfalls. Everyone Else Is Still Paid.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, color: '#d8b784', fontSize: '0.8rem' }}>
              {preview.round2.detail.slice(0, 6).map((d, i) => (
                <li key={`c${i}`}>
                  {d.club ?? 'Club'} Owes {money(d.owed)}, Treasury {money(d.treasury)} - Short{' '}
                  {money(d.short_by)}
                </li>
              ))}
              {preview.round3.detail.slice(0, 6).map((d, i) => (
                <li key={`a${i}`}>
                  {d.agent ?? 'Agent'} Owes {money(d.owed)}, Balance {money(d.agent_balance)} -
                  Short {money(d.short_by)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {nothingToDo && (
          <p style={{ color: '#8fa3ad', fontSize: '0.85rem' }}>
            Nothing Outstanding For This Period - Running Again Is Safe And Will Move Nothing.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '9px 14px',
              borderRadius: 8,
              border: '1px solid #2a3a44',
              background: 'transparent',
              color: '#8fa3ad',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || nothingToDo}
            style={{
              padding: '9px 16px',
              borderRadius: 8,
              border: '1px solid #37e7c7',
              background: 'rgba(55,231,199,0.12)',
              color: '#37e7c7',
              fontWeight: 700,
              opacity: nothingToDo ? 0.4 : 1,
              cursor: busy ? 'wait' : nothingToDo ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Settling…' : `Settle ${money(preview.total_to_move)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.86rem' }}>
      <span style={{ color: '#8fa3ad' }}>{label}</span>
      <span style={{ color: '#e6f1f5' }}>{value}</span>
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
