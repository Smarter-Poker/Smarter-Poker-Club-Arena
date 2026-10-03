/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RATE AUDIT PAGE — Commission & Rake Rate Change History
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Admin page showing all rate changes across commission and rake audit tables.
 *  Filterable by type, agent, and date range.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibleRead } from '../hooks/useVisibleRead';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { titleCase } from '../utils/titleCase';
import styles from './RateAuditPage.module.css';

interface RateChange {
  id: string;
  source: 'commission' | 'rake';
  entityId: string; // agent_id or club_id
  entityLabel: string;
  changedBy: string;
  oldRate: number;
  newRate: number;
  rateType: string;
  createdAt: string;
  notes?: string;
}

type FilterType = 'all' | 'commission' | 'rake';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseRateAuditRows(value: unknown, source: RateChange['source']): RateChange[] {
  if (!Array.isArray(value)) throw new Error(`${titleCase(source)} Rate Rows Were Not Returned`);
  return value.map((row) => {
    if (!isRecord(row)) throw new Error(`${titleCase(source)} Rate Row Was Invalid`);
    const entityId = source === 'commission' ? row.agent_id : row.club_id;
    const oldRate = Number(row.old_rate);
    const newRate = Number(row.new_rate);
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      typeof entityId !== 'string' ||
      !entityId ||
      typeof row.rate_type !== 'string' ||
      !row.rate_type ||
      typeof row.created_at !== 'string' ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      !Number.isFinite(oldRate) ||
      !Number.isFinite(newRate) ||
      oldRate < 0 ||
      newRate < 0 ||
      oldRate > 1 ||
      newRate > 1 ||
      (row.changed_by != null && typeof row.changed_by !== 'string') ||
      (row.notes != null && typeof row.notes !== 'string')
    ) {
      throw new Error(`${titleCase(source)} Rate Row Was Invalid`);
    }
    const entityWord = source === 'commission' ? 'Agent' : 'Club';
    return {
      id: row.id,
      source,
      entityId,
      entityLabel: `${entityWord} ${entityId.slice(0, 8)}`,
      changedBy: typeof row.changed_by === 'string' ? row.changed_by.slice(0, 8) : 'Unknown',
      oldRate,
      newRate,
      rateType: row.rate_type,
      createdAt: row.created_at,
      notes: typeof row.notes === 'string' ? row.notes : undefined,
    };
  });
}

