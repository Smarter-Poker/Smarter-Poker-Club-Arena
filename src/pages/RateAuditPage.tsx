/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RATE AUDIT PAGE — Commission & Rake Rate Change History
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Admin page showing all rate changes across commission and rake audit tables.
 *  Filterable by type, agent, and date range.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';

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

export default function RateAuditPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [changes, setChanges] = useState<RateChange[]>([]);
  const [loading, setLoading] = useState(true);
  /* A FAILED READ IS NOT "NO RATE HAS EVER CHANGED" (2026-09-10). Both audit
     reads destructured only `data`, so a refused or failed query rendered an
     empty audit table indistinguishable from a clean history. */
  const [loadError, setLoadError] = useState<string | null>(null);
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

  const loadAuditData = useCallback(async () => {
    if (scopeStatus !== 'ready') return;
    const scopeKey = { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide };
    setLoading(true);
    setLoadError(null);
    try {
      const allChanges: RateChange[] = [];

      // Both reads run for the club in scope; either failing is a failure of
      // the page, not an empty history.
      const [commResult, rakeResult] = await Promise.all([
        clubScoped(
          supabase
            .from('commission_rate_audit')
            .select('id, agent_id, changed_by, old_rate, new_rate, rate_type, created_at'),
          scopeKey
        )
          .order('created_at', { ascending: false })
          .limit(100),
        clubScoped(
          supabase
            .from('rake_rate_audit')
            .select('id, club_id, changed_by, old_rate, new_rate, rate_type, created_at, notes'),
          scopeKey
        )
          .order('created_at', { ascending: false })
          .limit(100),
      ]);
      if (commResult.error) throw commResult.error;
      if (rakeResult.error) throw rakeResult.error;

      allChanges.push(
        ...(commResult.data || []).map((r: any) => ({
          id: r.id,
          source: 'commission' as const,
          entityId: r.agent_id,
          entityLabel: `Agent ${r.agent_id?.slice(0, 8)}...`,
          changedBy: r.changed_by?.slice(0, 8) + '...',
          oldRate: r.old_rate,
          newRate: r.new_rate,
          rateType: r.rate_type,
          createdAt: r.created_at,
        }))
      );
      allChanges.push(
        ...(rakeResult.data || []).map((r: any) => ({
          id: r.id,
          source: 'rake' as const,
          entityId: r.club_id,
          entityLabel: `Club ${r.club_id?.slice(0, 8)}...`,
          changedBy: r.changed_by?.slice(0, 8) + '...',
          oldRate: r.old_rate,
          newRate: r.new_rate,
          rateType: r.rate_type,
          createdAt: r.created_at,
          notes: r.notes,
        }))
      );

      // Sort all by date descending
      allChanges.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      if (isMounted.current) setChanges(allChanges);
    } catch (err) {
      reportError(err, 'RateAuditPage.Load_failed');
      if (isMounted.current) {
        setChanges([]);
        setLoadError(
          safeErrorMessage(err, 'The Rate Audit Could Not Be Loaded. Nothing Has Been Changed.')
        );
        toast.error('Failed to load rate audit data');
      }
    }
    if (isMounted.current) setLoading(false);
  }, [scopeStatus, scopeClubId, scopePlatformWide, toast]);

  useVisibilityRefresh(() => loadAuditData());

  useEffect(() => {
    loadAuditData();
  }, [loadAuditData]);

  // Bus listener: refresh when commission rates change
  useEffect(() => {
    const unsubCommission = masterBus.subscribeDebounced(
      'COMMISSION_PAID',
      () => loadAuditData(),
      1000
    );
    return () => {
      unsubCommission();
    };
  }, [loadAuditData]);

  // Real-time subscriptions on audit tables
  useEffect(() => {
    const channelKey = 'rate-audit-live';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'commission_rate_audit' },
        () => loadAuditData()
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rake_rate_audit' }, () =>
        loadAuditData()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'RateAuditPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[RateAuditPage] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadAuditData]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    setVisibleRows(new Set());
    changes.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleRows((prev) => new Set(prev).add(i)), i * 40));
    });
    return () => timers.forEach(clearTimeout);
  }, [changes.length]);

  const getDateCutoff = (): number => {
    if (dateRange === '7d') return Date.now() - 7 * 86400000;
    if (dateRange === '30d') return Date.now() - 30 * 86400000;
    if (dateRange === '90d') return Date.now() - 90 * 86400000;
    return 0; // 'all'
  };

  const filteredByType = filter === 'all' ? changes : changes.filter((c) => c.source === filter);
  const filtered =
    dateRange === 'all'
      ? filteredByType
      : filteredByType.filter((c) => new Date(c.createdAt).getTime() >= getDateCutoff());

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

  const getRateDirection = (oldR: number, newR: number): { icon: string; color: string } => {
    if (newR > oldR) return { icon: '▲', color: '#ef4444' };
    if (newR < oldR) return { icon: '▼', color: '#10b981' };
    return { icon: '─', color: '#6b7280' };
  };

  if (scope.status !== 'ready') {
    return (
      <div style={{ padding: '16px', width: '100%', maxWidth: '800px', margin: '0 auto' }}>
        <FinancialAdminScopeState scope={scope} />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '16px',
        width: '100%',
        maxWidth: '900px',
        margin: '0 auto',
        paddingBottom: '100px',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
        }}
      >
        <div>
          <button
            onClick={() => navigate(-1)}
            style={{
              background: 'none',
              border: 'none',
              color: '#3b82f6',
              cursor: 'pointer',
              fontSize: '0.85rem',
              padding: '10px 10px 10px 0',
              minHeight: '44px',
              touchAction: 'manipulation',
              marginBottom: '4px',
            }}
          >
            ← Back
          </button>
          <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>Rate Audit Trail</h1>
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
            Commission & Rake Rate Change History
          </p>
        </div>
        <span
          style={{
            padding: '4px 10px',
            background: 'rgba(59,130,246,0.1)',
            border: '1px solid rgba(59,130,246,0.3)',
            borderRadius: '8px',
            color: '#3b82f6',
            fontSize: '0.75rem',
            fontWeight: 600,
          }}
        >
          {changes.length} Changes
        </span>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        {(['all', 'commission', 'rake'] as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '6px 14px',
              minHeight: '44px',
              touchAction: 'manipulation',
              borderRadius: '8px',
              border: `1px solid ${filter === f ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)'}`,
              background: filter === f ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
              color: filter === f ? '#3b82f6' : 'rgba(255,255,255,0.6)',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {f === 'all' ? 'All' : f === 'commission' ? 'Commission' : '♠ Rake'}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <PageSkeleton variant="list" />
      ) : loadError ? (
        <div role="alert" style={{ textAlign: 'center', padding: '32px', color: '#f87171' }}>
          <div>{loadError}</div>
          <button
            type="button"
            onClick={() => loadAuditData()}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '8px',
              color: '#f87171',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '12px' }}>▤</div>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem' }}>
            No Rate Changes Recorded Yet
          </p>
          <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem' }}>
            Rate Changes Will Appear Here When Commission Or Rake Rates Are Modified
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {filtered.map((change, idx) => {
            const dir = getRateDirection(change.oldRate, change.newRate);
            return (
              <div
                key={change.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '12px',
                  padding: '12px 14px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.06)',
                  opacity: visibleRows.has(idx) ? 1 : 0,
                  transform: visibleRows.has(idx) ? 'translateY(0)' : 'translateY(6px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                {/* Source Badge */}
                <span
                  style={{
                    padding: '3px 8px',
                    borderRadius: '6px',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    background:
                      change.source === 'commission'
                        ? 'rgba(139,92,246,0.15)'
                        : 'rgba(16,185,129,0.15)',
                    color: change.source === 'commission' ? '#8b5cf6' : '#10b981',
                    border: `1px solid ${
                      change.source === 'commission'
                        ? 'rgba(139,92,246,0.3)'
                        : 'rgba(16,185,129,0.3)'
                    }`,
                    flexShrink: 0,
                  }}
                >
                  {change.source}
                </span>

                {/* Entity + Type */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                    {change.rateType.replace(/_/g, ' ')}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
                    {change.entityLabel} • By {change.changedBy}
                  </div>
                </div>

                {/* Rate Change */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'rgba(255,255,255,0.5)',
                      fontFamily: 'monospace',
                    }}
                  >
                    {formatRate(change.oldRate, change.source)}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: dir.color, fontWeight: 700 }}>
                    {dir.icon}
                  </span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: dir.color,
                      fontWeight: 700,
                      fontFamily: 'monospace',
                    }}
                  >
                    {formatRate(change.newRate, change.source)}
                  </span>
                </div>

                {/* Date */}
                <span
                  style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}
                >
                  {formatDate(change.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
