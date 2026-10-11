/**
 * UNION OPS PANEL
 *
 * The union owner's operating view. Everything here was previously SQL-only:
 * risk by agent, hierarchy coverage, the three-round settlement record,
 * distribution safety and the union-law self-test.
 *
 * Drops into any union surface as <UnionOpsPanel unionId={...} canRun={isOwner} />.
 * The union is required. This panel used to default to one hardcoded union,
 * so a surface that named none (the platform Financial Admin Hub) reviewed and
 * swept that union's books whatever its viewer meant. Without a
 * union id it now says so and asks the database nothing.
 * Read-only for anyone who is not an overseer — the RPCs enforce that server
 * side too, this just avoids showing buttons that would fail.
 */

import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  UnionOpsService,
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
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { compactChips } from '../../utils/format';
import './UnionOpsPanel.css';

type Tab = 'risk' | 'hierarchy' | 'settlement' | 'integrity';
type LoadTarget = { unionId: string; tab: Tab };

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['risk', 'Risk By Agent'],
  ['hierarchy', 'Hierarchy'],
  ['settlement', 'Settlement'],
  ['integrity', 'Integrity'],
];

const sameTarget = (left: LoadTarget, right: LoadTarget) =>
  left.unionId === right.unionId && left.tab === right.tab;

const money = (n: unknown) => compactChips(Number(n) || 0);

// Settlement periods are database date contracts, not local instants. Pin the
// formatter to UTC so a YYYY-MM-DD never rolls back a day west of Greenwich.
const contractDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  );
};

const findingText = (finding: Record<string, unknown>) =>
  Object.entries(finding)
    .map(([key, value]) => {
      const label = titleCase(key.replace(/_/g, ' '));
      const printable =
        typeof value === 'string' ? titleCase(value.replace(/_/g, ' ')) : String(value);
      return `${label}: ${printable}`;
    })
    .join(' · ');

interface Props {
  /** The union every read, scheduled preview and integrity sweep below acts on. */
  unionId: string;
  canRun?: boolean;
}

export default function UnionOpsPanel({ unionId, canRun = false }: Props) {
  // The type requires a union, but a caller can still hand over an id it has
  // not resolved yet. Refuse it here, before any read or run can start.
  if (typeof unionId !== 'string' || unionId.trim() === '') {
    return (
      <div role="status" className="sc-copy sc-ink--muted" style={{ padding: 16 }}>
        No Union Selected
      </div>
    );
  }
  return <UnionOpsPanelForUnion key={unionId} unionId={unionId} canRun={canRun} />;
}

