/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ TICKER — live jackpot + recent hits strip (2026-08-18)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A jackpot nobody sees grow is a jackpot nobody chases. This strip belongs in
 * the club lobby: the live pool on the left, the most recent real hits
 * scrolling on the right, so a player arriving at the lobby immediately sees
 * (a) how big it is and (b) that it genuinely pays.
 *
 * Sources the AUTHORITATIVE ledger (bbj_winners — the table §41 reconciled the
 * counters against), never the pool counters. Subscribes to INSERTs so a hit
 * that lands while the lobby is open appears without a refresh.
 *
 * Pool resolution mirrors the server: union pool first, then club.
 */

import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import './BBJTicker.css';

export interface BBJTickerProps {
  clubId: string | null;
  unionId?: string | null;
  /** Live pool value if the parent already tracks it — avoids a duplicate subscription. */
  poolAmount?: number;
  maxHits?: number;
  onClick?: () => void;
}

interface HitRow {
  id: string;
  loser_display_name: string | null;
  winner_display_name: string | null;
  loser_hand: string | null;
  total_payout: number;
  awarded_at: string;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function money(n: number): string {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function BBJTicker({
  clubId,
  unionId = null,
  poolAmount,
  maxHits = 8,
  onClick,
}: BBJTickerProps) {
  const [pool, setPool] = useState<number>(poolAmount ?? 0);
  const [hits, setHits] = useState<HitRow[]>([]);
  const poolIdRef = useRef<string | null>(null);

  // Parent-provided pool wins (single source of truth when supplied).
  useEffect(() => {
    if (typeof poolAmount === 'number') setPool(poolAmount);
  }, [poolAmount]);

  useEffect(() => {
    if (!clubId && !unionId) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const load = async () => {
      // Resolve the pool the same way the server does: union first, then club.
      let q = supabase.from('bbj_pools').select('id, main_balance').eq('status', 'active');
      q = unionId ? q.eq('union_id', unionId) : q.eq('club_id', clubId as string);
      const { data: poolRow } = await q.maybeSingle();
      if (cancelled || !poolRow) return;
      poolIdRef.current = poolRow.id;
      if (typeof poolAmount !== 'number') setPool(Number(poolRow.main_balance) || 0);

      const { data: winners } = await supabase
        .from('bbj_winners')
        .select('id, loser_display_name, winner_display_name, loser_hand, total_payout, awarded_at')
        .eq('pool_id', poolRow.id)
        .order('awarded_at', { ascending: false })
        .limit(maxHits);
      if (cancelled) return;
      setHits((winners as HitRow[]) || []);

      channel = supabase
        .channel(`bbj-ticker-${poolRow.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'bbj_winners',
            filter: `pool_id=eq.${poolRow.id}`,
          },
          (payload) => {
            const row = payload.new as HitRow;
            if (!row?.id || cancelled) return;
            setHits((prev) => [row, ...prev.filter((h) => h.id !== row.id)].slice(0, maxHits));
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'bbj_pools',
            filter: `id=eq.${poolRow.id}`,
          },
          (payload) => {
            if (typeof poolAmount === 'number' || cancelled) return;
            const next = Number((payload.new as { main_balance?: number })?.main_balance);
            if (Number.isFinite(next)) setPool(next);
          }
        )
        .subscribe();
    };

    load();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
    // poolAmount intentionally excluded — it only decides who owns the value,
    // and re-subscribing on every tick would thrash the channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, unionId, maxHits]);

  if (!clubId && !unionId) return null;

  return (
    <div
      className={`bbj-ticker${onClick ? ' bbj-ticker--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
    >
      <div className="bbj-ticker__pool">
        <span className="bbj-ticker__label">BAD BEAT JACKPOT</span>
        <span className="bbj-ticker__amount">${money(pool)}</span>
      </div>

      <div className="bbj-ticker__feed">
        {hits.length === 0 ? (
          <span className="bbj-ticker__empty">No hits yet &mdash; it could be you.</span>
        ) : (
          <div className="bbj-ticker__track">
            {hits.map((h) => (
              <span className="bbj-ticker__hit" key={h.id}>
                <span className="bbj-ticker__hit-amount">${money(h.total_payout)}</span>
                <span className="bbj-ticker__hit-who">
                  {h.loser_display_name || 'Player'}
                  {h.loser_hand ? ` — ${h.loser_hand}` : ''}
                </span>
                <span className="bbj-ticker__hit-when">{timeAgo(h.awarded_at)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default BBJTicker;
