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
import { useState, useEffect, useCallback } from 'react';
import { DriftIncidentService, type GatePanelData } from '../services/DriftIncidentService';

const ENTITY_TYPES = ['club', 'union', 'player', 'agent'] as const;

function Sparkline({
  points,
  width = 220,
  height = 44,
}: {
  points: { t: string; v: number }[];
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
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const last = vals[vals.length - 1];
  return (
    <svg className="dgp-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} className="dgp-spark-zero" />
      <path d={path} className={`dgp-spark-line ${Math.abs(last) > 0.005 ? 'off' : 'flat'}`} fill="none" />
    </svg>
  );
}

export default function DriftGatePanel() {
  const [panel, setPanel] = useState<GatePanelData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [entityType, setEntityType] = useState<string>('club');
  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [asOfResult, setAsOfResult] = useState<string | null>(null);
  const [asOfBusy, setAsOfBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await DriftIncidentService.getGatePanel();
    if (data === null) {
      // Null means non-management OR a transient RPC failure (the service
      // returns null for both). Only hide when we have never had data;
      // once management data has rendered, keep the last good panel and
      // let the next 60s tick recover - a mid-flight drop must not blank
      // the reopen decision.
      setPanel((prev) => {
        if (prev === null) setHidden(true);
        return prev;
      });
      return;
    }
    setHidden(false);
    setPanel(data);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const runAsOf = async () => {
    if (!entityId.trim() || !asOf) return;
    setAsOfBusy(true);
    setAsOfResult(null);
    try {
      const res = await DriftIncidentService.getBalanceAsOf(
        entityType,
        entityId.trim(),
        new Date(asOf).toISOString()
      );
      setAsOfResult(res === null ? 'No Result (Check The Id And Time)' : JSON.stringify(res, null, 2));
    } catch {
      setAsOfResult('Lookup Failed');
    } finally {
      setAsOfBusy(false);
    }
  };

  if (hidden || panel === null) return null;

  const gate = panel.gate;
  const supplySeries = (panel.supply_series || [])
    .filter((s) => s.unexplained !== null)
    .map((s) => ({ t: s.taken_at, v: Number(s.unexplained) }));
  const diamondSeries = (panel.diamond_series || [])
    .filter((s) => s.unexplained !== null)
    .map((s) => ({ t: s.taken_at, v: Number(s.unexplained) }));

  return (
    <div className="dgp-panel">
      <div className="dgp-row">
        <div className="dgp-card dgp-gate">
          <span className="dgp-label">Midway Burn-In Gate</span>
          {gate ? (
            <>
              {(() => {
                // The gate runs hourly. A run older than two hours means the
                // cron is stalled, and a stale GREEN is a lie an operator
                // could reopen Midway on - say STALE instead.
                const ageMin = Math.round((Date.now() - new Date(gate.run_at).getTime()) / 60000);
                const stale = ageMin > 120;
                return (
                  <>
                    <span
                      className={`dgp-gate-pill ${stale ? 'stale' : gate.pass ? 'pass' : 'fail'}`}
                    >
                      {stale ? 'STALE' : gate.pass ? 'GREEN' : 'RED'}
                    </span>
                    <span className="dgp-gate-meta">
                      {gate.window_hours}h Window, Run{' '}
                      {new Date(gate.run_at).toLocaleString()} ({ageMin}m Ago)
                    </span>
                  </>
                );
              })()}
              {!gate.pass && gate.failing && gate.failing.length > 0 && (
                <ul className="dgp-gate-failing">
                  {gate.failing.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="dgp-spark-empty">No Gate Run Recorded Yet</span>
          )}
        </div>
        <div className="dgp-card">
          <span className="dgp-label">Unexplained Chip Supply (24h)</span>
          <Sparkline points={supplySeries} />
          <span className="dgp-spark-caption">
            {supplySeries.length > 0
              ? `Latest ${supplySeries[supplySeries.length - 1].v.toFixed(2)} Chips`
              : ''}
          </span>
        </div>
        <div className="dgp-card">
          <span className="dgp-label">Unexplained Diamond Supply (24h)</span>
          <Sparkline points={diamondSeries} />
          <span className="dgp-spark-caption">
            {diamondSeries.length > 0
              ? `Latest ${diamondSeries[diamondSeries.length - 1].v.toFixed(2)} Diamonds`
              : ''}
          </span>
        </div>
      </div>
      <div className="dgp-card dgp-asof">
        <span className="dgp-label">Balance As Of (Ledger Reconstruction)</span>
        <div className="dgp-asof-controls">
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Entity ID (UUID)"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
          <input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <button onClick={runAsOf} disabled={asOfBusy || !entityId.trim() || !asOf}>
            {asOfBusy ? 'Reconstructing...' : 'Reconstruct'}
          </button>
        </div>
        {asOfResult && <pre className="dgp-asof-result">{asOfResult}</pre>}
      </div>
    </div>
  );
}
