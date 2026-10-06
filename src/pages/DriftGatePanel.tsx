/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DRIFT GATE PANEL - Burn-In Gate Status, Supply Trends, Balance As-Of
 * ═══════════════════════════════════════════════════════════════════════════
 * Zero-drift phase 5. Renders on the Drift Incidents page for management:
 *   1. The Midway burn-in gate's latest hourly run (PASS/FAIL + which of the
 *      12 checks failed) - the reopen decision at a glance.
 *   2. 24h sparklines of unexplained chip and diamond supply movement (the
 *      trailing sums that page when a real leak appears).
 *   3. A balance as-of tool: point-in-time reconstruction of any entity's
 *      balance from the ledger (fn_ca_balance_asof_admin).
 * Read-only: every RPC consults the caller server-side and returns null for
 * non-management accounts, so this panel simply hides itself for them.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import {
  DriftIncidentService,
  type BalanceAsOfReadout,
  type GatePanelData,
} from '../services/DriftIncidentService';
import { compactChips } from '../utils/format';
import { enumToTitleCase } from '../utils/titleCase';
import { isAuthzError } from '../utils/clubDashboard';

const ENTITY_TYPES = ['club', 'union', 'player', 'agent'] as const;

function Sparkline({
  points,
  label,
  width = 220,
  height = 44,
}: {
  points: { t: string; v: number }[];
  label: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <span className="dgp-spark-empty">Not Enough Data Yet</span>;
  }
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (v: number) => height - ((v - min) / span) * (height - 6) - 3;
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(' ');
  const zeroY = y(0);
  const last = vals[vals.length - 1];
  return (
    <svg
      className="dgp-spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${label} From ${compactChips(vals[0])} To ${compactChips(last)}`}
    >
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} className="dgp-spark-zero" />
      <path
        d={path}
        className={`dgp-spark-line ${Math.abs(last) > 0.005 ? 'off' : 'flat'}`}
        fill="none"
      />
    </svg>
  );
}