export default function RateAuditPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [storedChanges, setChanges] = useState<RateChange[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  /* A FAILED READ IS NOT "NO RATE HAS EVER CHANGED" (2026-09-10). Both audit
     reads destructured only `data`, so a refused or failed query rendered an
     empty audit table indistinguishable from a clean history. */
  const [storedError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [dateRange, setDateRange] = useState<'all' | '7d' | '30d' | '90d'>('all');
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  /* WHOSE RATES (2026-09-10). This route had no role gate and no club filter,
     so it listed every club's rake-rate changes RLS let the viewer read,
     labelled "Club <uuid>". The scope names the club and the finance role. */
  const scope = useFinancialAdminScope();
  const scopeStatus = scope.status;
  const scopeClubId = scope.clubId;
  const scopePlatformWide = scope.platformWide;

  const readScope = `${user?.id || ''}:${scopeStatus}:${scopeClubId || ''}:${scopePlatformWide}:${dateRange}`;
  const ownsData = loadedScope === readScope;
  const changes = ownsData ? storedChanges : [];
  const loading = !ownsData || isLoading;
  const loadError = ownsData ? storedError : null;

  // These audit tables stay outside replication. Only an authorized, visible
  // page reads its bounded history; late replies cannot cross account or club.
  const loadAuditData = useVisibleRead({
    scopeKey: readScope,
    enabled: Boolean(user?.id) && scopeStatus === 'ready' && scope.userId === user?.id,
    intervalMs: 30_000,
    read: async (signal) => {
      const scopeKey = {
        status: scopeStatus,
        clubId: scopeClubId,
        platformWide: scopePlatformWide,
      };
      const allChanges: RateChange[] = [];
      const windowEnd = new Date();
      const cutoffMs =
        dateRange === '7d'
          ? windowEnd.getTime() - 7 * 86400000
          : dateRange === '30d'
            ? windowEnd.getTime() - 30 * 86400000
            : dateRange === '90d'
              ? windowEnd.getTime() - 90 * 86400000
              : null;
      const cutoff = cutoffMs === null ? null : new Date(cutoffMs).toISOString();
      let commissionQuery = clubScoped(
        supabase
          .from('commission_rate_audit')
          .select('id, agent_id, changed_by, old_rate, new_rate, rate_type, created_at'),
        /* error bound by commResult below */
        scopeKey
      );
      let rakeQuery = clubScoped(
        supabase
          .from('rake_rate_audit')
          .select('id, club_id, changed_by, old_rate, new_rate, rate_type, created_at, notes'),
        /* error bound by rakeResult below */
        scopeKey
      );
      if (cutoff) {
        commissionQuery = commissionQuery
          .gte('created_at', cutoff)
          .lte('created_at', windowEnd.toISOString());
        rakeQuery = rakeQuery.gte('created_at', cutoff).lte('created_at', windowEnd.toISOString());
      }

      // Both reads run for the club in scope; either failing is a failure of
      // the page, not an empty history.
      const [commResult, rakeResult] = await Promise.all([
        commissionQuery.order('created_at', { ascending: false }).limit(100).abortSignal(signal),
        rakeQuery.order('created_at', { ascending: false }).limit(100).abortSignal(signal),
      ]);
      if (commResult.error) throw commResult.error;
      if (rakeResult.error) throw rakeResult.error;
      allChanges.push(...parseRateAuditRows(commResult.data, 'commission'));
      allChanges.push(...parseRateAuditRows(rakeResult.data, 'rake'));

      // Sort all by date descending
      allChanges.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return allChanges;
    },
    onData: (allChanges) => {
      setChanges(allChanges);
      setLoadError(null);
      setLoading(false);
      setLoadedScope(readScope);
    },
    onError: (err) => {
      reportError(err, 'RateAuditPage.Load_failed');
      setChanges([]);
      setLoadError(
        safeErrorMessage(err, 'The Rate Audit Could Not Be Loaded. Nothing Has Been Changed.')
      );
      setLoading(false);
      setLoadedScope(readScope);
      toast.error('Failed to load rate audit data');
    },
    onReset: () => {
      setChanges([]);
      setLoadError(null);
      setLoading(true);
      setLoadedScope(null);
    },
  });

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    setVisibleRows(new Set());
    changes.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleRows((prev) => new Set(prev).add(i)), i * 40));
    });
    return () => timers.forEach(clearTimeout);
    // Row staging restarts only when the visible result count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes.length]);

  const filteredByType = filter === 'all' ? changes : changes.filter((c) => c.source === filter);
  const filtered = filteredByType;

  const formatRate = (rate: number, source: string): string => {
    if (source === 'rake') return `${(rate * 10000).toFixed(1)}‱`; // basis points for rake
    return `${(rate * 100).toFixed(1)}%`;
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getRateDirection = (
    oldR: number,
    newR: number
  ): { label: string; ink: 'red' | 'green' | 'muted' } => {
    if (newR > oldR) return { label: 'Increased To', ink: 'red' };
    if (newR < oldR) return { label: 'Decreased To', ink: 'green' };
    return { label: 'Unchanged At', ink: 'muted' };
  };

  if (scope.status !== 'ready' || scope.userId !== user?.id) {
    return (
      <main className={styles.page}>
        <SpadeConsole
          family="shark"
          crest="flat"
          eyebrow="Club Arena Data"
          title="Rate Audit Trail"
          titleAs="h1"
          titleId="rate-audit-title"
          pill={scope.status === 'loading' ? 'Checking' : 'Closed'}
          pillInk={scope.status === 'loading' ? 'gold' : 'red'}
          plates={{
            primary: {
              label: scope.status === 'loading' ? 'Checking' : 'Retry Access',
              onClick: scope.reload,
              disabled: scope.status === 'loading',
            },
          }}
          aria-labelledby="rate-audit-title"
        >
          <strong className="sc-label sc-ink--blue">Verify Club Access</strong>
          <p className="sc-copy sc-copy--center" role="status">
            {scope.message || 'Verifying Your Financial Access'}
          </p>
        </SpadeConsole>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <SpadeConsole
        family="shark"
        crest="flat"
        eyebrow="Club Arena Data"
        title="Rate Audit Trail"
        titleAs="h1"
        titleId="rate-audit-title"
        subtitle="Commission And Rake Rate Change History"
        pill={loading ? 'Reading' : loadError ? 'Error' : `${changes.length} Changes`}
        pillInk={loadError ? 'red' : loading ? 'gold' : 'blue'}
        plates={{ primary: { label: 'Back', onClick: () => navigate(-1) } }}
        aria-labelledby="rate-audit-title"
      >
        <section className={styles.filters} aria-label="Audit Filters">
          <span className="sc-label sc-ink--blue">Rate Type</span>
          <div className={styles.filterWords} role="group" aria-label="Rate Type">
            {(['all', 'commission', 'rake'] as FilterType[]).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.filterWord}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'All' : titleCase(value)}
              </button>
            ))}
          </div>
          <span className="sc-label sc-ink--blue">Reading Window</span>
          <div className={styles.filterWords} role="group" aria-label="Reading Window">
            {(
              [
                ['all', 'All Dates'],
                ['7d', 'Seven Days'],
                ['30d', 'Thirty Days'],
                ['90d', 'Ninety Days'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={styles.filterWord}
                aria-pressed={dateRange === value}
                onClick={() => setDateRange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {loading ? (
          <p className="sc-copy sc-copy--center" role="status">
            Reading Rate History For This Authorized Scope
          </p>
        ) : loadError ? (
          <div className={styles.statusBlock} role="alert">
            <p className="sc-copy sc-copy--center">{loadError}</p>
            <button type="button" className={styles.litAction} onClick={loadAuditData}>
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.statusBlock} role="status">
            <p className="sc-copy sc-copy--center">No Rate Changes Recorded Yet</p>
            <p className="sc-copy sc-copy--center sc-ink--muted">
              Rate Changes Will Appear Here When Commission Or Rake Rates Are Modified
            </p>
          </div>
        ) : (
          <section className={styles.rows} aria-label="Rate Changes">
            {filtered.map((change, idx) => {
              const direction = getRateDirection(change.oldRate, change.newRate);
              return (
                <article key={change.id} className={styles.row} data-visible={visibleRows.has(idx)}>
                  <div className={styles.rowHeading}>
                    <span className="sc-label sc-ink--blue">{titleCase(change.source)}</span>
                    <time dateTime={change.createdAt}>{formatDate(change.createdAt)}</time>
                  </div>
                  <strong className={styles.rateType}>
                    {titleCase(change.rateType.replace(/_/g, ' '))}
                  </strong>
                  <span className={styles.identityLine}>
                    {titleCase(change.entityLabel)} By {titleCase(change.changedBy)}
                  </span>
                  <div className={styles.rateLine}>
                    <span className="sc-ink--muted">
                      {formatRate(change.oldRate, change.source)}
                    </span>
                    <span className={`sc-ink--${direction.ink}`}>{direction.label}</span>
                    <strong className={`sc-ink--${direction.ink}`}>
                      {formatRate(change.newRate, change.source)}
                    </strong>
                  </div>
                  {change.notes && <p className={styles.notes}>{titleCase(change.notes)}</p>}
                </article>
              );
            })}
          </section>
        )}
      </SpadeConsole>
    </main>
  );
}
