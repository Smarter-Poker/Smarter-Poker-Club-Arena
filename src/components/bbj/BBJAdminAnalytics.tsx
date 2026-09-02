/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ ADMIN ANALYTICS — jackpot health for club operators (2026-08-18)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Club admins ran the jackpot blind: no view of how fast it funds, how often
 * it pays, or whether it is net-positive. Every number here comes from
 * fn_bbj_analytics, which computes from the AUTHORITATIVE ledgers
 * (bbj_contributions + bbj_winners) — never the legacy pool counters that
 * had to be reconciled away after they showed an impossible $210k paid.
 *
 * The RPC is club-admin gated server-side; a non-admin gets an exception, so
 * this component simply renders nothing when the call is refused.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import './BBJAdminAnalytics.css';
import { money } from '../../utils/handFormat';

export interface BBJAdminAnalyticsProps {
  poolId: string | null;
}

interface Analytics {
  main_balance: number;
  backup_balance: number;
  promo_balance: number;
  contributions_24h: number;
  contributions_7d: number;
  contributions_30d: number;
  hands_24h: number;
  hands_7d: number;
  total_contributed_all_time: number;
  hit_count: number;
  total_paid_all_time: number;
  biggest_hit: number;
  last_hit_at: string | null;
  avg_days_between_hits: number | null;
  days_since_last_hit: number | null;
  net_pool_position: number;
}

export function BBJAdminAnalytics({ poolId }: BBJAdminAnalyticsProps) {
  const [data, setData] = useState<Analytics | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!poolId) return;
    let alive = true;
    (async () => {
      const { data: rows, error } = await supabase.rpc('fn_bbj_analytics', { p_pool_id: poolId });
      if (!alive) return;
      if (error) {
        // Not an admin (or the pool vanished) — render nothing, no noise.
        setDenied(true);
        return;
      }
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) setData(row as Analytics);
    })();
    return () => {
      alive = false;
    };
  }, [poolId]);

  if (!poolId || denied || !data) return null;

  // Funding rate vs. payout rate — the number an operator actually needs.
  const dailyFunding = Number(data.contributions_7d) / 7;
  const netPositive = Number(data.net_pool_position) >= 0;

  return (
    <div className="bbj-admin">
      <div className="bbj-admin__header">
        <h3 className="bbj-admin__title">Jackpot Health</h3>
        <span className="bbj-admin__subtitle">Admin Only &middot; From The Payout Ledger</span>
      </div>

      <div className="bbj-admin__grid">
        <div className="bbj-admin__stat">
          <span className="bbj-admin__stat-label">Funded (24H)</span>
          <span className="bbj-admin__stat-value">${money(data.contributions_24h)}</span>
          <span className="bbj-admin__stat-sub">
            {Number(data.hands_24h).toLocaleString()} Qualifying Hands
          </span>
        </div>

        <div className="bbj-admin__stat">
          <span className="bbj-admin__stat-label">Funded (7D)</span>
          <span className="bbj-admin__stat-value">${money(data.contributions_7d)}</span>
          <span className="bbj-admin__stat-sub">&asymp; ${money(dailyFunding)}/Day</span>
        </div>

        <div className="bbj-admin__stat">
          <span className="bbj-admin__stat-label">Hits (All Time)</span>
          <span className="bbj-admin__stat-value">{Number(data.hit_count).toLocaleString()}</span>
          <span className="bbj-admin__stat-sub">
            {data.avg_days_between_hits != null
              ? `Every ~${Number(data.avg_days_between_hits).toFixed(1)} Days`
              : 'Not Enough History'}
          </span>
        </div>

        <div className="bbj-admin__stat">
          <span className="bbj-admin__stat-label">Paid Out</span>
          <span className="bbj-admin__stat-value">${money(data.total_paid_all_time)}</span>
          <span className="bbj-admin__stat-sub">Biggest ${money(data.biggest_hit)}</span>
        </div>

        <div className="bbj-admin__stat">
          <span className="bbj-admin__stat-label">Last Hit</span>
          <span className="bbj-admin__stat-value">
            {data.days_since_last_hit != null
              ? `${Number(data.days_since_last_hit).toFixed(1)}d`
              : '-'}
          </span>
          <span className="bbj-admin__stat-sub">
            {data.last_hit_at ? new Date(data.last_hit_at).toLocaleDateString() : 'Never Hit'}
          </span>
        </div>

        <div className={`bbj-admin__stat ${netPositive ? 'is-positive' : 'is-negative'}`}>
          <span className="bbj-admin__stat-label">Net Position</span>
          <span className="bbj-admin__stat-value">
            {netPositive ? '+' : '-'}${money(Math.abs(Number(data.net_pool_position)))}
          </span>
          <span className="bbj-admin__stat-sub">Collected Minus Paid, All Time</span>
        </div>
      </div>

      <div className="bbj-admin__bar">
        <div className="bbj-admin__bar-label">
          Pool Split - Main ${money(data.main_balance, 0)} / Backup ${money(data.backup_balance, 0)}{' '}
          / Promo ${money(data.promo_balance, 0)}
        </div>
        <div className="bbj-admin__bar-track">
          {(() => {
            const total =
              Number(data.main_balance) + Number(data.backup_balance) + Number(data.promo_balance);
            const pct = (v: number) => (total > 0 ? (Number(v) / total) * 100 : 0);
            return (
              <>
                <div
                  className="bbj-admin__bar-seg bbj-admin__bar-main"
                  style={{ width: `${pct(data.main_balance)}%` }}
                />
                <div
                  className="bbj-admin__bar-seg bbj-admin__bar-backup"
                  style={{ width: `${pct(data.backup_balance)}%` }}
                />
                <div
                  className="bbj-admin__bar-seg bbj-admin__bar-promo"
                  style={{ width: `${pct(data.promo_balance)}%` }}
                />
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

export default BBJAdminAnalytics;