export default function DriftGatePanel() {
  const [panel, setPanel] = useState<GatePanelData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [entityType, setEntityType] = useState<(typeof ENTITY_TYPES)[number]>('club');
  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [asOfResult, setAsOfResult] = useState<BalanceAsOfReadout | null>(null);
  const [asOfError, setAsOfError] = useState<string | null>(null);
  const [asOfBusy, setAsOfBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const revokeAccess = useCallback(() => {
    setHidden(true);
    setPanel(null);
    setLoadError(null);
    setAsOfResult(null);
    setAsOfError(null);
    setEntityType('club');
    setEntityId('');
    setAsOf('');
  }, []);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const data = await DriftIncidentService.getGatePanel();
        if (!isCurrent()) return;
        if (data === null) {
          // A verified null is the server's management refusal. Transport and
          // malformed-response failures reject instead, so they can never hide
          // a safety gate or masquerade as an authorization decision.
          revokeAccess();
          return;
        }
        setHidden(false);
        setPanel(data);
        setLoadError(null);
      } catch (error) {
        if (!isCurrent()) return;
        if (isAuthzError(error)) {
          revokeAccess();
          return;
        }
        setHidden(false);
        setLoadError('Gate Data Unavailable. No Reopen Decision Can Be Verified.');
      } finally {
        loadingRef.current = false;
        if (isCurrent()) setLoading(false);
      }
    },
    [revokeAccess]
  );

  useEffect(() => {
    let isCurrent = true;
    const current = () => isCurrent;
    load(current);
    const timer = setInterval(() => load(current), 60_000);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [load]);

  const runAsOf = async () => {
    if (!entityId.trim() || !asOf) return;
    setAsOfBusy(true);
    setAsOfResult(null);
    setAsOfError(null);
    try {
      const res = await DriftIncidentService.getBalanceAsOf(
        entityType,
        entityId.trim(),
        new Date(asOf).toISOString()
      );
      if (res === null) {
        setAsOfError('Balance Readout Unavailable. Management Access Could Not Be Verified.');
      } else {
        setAsOfResult(res);
      }
    } catch (error) {
      if (isAuthzError(error)) {
        revokeAccess();
        return;
      }
      setAsOfError('Balance Readout Unavailable. No Ledger Result Can Be Verified.');
    } finally {
      setAsOfBusy(false);
    }
  };

  if (hidden) return null;

  if (panel === null) {
    return (
      <SpadeConsole
        className="dgp-console"
        family="spade"
        crest="spade"
        eyebrow="Financial Integrity"
        title="Burn-In Gate"
        pill={loading ? 'Loading' : 'Unavailable'}
        pillInk={loading ? 'muted' : 'red'}
        foot="foot"
        aria-busy={loading || undefined}
      >
        <p
          className={`sc-copy sc-copy--center sc-ink--${loadError ? 'red' : 'muted'}`}
          role={loadError ? 'alert' : 'status'}
        >
          {loadError ?? 'Loading Gate Data...'}
        </p>
        {loadError && (
          <button
            type="button"
            className="di-word sc-ink--blue"
            onClick={() => load()}
            disabled={loading}
          >
            Retry
          </button>
        )}
      </SpadeConsole>
    );
  }

  const gate = panel.gate;
  const gateAgeMin = gate
    ? Math.max(0, Math.round((Date.now() - new Date(gate.run_at).getTime()) / 60_000))
    : null;
  const gateStale = gateAgeMin !== null && gateAgeMin > 120;
  const gatePill = loading
    ? 'Syncing'
    : loadError
      ? 'Last Verified'
      : gate === null
        ? 'No Run'
        : gateStale
          ? 'Stale'
          : gate.pass
            ? 'Green'
            : 'Red';
  const gateInk: ConsoleInk = loading
    ? 'muted'
    : loadError || gateStale || (gate !== null && !gate.pass)
      ? 'red'
      : gate === null
        ? 'muted'
        : 'green';
  const supplySeries = (panel.supply_series || [])
    .filter((s) => s.unexplained !== null)
    .map((s) => ({ t: s.taken_at, v: Number(s.unexplained) }))
    .filter((s) => Number.isFinite(s.v));
  const diamondSeries = (panel.diamond_series || [])
    .filter((s) => s.unexplained !== null)
    .map((s) => ({ t: s.taken_at, v: Number(s.unexplained) }))
    .filter((s) => Number.isFinite(s.v));

  return (
    <SpadeConsole
      className="dgp-console"
      family="spade"
      crest="spade"
      eyebrow="Financial Integrity"
      title="Burn-In Gate"
      pill={gatePill}
      pillInk={gateInk}
      foot="foot"
      aria-busy={loading || undefined}
    >
      {loadError && (
        <p className="sc-copy sc-ink--red" role="status">
          {loadError} Showing The Last Verified Gate.
        </p>
      )}

      <dl className="dgp-facts">
        <div className="dgp-fact">
          <dt className="sc-label sc-ink--blue">Gate Window</dt>
          <dd className="dgp-value sc-ink--silver">
            {gate ? `${compactChips(gate.window_hours)} Hours` : 'No Run Recorded'}
          </dd>
        </div>
        <div className="dgp-fact">
          <dt className="sc-label sc-ink--blue">Last Run</dt>
          <dd className="dgp-value sc-ink--silver">
            {gate
              ? `${new Date(gate.run_at).toLocaleString()} (${compactChips(gateAgeMin)} Minutes Ago)`
              : 'No Run Recorded'}
          </dd>
        </div>
      </dl>

      {gate && !gate.pass && gate.failing && gate.failing.length > 0 && (
        <div className="dgp-failures">
          <span className="sc-label sc-ink--red">Failing Checks</span>
          <ul className="dgp-gate-failing sc-copy">
            {gate.failing.map((failure) => (
              <li key={failure}>{enumToTitleCase(failure)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="dgp-trends">
        <section className="dgp-trend" aria-labelledby="dgp-chip-title">
          <h3 id="dgp-chip-title" className="sc-label sc-ink--blue">
            Unexplained Chip Supply (24 Hour)
          </h3>
          <Sparkline points={supplySeries} label="Unexplained Chip Supply Trend" />
          <span className="dgp-spark-caption sc-ink--muted">
            {supplySeries.length > 0
              ? `Latest ${compactChips(supplySeries[supplySeries.length - 1].v)} Chips`
              : 'No Verified Reading'}
          </span>
        </section>
        <section className="dgp-trend" aria-labelledby="dgp-diamond-title">
          <h3 id="dgp-diamond-title" className="sc-label sc-ink--blue">
            Unexplained Diamond Supply (24 Hour)
          </h3>
          <Sparkline points={diamondSeries} label="Unexplained Diamond Supply Trend" />
          <span className="dgp-spark-caption sc-ink--muted">
            {diamondSeries.length > 0
              ? `Latest ${compactChips(diamondSeries[diamondSeries.length - 1].v)} Diamonds`
              : 'No Verified Reading'}
          </span>
        </section>
      </div>

      <section className="dgp-asof" aria-labelledby="dgp-asof-title">
        <h3 id="dgp-asof-title" className="sc-label sc-ink--blue">
          Balance As Of (Ledger Reconstruction)
        </h3>
        <form
          className="dgp-asof-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void runAsOf();
          }}
        >
          <label className="dgp-control">
            <span className="sc-label sc-ink--muted">Entity Type</span>
            <select
              id="drift-asof-entity-type"
              aria-label="Entity Type"
              value={entityType}
              disabled={asOfBusy}
              onChange={(e) => {
                setEntityType(e.target.value as (typeof ENTITY_TYPES)[number]);
                setAsOfResult(null);
                setAsOfError(null);
              }}
            >
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {enumToTitleCase(type)}
                </option>
              ))}
            </select>
          </label>
          <label className="dgp-control">
            <span className="sc-label sc-ink--muted">Entity ID</span>
            <input
              aria-label="Entity ID"
              type="text"
              placeholder="Entity ID (UUID)"
              value={entityId}
              disabled={asOfBusy}
              onChange={(e) => {
                setEntityId(e.target.value);
                setAsOfResult(null);
                setAsOfError(null);
              }}
            />
          </label>
          <label className="dgp-control">
            <span className="sc-label sc-ink--muted">Balance As Of Time</span>
            <input
              aria-label="Balance As Of Time"
              type="datetime-local"
              value={asOf}
              disabled={asOfBusy}
              onChange={(e) => {
                setAsOf(e.target.value);
                setAsOfResult(null);
                setAsOfError(null);
              }}
            />
          </label>
          <button
            type="submit"
            className="di-word sc-ink--blue"
            disabled={asOfBusy || !entityId.trim() || !asOf}
          >
            {asOfBusy ? 'Reconstructing...' : 'Reconstruct'}
          </button>
        </form>
        {asOfError && (
          <p className="sc-copy sc-ink--red" role="status" aria-live="polite">
            {asOfError}
          </p>
        )}
        {asOfResult && (
          <dl className="dgp-facts dgp-asof-result" role="status" aria-live="polite">
            <div className="dgp-fact">
              <dt className="sc-label sc-ink--blue">Readout</dt>
              <dd className={`dgp-value sc-ink--${asOfResult.found ? 'green' : 'gold'}`}>
                {asOfResult.found ? 'Verified Balance' : 'No Recorded Balance'}
              </dd>
            </div>
            <div className="dgp-fact">
              <dt className="sc-label sc-ink--blue">Account Type</dt>
              <dd className="dgp-value sc-ink--silver">
                {enumToTitleCase(asOfResult.accountType)}
              </dd>
            </div>
            <div className="dgp-fact">
              <dt className="sc-label sc-ink--blue">As Of</dt>
              <dd className="dgp-value sc-ink--silver">
                {new Date(asOfResult.asOf).toLocaleString()}
              </dd>
            </div>
            {asOfResult.found && (
              <>
                <div className="dgp-fact">
                  <dt className="sc-label sc-ink--blue">Balance</dt>
                  <dd className="dgp-value sc-ink--silver">
                    {compactChips(asOfResult.balance)} Chips
                  </dd>
                </div>
                <div className="dgp-fact">
                  <dt className="sc-label sc-ink--blue">Recorded</dt>
                  <dd className="dgp-value sc-ink--silver">
                    {new Date(asOfResult.recordedAt).toLocaleString()}
                  </dd>
                </div>
                <div className="dgp-fact">
                  <dt className="sc-label sc-ink--blue">Ledger Direction</dt>
                  <dd className="dgp-value sc-ink--silver">{asOfResult.direction}</dd>
                </div>
              </>
            )}
          </dl>
        )}
      </section>
    </SpadeConsole>
  );
}
