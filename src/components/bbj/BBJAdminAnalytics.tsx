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

/**
 * WHY IT HAS NOT PAID — the reader for `bbj_near_misses` (2026-09-11).
 *
 * `days_since_last_hit` has been on this panel since 2026-08-18 posing a
 * question with nothing beside it to answer: a jackpot that has not paid in
 * twenty days is either strict rules working exactly as written, or something
 * refusing hands that should have paid, and those two look identical from
 * here. The engine has been writing down which gate refused each near miss
 * since 2026-09-07 — and for four days nothing in either repo selected those
 * rows. This is that reader (CLAUDE.md 10.86 rule 3).
 *
 * The labels are keyed on the reason strings the ENGINE emits, in
 * `server/src/config/RakeConfig.ts`. They are not keyed on the vocabulary in
 * the log's creating migration, which names five gates no writer has ever
 * emitted. `tests/the-near-miss-log-has-a-reader.law.test.ts` holds the two
 * lists against each other, so a gate added to the engine without a label here
 * fails CI rather than rendering as a bare snake_case string to an operator.
 */
const NEAR_MISS_LABELS: Record<string, string> = {
  not_enough_players: 'Not Enough Players Dealt In',
  pot_too_small: 'Pot Did Not Reach The Minimum',
  winner_not_quads: 'Winning Hand Was Not Quads Or Better',
  both_cards_must_play: 'Both Hole Cards Did Not Play',
  mini_not_enough_players: 'Mini: Not Enough Players Dealt In',
  mini_pot_too_small: 'Mini: Pot Did Not Reach The Minimum',
  mini_winner_not_quads: 'Mini: Winning Hand Was Not Quads Or Better',
  mini_loser_below_bar: 'Mini: Losing Hand Below The Qualifying Bar',
  mini_double_board: 'Mini: Double Board Hand',
  unspecified: 'Reason Not Recorded',
};

function nearMissLabel(reason: string | null | undefined): string {
  /* `bbj_near_misses.reason` IS NULLABLE and nothing enforces otherwise. The
     engine's writer defaults to 'unspecified', but any other path into the
     table can leave a null, and `null.startsWith(...)` throws during render -
     one malformed row would blank the whole Jackpot Health panel. The reader
     COALESCEs it in SQL; this is the second belt, because a UI that throws on
     data it did not expect is its own defect. */
  if (!reason) return NEAR_MISS_LABELS.unspecified;

  /* A mini the PAYOUT turned away carries the refusal after a colon. It is not
     a near miss and never reads as one: a player made the hand. */
  if (reason.startsWith('mini_refused:')) {
    const why = reason.slice('mini_refused:'.length);
    return `Mini Qualified But Was Turned Away (${NEAR_MISS_LABELS[why] ?? why})`;
  }
  return NEAR_MISS_LABELS[reason] ?? reason;
}

interface NearMiss {
  kind: string;
  reason: string;
  refusals: number;
  last_at: string | null;
  biggest_pot: number;
  example: string | null;
}

/* THREE OUTCOMES, NOT TWO (CLAUDE.md 10.86 rule 1). "No hand was refused" and
   "the refusal log could not be read" are opposite findings that would render
   identically as an empty list, and the emptier one is the one that reads like
   good news. They are named separately here and printed differently. */
type NearMissState = 'loading' | 'ok' | 'unavailable';

interface Analytics {
  main_balance: number;
  backup_balance: number;
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
  /* The mini's own numbers (2026-09-11). The columns above count every hit of
     either kind; these say how much of that was the mini, and what the reserve
     can still pay. Optional so a cached older row still renders. */
  mini_enabled?: boolean | null;
  mini_hit_count?: number | null;
  mini_paid_all_time?: number | null;
  mini_hits_30d?: number | null;
  mini_paid_30d?: number | null;
  mini_last_hit_at?: string | null;
  mini_reserve_floor?: number | null;
  mini_parked?: number | null;
  mini_available?: number | null;
}

