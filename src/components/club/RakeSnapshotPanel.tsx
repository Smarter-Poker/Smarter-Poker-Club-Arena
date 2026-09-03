/**
 * RAKE SNAPSHOT — one strip that answers "how are we doing".
 *
 * The ledger below this panel lists games. This panel does not: it reads the
 * daily rollups only, which is why it can be asked for a year when the ledger
 * clamps at 93 days, and why switching from Day to Year does not cost a
 * different order of magnitude of query.
 *
 * Scope chips are built from what the viewer actually holds. A club owner with
 * no union sees Club alone; a union owner sees Union and Club; an agent sees
 * Downline. The database refuses anything else on its own — the chips exist so
 * nobody is offered a button that will only tell them no.
 *
 * Zeros are a lie on this page (Dan 2026-08-25): a failed read shows dashes,
 * never a confident 0.00.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClubRakeSnapshotService,
  RAKE_PERIODS,
  describeRakeSnapshotError,
  periodToRange,
  type PeriodKey,
  type RakeScope,
  type RakeSnapshot,
} from '../../services/ClubRakeSnapshotService';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import styles from './RakeSnapshotPanel.module.css';

const NO_VALUE = '-';
const REFRESH_MS = 60_000;

const SCOPE_COPY: Record<RakeScope, { label: string; note: string }> = {
  union: { label: 'Union', note: 'Every Club Beneath The Union' },
  club: { label: 'Club', note: 'This Club Only' },
  agent: { label: 'Downline', note: 'Players Beneath You' },
};

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return NO_VALUE;
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return NO_VALUE;
  return Number(n).toLocaleString('en-US');
}

function bucketLabel(iso: string, unit: 'day' | 'week' | 'month'): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  if (unit === 'month') {
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

export interface RakeSnapshotPanelProps {
  clubId: string | null;
  /** Scopes the viewer holds, in the order they should be offered. */
  scopes: RakeScope[];
  /** Only meaningful for the agent scope; null means "me". */
  agentUserId?: string | null;
  /** Bumping this re-reads without changing the period. */
  refreshToken?: number;
}

