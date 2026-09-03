/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT HISTORY PAGE — Historical Settlement Timeline & Trends
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Shows past settlement cycles with trend comparison.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

interface SettlementCycle {
  id: string;
  periodId: string;
  totalRake: number;
  unionTax: number;
  netSettlement: number;
  status: string;
  createdAt: string;
  agentPayouts: number;
}

export default function SettlementHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [cycles, setCycles] = useState<SettlementCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useVisibilityRefresh(() => loadHistory());

  useEffect(() => {
    loadHistory();
  }, []);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    const unsub = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', () => loadHistory(), 1000);
    const unsub2 = masterBus.subscribeDebounced(
      'SETTLEMENT_CYCLE_COMPLETED',
      () => loadHistory(),
      1000
    );

    // WebSocket: live settlement updates
    const channelKey = 'settlement-history-updates';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          // SWEEP #3 (2026-07-23): club_settlements never existed — the real
          // club settlement record is settlement_invoices (union<->club wires).
          // 2026-08-19: scope to the invoice type this screen renders, so the
          // new weekly player-P&L rows do not trigger a full reload of a list
          // they are not part of.
          event: '*',
          schema: 'public',
          table: 'settlement_invoices',
          filter: 'invoice_type=eq.union_to_club',
        },
        () => loadHistory()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'SettlementHistoryPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[SettlementHistoryPage] Realtime channel timed out');
        }
      });

    return () => {
      unsub();
      unsub2();
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, []);

  const loadingRef = useRef(false);

  const loadHistory = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      // SWEEP #3 (2026-07-23): repointed off the phantom club_settlements table
      // onto settlement_invoices. gross_amount = rake collected in the period;
      // net_amount = the union's hold (union tax); breakdown.club_retained =
      // what the club kept.
      // FIX 2026-08-19: this query had NO invoice_type filter, and the mapper
      // assumes every row is a union rake-hold invoice (reading
      // breakdown.union_hold_amount / breakdown.club_retained). A
      // 'union_club_pnl' row — the new weekly player win/loss settlement — has
      // neither key and gross_amount == net_amount, so it rendered as
      // "Rake: X / Fee: -X / Net: 0", i.e. "the union took 100% of your rake",
      // and it corrupted every summary tile and the chart scale. Scope to the
      // rake-hold invoices this screen is actually about.
      const { data } = await supabase
        .from('settlement_invoices')
        .select(
          'id, period_id, invoice_type, gross_amount, net_amount, breakdown, status, created_at'
        )
        .eq('invoice_type', 'union_to_club')
        .order('created_at', { ascending: false })
        .limit(50);

      if (data) {
        if (!isMounted.current) return;
        const mapped: SettlementCycle[] = data.map((s: any) => ({
          id: s.id,
          periodId: s.period_id || 'N/A',
          totalRake: s.gross_amount || 0,
          unionTax: s.breakdown?.union_hold_amount ?? s.net_amount ?? 0,
          netSettlement:
            s.breakdown?.club_retained ?? Math.max((s.gross_amount || 0) - (s.net_amount || 0), 0),
          status: s.status === 'paid' ? 'completed' : s.status || 'completed',
          createdAt: s.created_at,
          agentPayouts: 0,
        }));
        setCycles(mapped);
        // Clear previous stagger timers before starting new ones
        staggerTimersRef.current.forEach(clearTimeout);
        staggerTimersRef.current = mapped.map((_, i) =>
          setTimeout(() => {
            if (isMounted.current) setVisibleRows((prev) => new Set(prev).add(i));
          }, i * 50)
        );
      }
    } catch (err) {
      if (!isMounted.current) return;
      reportError(err, 'SettlementHistoryPage.Load_failed');
      toast.error('Failed to load settlement history');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  const totalRakeAllTime = cycles.reduce((s, c) => s + c.totalRake, 0);
  const totalSettled = cycles.reduce((s, c) => s + c.netSettlement, 0);
  const maxRake = Math.max(...cycles.map((c) => c.totalRake), 1);

  return (
    <div
      style={{
        padding: '16px',
        width: '100%',
        maxWidth: '800px',
        margin: '0 auto',
        paddingBottom: '100px',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#3b82f6',
            cursor: 'pointer',
            fontSize: '0.85rem',
            padding: '10px 0',
            minHeight: 44,
            touchAction: 'manipulation',
            marginBottom: '6px',
          }}
        >
          ← Back
        </button>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Settlement History</h1>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
          Weekly Settlement Cycles And Revenue Trends
        </p>
      </div>

      {/* Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px',
          marginBottom: '20px',
        }}
      >
        <div
          style={{
            padding: '14px',
            background: 'rgba(245,158,11,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(245,158,11,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Total Rake
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#f59e0b',
              fontFamily: 'monospace',
            }}
          >
            {totalRakeAllTime.toLocaleString()}
          </div>
        </div>
        <div
          style={{
            padding: '14px',
            background: 'rgba(16,185,129,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(16,185,129,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Net Settled
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#10b981',
              fontFamily: 'monospace',
            }}
          >
            {totalSettled.toLocaleString()}
          </div>
        </div>
        <div
          style={{
            padding: '14px',
            background: 'rgba(139,92,246,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(139,92,246,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Cycles
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#8b5cf6',
              fontFamily: 'monospace',
            }}
          >
            {cycles.length}
          </div>
        </div>
      </div>

      {/* Visual Timeline (bar chart) */}
      {cycles.length > 0 && (
        <div
          style={{
            padding: '16px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.06)',
            marginBottom: '20px',
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '12px' }}>
            Revenue Timeline
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '80px' }}>
            {cycles
              .slice(0, 20)
              .reverse()
              .map((c, i) => (
                <div
                  key={c.id}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      height: `${Math.max(4, (c.totalRake / maxRake) * 60)}px`,
                      background:
                        c.status === 'completed'
                          ? 'linear-gradient(180deg, #10b981, #065f46)'
                          : 'linear-gradient(180deg, #f59e0b, #92400e)',
                      borderRadius: '2px 2px 0 0',
                      transition: 'height 0.5s ease',
                    }}
                    title={`Rake: ${c.totalRake.toLocaleString()}`}
                  />
                </div>
              ))}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.55rem',
              color: 'rgba(255,255,255,0.3)',
              marginTop: '4px',
            }}
          >
            <span>Oldest</span>
            <span>Most Recent</span>
          </div>
        </div>
      )}

      {/* Settlement List */}
      <div
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '8px',
        }}
      >
        Settlement Cycles
      </div>
      {loading && cycles.length === 0 ? (
        <PageSkeleton variant="default" />
      ) : cycles.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.3)' }}>
          No Settlement Cycles Yet
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {cycles.map((cycle, idx) => (
            <div
              key={cycle.id}
              style={{
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.06)',
                opacity: visibleRows.has(idx) ? 1 : 0,
                transform: visibleRows.has(idx) ? 'translateX(0)' : 'translateX(-8px)',
                transition: 'all 0.3s ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '6px',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>
                    Period: {cycle.periodId}
                  </span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      color: 'rgba(255,255,255,0.4)',
                      marginLeft: '8px',
                    }}
                  >
                    {new Date(cycle.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    background:
                      cycle.status === 'completed'
                        ? 'rgba(16,185,129,0.12)'
                        : 'rgba(245,158,11,0.12)',
                    color: cycle.status === 'completed' ? '#10b981' : '#f59e0b',
                  }}
                >
                  {cycle.status.toUpperCase()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '16px', fontSize: '0.75rem' }}>
                <span>
                  Rake:{' '}
                  <span style={{ color: '#f59e0b', fontWeight: 700 }}>
                    {cycle.totalRake.toLocaleString()}
                  </span>
                </span>
                {cycle.unionTax > 0 && (
                  <span>
                    Fee:{' '}
                    <span style={{ color: '#ef4444' }}>-{cycle.unionTax.toLocaleString()}</span>
                  </span>
                )}
                <span>
                  Net:{' '}
                  <span style={{ color: '#10b981', fontWeight: 700 }}>
                    {cycle.netSettlement.toLocaleString()}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