export function BBJAdminAnalytics({ poolId }: BBJAdminAnalyticsProps) {
  const [data, setData] = useState<Analytics | null>(null);
  const [denied, setDenied] = useState(false);
  const [nearMisses, setNearMisses] = useState<NearMiss[]>([]);
  const [nearMissState, setNearMissState] = useState<NearMissState>('loading');

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

  /* Its OWN effect, so the refusal log and the balances cannot take each other
     down. The same authorisation decides both, so a non-admin never gets here
     — the panel has already returned null. */
  useEffect(() => {
    if (!poolId) return;
    let alive = true;
    setNearMissState('loading');
    (async () => {
      const { data: rows, error } = await supabase.rpc('fn_bbj_near_miss_summary', {
        p_pool_id: poolId,
        p_days: 30,
      });
      if (!alive) return;
      if (error) {
        setNearMissState('unavailable');
        return;
      }
      setNearMisses((Array.isArray(rows) ? rows : []) as NearMiss[]);
      setNearMissState('ok');
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

        {/* THE MINI (2026-09-11). Its hits are inside "Hits (All Time)" and
            its chips inside "Paid Out"; these three say how much of each was
            the mini, and how far the backup reserve is from the floor at
            which the mini stops paying. */}
        {data.mini_hit_count != null && (
          <>
            <div className="bbj-admin__stat">
              <span className="bbj-admin__stat-label">Mini Hits</span>
              <span className="bbj-admin__stat-value">
                {Number(data.mini_hit_count).toLocaleString()}
              </span>
              <span className="bbj-admin__stat-sub">
                {Number(data.mini_hits_30d ?? 0).toLocaleString()} In 30 Days
                {data.mini_enabled === false ? ' - Switched Off' : ''}
              </span>
            </div>

            <div className="bbj-admin__stat">
              <span className="bbj-admin__stat-label">Mini Paid</span>
              <span className="bbj-admin__stat-value">
                ${money(Number(data.mini_paid_all_time ?? 0))}
              </span>
              <span className="bbj-admin__stat-sub">
                ${money(Number(data.mini_paid_30d ?? 0))} In 30 Days, From The Backup Pool
              </span>
            </div>

            <div
              className={`bbj-admin__stat ${Number(data.mini_available ?? 0) > 0 ? 'is-positive' : 'is-negative'}`}
            >
              <span className="bbj-admin__stat-label">Mini Headroom</span>
              <span className="bbj-admin__stat-value">
                ${money(Number(data.mini_available ?? 0), 0)}
              </span>
              <span className="bbj-admin__stat-sub">
                Backup Above Its ${money(Number(data.mini_reserve_floor ?? 0), 0)} Floor
                {Number(data.mini_parked ?? 0) > 0
                  ? ` (${money(Number(data.mini_parked), 0)} Parked)`
                  : ''}
              </span>
            </div>
          </>
        )}
      </div>

      {/* THE BANKS THE JACKPOT HOLDS - TWO, NOT THREE (phase 5, 2026-09-11).
          This bar used to read "Pool Split - Main / Backup / Promo" and size a
          promo segment from `promo_balance`. That is a STAGING SLOT which
          `fn_sweep_bbj_promo` empties continuously: measured that day it held
          14.61 against a union promo wallet of 56,291.01, so the promo segment
          rendered at 0.007% of the bar and told every operator that promo gets
          essentially nothing. It gets 26.1% of every raked chip - 134,595 so
          far - and it is not here because it has already been swept to the
          purse. A flow drawn as a slice of two balances is a false statement
          about where a club's rake goes, so the bar now shows only the two
          banks the jackpot actually holds, and the promo slice is reported as
          a flow on the jackpot page (fn_bbj_promo_facts). */}
      <div className="bbj-admin__bar">
        <div className="bbj-admin__bar-label">
          Jackpot Banks - Main ${money(data.main_balance, 0)} / Backup $
          {money(data.backup_balance, 0)}
        </div>
        <div className="bbj-admin__bar-track">
          {(() => {
            const total = Number(data.main_balance) + Number(data.backup_balance);
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
              </>
            );
          })()}
        </div>
        <div className="bbj-admin__bar-label" style={{ marginTop: 6, opacity: 0.75 }}>
          Promo Is Not A Bank Here - It Is Swept To The Club Or Union Promo Wallet As It Arrives.
        </div>
      </div>

      {/* WHY IT HAS NOT PAID. The answer to the "Last Hit" tile above it. */}
      <div className="bbj-admin__misses">
        <div className="bbj-admin__misses-head">
          <span className="bbj-admin__misses-title">Why It Has Not Paid</span>
          <span className="bbj-admin__misses-sub">Hands Refused In The Last 30 Days</span>
        </div>

        {nearMissState === 'loading' && (
          <div className="bbj-admin__misses-empty">Reading The Refusal Log...</div>
        )}

        {/* NOT AN EMPTY LIST. The log could not be read, which is a different
            finding from "nothing was refused" and must not be able to pass for
            it. */}
        {nearMissState === 'unavailable' && (
          <div className="bbj-admin__misses-empty is-unknown">
            The Refusal Log Could Not Be Read, So This Is Not An Answer Either Way.
          </div>
        )}

        {nearMissState === 'ok' && nearMisses.length === 0 && (
          <div className="bbj-admin__misses-empty">
            No Hand Was Refused In 30 Days. Across {Number(data.hands_7d).toLocaleString()}{' '}
            Qualifying Hands In The Last 7 Days, Nothing Reached The Losing Hand Bar. The Rules Are
            Not Turning Hands Away, They Are Simply Not Being Met.
          </div>
        )}

        {nearMissState === 'ok' &&
          nearMisses.map((m) => (
            <div
              key={`${m.kind}:${m.reason}`}
              className={`bbj-admin__miss ${m.kind === 'mini_refused' ? 'is-turned-away' : ''}`}
            >
              <span className="bbj-admin__miss-count">{Number(m.refusals).toLocaleString()}</span>
              <span className="bbj-admin__miss-body">
                <span className="bbj-admin__miss-label">{nearMissLabel(m.reason)}</span>
                <span className="bbj-admin__miss-sub">
                  {m.last_at ? `Last ${new Date(m.last_at).toLocaleDateString()}` : ''}
                  {Number(m.biggest_pot) > 0
                    ? ` - Biggest Pot $${money(Number(m.biggest_pot), 0)}`
                    : ''}
                </span>
                {/* The sentence the ENGINE already wrote for the player at the
                    table, from the most recent hand in this group. It is why
                    the reader returns `example` at all: without it this field
                    was selected, justified in the migration header, and shown
                    to nobody. */}
                {m.example ? <span className="bbj-admin__miss-eg">{m.example}</span> : null}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

export default BBJAdminAnalytics;