function UnionOpsPanelForUnion({ unionId, canRun }: { unionId: string; canRun: boolean }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('risk');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [risk, setRisk] = useState<AgentRiskRow[]>([]);
  const [coverage, setCoverage] = useState<UnionCoverage | null>(null);
  const [rounds, setRounds] = useState<SettlementRound[]>([]);
  const [dist, setDist] = useState<DistributionCheck | null>(null);
  const [law, setLaw] = useState<LawSelfTest | null>(null);
  const lawFindingCount = law ? law.breaches.length + law.warnings.length : 0;
  // A producer's `healthy` bit cannot overrule the findings printed directly
  // beneath it. Any breach or warning is an attention state, never a green
  // "Healthy" headline.
  const lawNeedsAttention = Boolean(law && (!law.healthy || lawFindingCount > 0));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tabsetId = useId();
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const activeTarget = useRef<LoadTarget>({ unionId, tab });
  activeTarget.current = { unionId, tab };

  const load = useCallback(async (target: LoadTarget) => {
    if (!sameTarget(target, activeTarget.current)) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      // Each tab owns exactly its read. Running a universal authorisation
      // probe here used to make every click pay for Hierarchy as well as its
      // requested report, and a failed probe hid otherwise independent tabs.
      if (target.tab === 'hierarchy') {
        const nextCoverage = await UnionOpsService.getCoverageStrict(target.unionId);
        if (generation !== loadGeneration.current || !sameTarget(target, activeTarget.current))
          return;
        setCoverage(nextCoverage);
      } else if (target.tab === 'risk') {
        const nextRisk = await UnionOpsService.getAgentRisk(target.unionId);
        if (generation !== loadGeneration.current || !sameTarget(target, activeTarget.current))
          return;
        setRisk(nextRisk);
      } else if (target.tab === 'settlement') {
        const [rs, d] = await Promise.all([
          UnionOpsService.getSettlementRounds(target.unionId),
          UnionOpsService.getDistributionCheck(target.unionId),
        ]);
        if (generation !== loadGeneration.current || !sameTarget(target, activeTarget.current))
          return;
        setRounds(rs);
        setDist(d);
      } else if (target.tab === 'integrity') {
        const nextLaw = await UnionOpsService.getLawSelfTest();
        if (generation !== loadGeneration.current || !sameTarget(target, activeTarget.current))
          return;
        setLaw(nextLaw);
      }
    } catch (e) {
      if (generation !== loadGeneration.current || !sameTarget(target, activeTarget.current))
        return;
      setLoadError(describeRpcError(e));
      reportError(e, 'UnionOpsPanel.load');
    } finally {
      if (generation === loadGeneration.current && sameTarget(target, activeTarget.current)) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const target = { unionId, tab };
    void load(target);
    return () => {
      loadGeneration.current += 1;
    };
  }, [load, tab, unionId]);

  useEffect(() => {
    setConfirming(false);
    setPreview(null);
  }, [unionId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openPreview = async () => {
    if (busy) return;
    const target = { ...activeTarget.current };
    setBusy(true);
    try {
      const nextPreview = await UnionOpsService.getSettlementPreview(target.unionId);
      if (!mounted.current || !sameTarget(target, activeTarget.current)) return;
      setPreview(nextPreview);
      setConfirming(true);
    } catch (e) {
      if (!mounted.current || !sameTarget(target, activeTarget.current)) return;
      toast.error(describeRpcError(e));
      reportError(e, 'UnionOpsPanel.openPreview');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const runSweep = async () => {
    if (busy) return;
    const target = { ...activeTarget.current };
    setBusy(true);
    try {
      const res = await UnionOpsService.runIntegritySweep(target.unionId, 24);
      if (!mounted.current || !sameTarget(target, activeTarget.current)) return;
      const n = res.signals;
      if (n === 0) toast.success('Selected Union Integrity Sweep Clean');
      else toast.info(`Selected Union Integrity Sweep Raised ${n} Signal(s)`);
      if (mounted.current && sameTarget(target, activeTarget.current)) await load(target);
    } catch (e) {
      if (!mounted.current || !sameTarget(target, activeTarget.current)) return;
      reportError(e, 'UnionOpsPanel.runSweep');
      toast.error(describeRpcError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const selectTab = (nextTab: Tab, focus = false) => {
    setConfirming(false);
    setTab(nextTab);
    if (focus) requestAnimationFrame(() => tabRefs.current[nextTab]?.focus());
  };

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const index = TABS.findIndex(([id]) => id === current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(TABS[nextIndex][0], true);
  };

  return (
    <div className="union-ops-panel">
      <div className="union-ops-panel__nav">
        <div className="union-ops-panel__tabs" role="tablist" aria-label="Union Operations">
          {TABS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              ref={(node) => {
                tabRefs.current[id] = node;
              }}
              id={`${tabsetId}-tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className="union-ops-panel__tab"
              onClick={() => selectTab(id)}
              onKeyDown={(event) => handleTabKey(event, id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="union-ops-panel__tab union-ops-panel__refresh"
          onClick={() => void load(activeTarget.current)}
        >
          Refresh
        </button>
      </div>

      <div
        id={`${tabsetId}-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`${tabsetId}-tab-${tab}`}
        tabIndex={0}
      >
        {loading && (
          <div className="union-ops-panel__status sc-copy">Loading Union Operations…</div>
        )}

        {!loading && loadError && (
          <div role="alert" className="union-ops-panel__status union-ops-panel__status--error">
            <span>{loadError}</span>
            <button
              type="button"
              className="union-ops-panel__lit-action union-ops-panel__lit-action--error"
              onClick={() => void load(activeTarget.current)}
            >
              Retry
            </button>
          </div>
        )}

        {/* RISK BY AGENT — the accountable layer */}
        {!loading && !loadError && tab === 'risk' && (
          <div className="union-ops-panel__table-scroll">
            {risk.length === 0 ? (
              <p className="sc-ink--muted">No Agent Activity In This Period.</p>
            ) : (
              <table className="union-ops-panel__data-table">
                <thead>
                  <tr className="sc-ink--muted" style={{ textAlign: 'left' }}>
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
                      className="union-ops-panel__engraved-row"
                    >
                      <td className="sc-ink--white" style={{ padding: 8 }}>
                        {r.agent_name ? titleCase(r.agent_name) : 'Unnamed Agent'}
                      </td>
                      <td className="sc-ink--muted" style={{ padding: 8 }}>
                        {titleCase(r.club_name)}
                      </td>
                      <td className="sc-ink--muted" style={{ padding: 8 }}>
                        {titleCase(r.role.replace(/_/g, ' '))}
                      </td>
                      <td style={{ padding: 8, textAlign: 'right' }}>{r.players}</td>
                      <td style={{ padding: 8, textAlign: 'right' }}>{r.seated_now}</td>
                      <td style={{ padding: 8, textAlign: 'right' }}>{money(r.rake_generated)}</td>
                      <td
                        className={Number(r.player_net) > 0 ? 'sc-ink--red' : 'sc-ink--green'}
                        style={{ padding: 8, textAlign: 'right' }}
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
            <p className="sc-ink--muted" style={{ fontSize: '0.78rem', marginTop: 10 }}>
              Player Net Is Shown From The Union's Side: Red Means That Agent's Players Are Up.
            </p>
          </div>
        )}

        {/* HIERARCHY HEALTH */}
        {!loading && !loadError && tab === 'hierarchy' && coverage && (
          <div className="union-ops-panel__stat-list">
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
              sub={`band ${(coverage.policy_band.min * 100).toFixed(1)}-${(coverage.policy_band.max * 100).toFixed(1)}%`}
              bad={coverage.commission_rates_out_of_policy > 0}
            />
          </div>
        )}
        {!loading && !loadError && tab === 'hierarchy' && !coverage && (
          <div className="union-ops-panel__engraved sc-ink--muted">
            Hierarchy Coverage Is Unavailable.
          </div>
        )}

        {/* SETTLEMENT — the three rounds */}
        {!loading && !loadError && tab === 'settlement' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {dist && (
              <div
                className={`union-ops-panel__engraved ${dist.healthy ? '' : 'union-ops-panel__engraved--error'}`}
                style={{
                  padding: 12,
                }}
              >
                <strong className={dist.healthy ? 'sc-ink--green' : 'sc-ink--red'}>
                  {dist.healthy
                    ? 'Distribution Healthy'
                    : `Over-Distributed By ${money(dist.over_distributed_by)}`}
                </strong>
                <div className="sc-ink--muted" style={{ fontSize: '0.82rem', marginTop: 6 }}>
                  Rake Collected {money(dist.rake_collected)} · Commissions{' '}
                  {money(dist.agent_commissions)} · Player Rakeback {money(dist.player_rakeback)} ·
                  Distributed {money(dist.total_distributed)}
                </div>
              </div>
            )}
            {!dist && (
              <div className="union-ops-panel__engraved sc-ink--muted">
                Distribution Reading Is Unavailable.
              </div>
            )}

            {canRun && (
              <button
                type="button"
                onClick={() => void openPreview()}
                disabled={busy}
                className="union-ops-panel__lit-action"
                style={{
                  alignSelf: 'flex-start',
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                {busy ? 'Checking…' : 'Review Scheduled Settlement'}
              </button>
            )}
            <p className="sc-ink--muted" style={{ fontSize: '0.78rem', margin: 0 }}>
              Round 1 Union Pays The Clubs · Round 2 Clubs Pay Super Agents And Agents · Round 3
              Agents Pay Their Players. Each Round Is Funded By The One Above It.
            </p>

            {rounds.length === 0 ? (
              <p className="sc-ink--muted">No Settlement Runs Recorded Yet.</p>
            ) : (
              <div
                className="union-ops-panel__table-scroll"
                data-mobile-width="393"
                style={{ maxWidth: '100%', overflowX: 'auto' }}
              >
                <table className="union-ops-panel__data-table" style={{ minWidth: 680 }}>
                  <thead>
                    <tr className="sc-ink--muted" style={{ textAlign: 'left' }}>
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
                      <tr key={i} className="union-ops-panel__engraved-row">
                        <td className="sc-ink--white" style={{ padding: 8 }}>
                          {r.round_no}
                        </td>
                        <td className="sc-ink--muted" style={{ padding: 8 }}>
                          {titleCase(r.round_name.replace(/_/g, ' '))}
                        </td>
                        <td style={{ padding: 8, textAlign: 'right' }}>{r.payees}</td>
                        <td className="sc-ink--blue" style={{ padding: 8, textAlign: 'right' }}>
                          {money(r.amount)}
                        </td>
                        <td
                          className={r.shortfalls ? 'sc-ink--gold' : 'sc-ink--muted'}
                          style={{ padding: 8, textAlign: 'right' }}
                        >
                          {r.shortfalls}
                        </td>
                        <td className="sc-ink--muted" style={{ padding: 8 }}>
                          {new Date(r.executed_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!loading && !loadError && confirming && preview && (
          <SettlementConfirm preview={preview} onCancel={() => setConfirming(false)} />
        )}

        {/* INTEGRITY + UNION LAW */}
        {!loading && !loadError && tab === 'integrity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {law?.available === false ? (
              <div className="union-ops-panel__engraved sc-ink--muted">
                <strong>Union Law Audit Status: {titleCase(law.run_status ?? 'Pending')}</strong>
                <div style={{ fontSize: '0.82rem', marginTop: 6 }}>
                  {titleCase(law.note ?? 'The Detailed Verdict Is Not Available Yet.')}
                </div>
              </div>
            ) : law ? (
              <div
                className={`union-ops-panel__engraved ${lawNeedsAttention ? 'union-ops-panel__engraved--error' : ''}`}
                style={{
                  padding: 12,
                }}
              >
                <strong className={lawNeedsAttention ? 'sc-ink--red' : 'sc-ink--green'}>
                  Union Law{' '}
                  {lawNeedsAttention
                    ? `Attention Required - ${lawFindingCount} Finding(s)`
                    : 'Healthy'}
                </strong>
                {law.breaches.length > 0 && (
                  <ul
                    className="sc-ink--red"
                    style={{ fontSize: '0.82rem', margin: '8px 0 0 18px' }}
                  >
                    {law.breaches.map((b, i) => (
                      <li key={i}>{findingText(b)}</li>
                    ))}
                  </ul>
                )}
                {law.warnings.length > 0 && (
                  <ul
                    className="sc-ink--gold"
                    style={{ fontSize: '0.82rem', margin: '8px 0 0 18px' }}
                  >
                    {law.warnings.map((w, i) => (
                      <li key={i}>{findingText(w)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="union-ops-panel__engraved sc-ink--muted">
                Union Law Verdict Is Unavailable.
              </div>
            )}
            {canRun && (
              <button
                type="button"
                onClick={() => void runSweep()}
                disabled={busy}
                aria-label="Run Integrity Sweep (24h)"
                className="union-ops-panel__lit-action"
                style={{
                  alignSelf: 'flex-start',
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                {busy ? 'Operation In Progress…' : 'Run Integrity Sweep (24h)'}
              </button>
            )}
            <p className="sc-ink--muted" style={{ fontSize: '0.78rem', margin: 0 }}>
              {/* 2026-08-28: said "A Bot Or Colluding Ring". House rule, binding:
                AI players are never called bots — they are horses. */}
              Scored By Agent, Not By Player: A Horse Or Colluding Ring Has To Be Funded And Settled
              By Someone, And That Is The Accountable Layer.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

{
  /* READ-ONLY SCHEDULED PREVIEW — the private weekly coordinator moves money;
    the browser only reviews its exact period and recorded obligations. */
}
function SettlementConfirm({
  preview,
  onCancel,
}: {
  preview: SettlementPreview;
  onCancel: () => void;
}) {
  const nothingOutstanding = preview.round1.already_executed && Number(preview.total_to_move) === 0;
  const dialogRef = useFocusTrap<HTMLDivElement>(true, '#union-settlement-context');
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onCancel]);
  // The portal must lock its page before the committed dialog can be painted.
  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={dialogRef}
      className="union-ops-panel__overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="union-settlement-title"
      onClick={onCancel}
    >
      <div className="union-ops-panel__dialog" onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          family="spade"
          crest="flat"
          eyebrow="Union Operations"
          title="Scheduled Settlement Review"
          titleId="union-settlement-title"
          pill={nothingOutstanding ? 'Clear' : 'Review'}
          pillInk={preview.has_blockers ? 'gold' : 'blue'}
          onClose={onCancel}
          foot="foot"
        >
          <p
            id="union-settlement-context"
            tabIndex={-1}
            className="sc-ink--muted"
            style={{ fontSize: '0.8rem', marginTop: 0 }}
          >
            The Audited Weekly Close Runs Automatically. This Review Cannot Execute A Settlement.
          </p>
          <p className="sc-ink--muted" style={{ fontSize: '0.8rem' }}>
            {contractDate(preview.period_start)} - {contractDate(preview.period_end)}
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
              className="union-ops-panel__engraved-row"
              style={{
                marginTop: 4,
                paddingTop: 8,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <strong className="sc-ink--white">Round 2 + 3 Pending</strong>
              <strong className="sc-ink--blue">{money(preview.total_to_move)}</strong>
            </div>
          </div>

          {preview.has_blockers && (
            <div
              className="union-ops-panel__engraved union-ops-panel__engraved--warning"
              style={{
                padding: 12,
                marginBottom: 14,
              }}
            >
              <strong className="sc-ink--gold">
                {preview.round2.clubs_short + preview.round3.agents_short} Payer(s) Cannot Cover
                Their Obligation
              </strong>
              <p className="sc-ink--gold" style={{ fontSize: '0.78rem', margin: '6px 0 8px' }}>
                Funded Recipients May Already Be Paid, But The Period Remains Unsettled Until Every
                Shortfall Is Cleared. Review Recorded Rounds Before Any Retry.
              </p>
              <ul
                className="sc-ink--gold"
                style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem' }}
              >
                {preview.round2.detail.slice(0, 6).map((d, i) => (
                  <li key={`c${i}`}>
                    {titleCase(d.club ?? 'Club')} Owes {money(d.owed)}, Treasury {money(d.treasury)}{' '}
                    - Short {money(d.short_by)}
                  </li>
                ))}
                {preview.round3.detail.slice(0, 6).map((d, i) => (
                  <li key={`a${i}`}>
                    {titleCase(d.agent ?? 'Agent')} Owes {money(d.owed)}, Balance{' '}
                    {money(d.agent_balance)} - Short {money(d.short_by)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!preview.round1.already_executed && (
            <p className="sc-ink--gold" style={{ fontSize: '0.85rem' }}>
              Round 1 Is Not Yet Recorded. Its Amount Is Not Estimated By This Preview.
            </p>
          )}

          {nothingOutstanding && (
            <p className="sc-ink--muted" style={{ fontSize: '0.85rem' }}>
              Nothing Outstanding For This Period. The Scheduled Close Will Move Nothing Unless New
              Obligations Are Recorded.
            </p>
          )}
          <button
            type="button"
            className="union-ops-panel__lit-action union-ops-panel__lit-action--muted"
            onClick={onCancel}
          >
            Close
          </button>
        </SpadeConsole>
      </div>
    </div>,
    document.body
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.86rem' }}>
      <span className="sc-ink--muted">{label}</span>
      <span className="sc-ink--white">{titleCase(value)}</span>
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
      className={`union-ops-panel__stat ${bad ? 'union-ops-panel__stat--bad' : ''}`}
      style={{
        padding: 12,
      }}
    >
      <div className="union-ops-panel__stat-copy">
        <div className="sc-label sc-ink--blue" style={{ fontSize: '0.75rem', letterSpacing: 0.5 }}>
          {label}
        </div>
        {sub && (
          <div className="sc-ink--muted" style={{ fontSize: '0.75rem', marginTop: 2 }}>
            {titleCase(sub)}
          </div>
        )}
      </div>
      <div
        className={bad ? 'sc-ink--red' : 'sc-ink--white'}
        style={{ fontSize: '1.15rem', fontWeight: 700, textAlign: 'right' }}
      >
        {value}
      </div>
    </div>
  );
}