export default function RakeSnapshotPanel({
  clubId,
  scopes,
  agentUserId = null,
  refreshToken = 0,
}: RakeSnapshotPanelProps) {
  // Memoised: a fresh array identity on every render would re-run the effect
  // below on every render, and that effect can call setScope.
  const available = useMemo<RakeScope[]>(() => (scopes.length ? scopes : ['club']), [scopes]);
  const [scope, setScope] = useState<RakeScope>(available[0]);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [custom, setCustom] = useState(() => periodToRange('month'));
  const [snapshot, setSnapshot] = useState<RakeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const version = useRef(0);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // If the viewer's roles resolve after first paint, the selected chip may no
  // longer be one they hold. Fall back rather than keep asking for a refusal.
  useEffect(() => {
    if (!available.includes(scope)) setScope(available[0]);
  }, [available, scope]);

  const range = useMemo(
    () => (period === 'custom' ? periodToRange('custom', custom) : periodToRange(period)),
    [period, custom]
  );

  const load = useCallback(async () => {
    if (!clubId) return;
    const mine = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const next = await ClubRakeSnapshotService.get({
        scope,
        clubId,
        start: range.start,
        end: range.end,
        agentUserId: scope === 'agent' ? agentUserId : null,
      });
      if (cancelled.current || mine !== version.current) return;
      setSnapshot(next);
    } catch (e) {
      if (cancelled.current || mine !== version.current) return;
      // The previous snapshot stays on screen. A refusal for one scope must not
      // wipe the figure the operator was already reading.
      setError(describeRakeSnapshotError(e));
      reportError(e, 'RakeSnapshotPanel.load');
    } finally {
      if (!cancelled.current && mine === version.current) setLoading(false);
    }
  }, [clubId, scope, range.start, range.end, agentUserId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Same 60s cadence as the ledger, and only while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const summary = snapshot?.summary ?? null;
  const delta = snapshot?.delta ?? null;
  const isAgent = snapshot?.scope === 'agent';

  const series = useMemo(() => snapshot?.series ?? [], [snapshot]);
  const peak = useMemo(
    () => series.reduce((m, p) => Math.max(m, Math.abs(Number(p.fee) || 0)), 0),
    [series]
  );

  const deltaNote = (pct: number | null | undefined, abs: number | null | undefined) => {
    const hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
    const hasAbs = abs !== null && abs !== undefined && Number.isFinite(Number(abs));
    if (!hasPct && !hasAbs) return null;
    const basis = hasPct ? Number(pct) : Number(abs);
    const cls = basis > 0 ? styles.up : basis < 0 ? styles.down : styles.flat;
    const text = hasPct
      ? `${Number(pct) > 0 ? '+' : ''}${Math.round(Number(pct) * 10) / 10}%`
      : `${Number(abs) > 0 ? '+' : ''}${money(abs)}`;
    return (
      <span
        className={`${styles.delta} ${cls}`}
        title={
          snapshot
            ? `Previous Period ${snapshot.previous_range.start} To ${snapshot.previous_range.end} UTC`
            : undefined
        }
      >
        {text} Vs Prev
      </span>
    );
  };

  const exportSnapshot = useCallback(() => {
    if (!snapshot) return;
    const head = [
      'scope',
      'label',
      'start',
      'end',
      'days',
      'fee',
      'cash_fee',
      'mtt_fee',
      'games',
      'hands',
      'total_winnings',
      'mtt_winnings',
    ];
    const top = [
      snapshot.scope,
      snapshot.scope_label,
      snapshot.range.start,
      snapshot.range.end,
      snapshot.range.days,
      snapshot.summary.fee,
      snapshot.summary.cash_fee,
      snapshot.summary.mtt_fee,
      snapshot.summary.games,
      snapshot.summary.hands,
      snapshot.summary.total_winnings,
      snapshot.summary.mtt_winnings,
    ];
    const lines = [head.join(','), top.map(csvEscape).join(',')];
    if (snapshot.breakdown.length) {
      lines.push('');
      lines.push(
        [
          'club_id',
          'name',
          'code',
          'games',
          'hands',
          'fee',
          'cash_fee',
          'mtt_fee',
          'winnings',
        ].join(',')
      );
      for (const r of snapshot.breakdown) {
        lines.push(
          [r.club_id, r.name, r.code, r.games, r.hands, r.fee, r.cash_fee, r.mtt_fee, r.winnings]
            .map(csvEscape)
            .join(',')
        );
      }
    }
    downloadCsv(
      `rake-snapshot-${snapshot.scope}-${snapshot.range.start}-to-${snapshot.range.end}.csv`,
      lines.join('\n')
    );
  }, [snapshot]);

  return (
    <section className={styles.panel} aria-labelledby="rake-snapshot-title">
      <header className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.eyebrow}>
            <span className={styles.light} aria-hidden="true" />
            Operator Snapshot
          </span>
          <h2 id="rake-snapshot-title">Rake Produced</h2>
          <p className={styles.subject}>
            {snapshot
              ? `${snapshot.scope_label}${
                  snapshot.scope === 'union' && snapshot.club_count
                    ? ` - ${count(snapshot.club_count)} Club${snapshot.club_count === 1 ? '' : 's'}`
                    : ''
                }`
              : SCOPE_COPY[scope].note}
          </p>
        </div>

        <div className={styles.headActions}>
          {available.length > 1 && (
            <div className={styles.scopes} role="group" aria-label="Reporting Scope">
              {available.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  className={`${styles.scope} ${scope === s ? styles.active : ''}`}
                  onClick={() => setScope(s)}
                  title={SCOPE_COPY[s].note}
                >
                  {SCOPE_COPY[s].label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.exportBtn}
            onClick={exportSnapshot}
            disabled={!snapshot}
            title="Export This Snapshot As CSV"
          >
            Export
          </button>
        </div>
      </header>

      <div className={styles.periodRow}>
        <div className={styles.periods} role="group" aria-label="Reporting Period">
          {RAKE_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              className={`${styles.period} ${period === p.key ? styles.active : ''}`}
              onClick={() => {
                if (p.key === 'custom' && period !== 'custom') setCustom(range);
                setPeriod(p.key);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === 'custom' ? (
          <div className={styles.customRange}>
            <label>
              <span className={styles.srOnly}>Range Start</span>
              <input
                type="date"
                value={custom.start}
                max={custom.end}
                onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
              />
            </label>
            <span className={styles.rangeDivider} aria-hidden="true">
              -
            </span>
            <label>
              <span className={styles.srOnly}>Range End</span>
              <input
                type="date"
                value={custom.end}
                min={custom.start}
                onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
              />
            </label>
            <span className={styles.rangeTz}>UTC</span>
          </div>
        ) : (
          <div className={styles.rangeChip} aria-live="polite">
            <span>{snapshot?.range.start ?? range.start}</span>
            <span className={styles.rangeDivider}>-</span>
            <span>{snapshot?.range.end ?? range.end}</span>
            <span className={styles.rangeTz}>UTC</span>
          </div>
        )}
      </div>

      {error && (
        <p className={styles.error} role="status">
          {error}
        </p>
      )}

      <dl className={styles.tiles} aria-busy={loading} aria-label="Rake Snapshot Totals">
        <div className={`${styles.tile} ${styles.headline}`}>
          <dt>Rake / Fee</dt>
          <dd className={styles.value}>{summary ? money(summary.fee) : NO_VALUE}</dd>
          <dd className={styles.meta}>
            {summary && !isAgent && summary.cash_fee !== null && summary.mtt_fee !== null ? (
              <span className={styles.split}>
                {money(summary.cash_fee)} Cash - {money(summary.mtt_fee)} MTT
              </span>
            ) : null}
            {deltaNote(delta?.fee_pct, delta?.fee_abs)}
          </dd>
        </div>

        {isAgent ? (
          <>
            <div className={styles.tile}>
              <dt>Est. Commission</dt>
              <dd className={styles.value}>
                {summary ? money(summary.estimated_commission) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>
                {summary?.commission_rate !== null && summary?.commission_rate !== undefined
                  ? `${(Number(summary.commission_rate) * 100).toFixed(1)}% Rate`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Active Players</dt>
              <dd className={styles.value}>{summary ? count(summary.active) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {summary ? `${count(summary.members)} In Downline` : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Hands</dt>
              <dd className={styles.value}>{summary ? count(summary.hands) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {snapshot?.top_earner?.username ? `Top ${snapshot.top_earner.username}` : null}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className={styles.tile}>
              <dt>Total Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.total_winnings) < 0 ? styles.neg : styles.pos
                }`}
              >
                {summary ? money(summary.total_winnings) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>{deltaNote(null, delta?.winnings_abs)}</dd>
            </div>
            <div className={styles.tile}>
              <dt>MTT Winnings</dt>
              <dd
                className={`${styles.value} ${
                  summary && Number(summary.mtt_winnings) < 0 ? styles.neg : styles.pos
                }`}
              >
                {summary ? money(summary.mtt_winnings) : NO_VALUE}
              </dd>
              <dd className={styles.meta}>
                {summary && summary.mtt_games !== null && summary.mtt_games !== undefined
                  ? `${count(summary.mtt_games)} Tournaments`
                  : null}
              </dd>
            </div>
            <div className={styles.tile}>
              <dt>Games</dt>
              <dd className={styles.value}>{summary ? count(summary.games) : NO_VALUE}</dd>
              <dd className={styles.meta}>
                {summary ? `${count(summary.hands)} Hands` : null}
                {deltaNote(delta?.games_pct, null)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {series.length > 1 && (
        <figure className={styles.trend}>
          <figcaption>
            Rake By{' '}
            {snapshot?.series_bucket === 'month'
              ? 'Month'
              : snapshot?.series_bucket === 'week'
                ? 'Week'
                : 'Day'}
          </figcaption>
          <div
            className={styles.bars}
            role="img"
            aria-label="Rake Trend Across The Selected Period"
          >
            {series.map((p) => {
              const v = Math.abs(Number(p.fee) || 0);
              const h = peak > 0 ? Math.max(2, Math.round((v / peak) * 100)) : 2;
              return (
                <span
                  key={p.bucket}
                  className={styles.bar}
                  style={{ height: `${h}%` }}
                  title={`${bucketLabel(p.bucket, snapshot?.series_bucket ?? 'day')} - ${money(p.fee)}`}
                />
              );
            })}
          </div>
          <div className={styles.trendAxis} aria-hidden="true">
            <span>{bucketLabel(series[0].bucket, snapshot?.series_bucket ?? 'day')}</span>
            <span>Peak {money(peak)}</span>
            <span>
              {bucketLabel(series[series.length - 1].bucket, snapshot?.series_bucket ?? 'day')}
            </span>
          </div>
        </figure>
      )}

      {snapshot?.breakdown_kind === 'club' && snapshot.breakdown.length > 0 && (
        <div className={styles.breakdown}>
          <h3>Rake By Club</h3>
          <ul>
            {snapshot.breakdown.map((r) => {
              const share =
                summary && Number(summary.fee) > 0 ? (r.fee / Number(summary.fee)) * 100 : 0;
              return (
                <li key={r.club_id}>
                  <span className={styles.rowName} title={r.name}>
                    {r.name}
                    {r.code ? <em>#{r.code}</em> : null}
                  </span>
                  <span className={styles.rowBar} aria-hidden="true">
                    <span style={{ width: `${Math.max(1, Math.min(100, share))}%` }} />
                  </span>
                  <span className={styles.rowFee}>{money(r.fee)}</span>
                  <span className={styles.rowShare}>{share.toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className={styles.foot}>
        {loading && !snapshot
          ? 'Reading Rollups'
          : snapshot
            ? `Compared Against ${snapshot.previous_range.start} - ${snapshot.previous_range.end} UTC`
            : 'No Snapshot Loaded'}
      </p>
    </section>
  );
}
