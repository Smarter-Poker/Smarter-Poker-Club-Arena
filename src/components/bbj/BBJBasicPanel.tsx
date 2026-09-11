/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ BASIC — the rules, the fee, and what each stake pays
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The middle tab of the jackpot popup: the qualifying conditions in one
 * paragraph, then one row per stakes tier showing what the hand is charged and
 * how a hit is split.
 *
 * THE TIERS COME FROM THE DATABASE — `bbj_stakes_tiers`.
 *
 * CORRECTION 2026-08-23 (same day, later): an earlier version of this note
 * said that table is "what fn_bbj_payout actually pays from." It is not, and
 * saying so was the same mistake this file already made once. No database
 * function reads bbj_stakes_tiers and neither does server/src: the engine gets
 * the fee, the cap and the payout percent from STAKES_TIERS in
 * server/src/config/RakeConfig.ts and passes the percent into
 * bbj_atomic_payout_v2 as p_payout_total_percent.
 *
 * bbj_stakes_tiers is the PUBLISHED MIRROR of that config — the copy a client
 * can read without shipping server code. Reading it here is still the right
 * call (one published schedule, changeable without a deploy), but it is only
 * as true as the mirror. Two things keep it true:
 *   - migration 20260823_bbj_stakes_tiers_mirror_server_rakeconfig rewrote all
 *     six rows from the server config; five of them were wrong, including a
 *     Micro fee published as 0.40bb while 0.60bb was charged.
 *   - scripts/ci/check-rakeconfig-parity.mjs fails the build when the client
 *     and server configs diverge.
 *
 * ── WHY THIS CHANGED, 2026-08-23 ────────────────────────────────────────────
 * This file used to derive every figure from RAKE_SCHEDULE and STAKES_TIERS in
 * src/config/RakeConfig.ts, and the note above these lines claimed that made it
 * impossible to drift "because there is nothing to keep in sync." That was
 * wrong in one specific way: it kept the CLIENT'S copy in sync with the
 * CLIENT'S other copy. The engine pays from a third source, and all three had
 * diverged:
 *
 *            client RAKE_SCHEDULE   client STAKES_TIERS   DB bbj_stakes_tiers
 *   micro fee        0.6 bb              0.25 bb               0.40 bb
 *   small blinds     1/2                 1/2                   0.5/1 – 1.5/3
 *   high  blinds     5/10 – 10/25        —                     5/10 – 20/40
 *
 * The boundaries disagreed too, and that is the one that costs money rather
 * than merely confusing: getBBJPayoutPercentForBB sends anything above 25bb to
 * Nosebleeds (85%), while the DB caps High at 40bb. A 15/30 game was therefore
 * PROMISED 85% of the pool by this panel and PAID 70% by the engine.
 *
 * Reading the same rows the payout function reads is the only version of this
 * that cannot drift. RakeConfig stays as the offline fallback — an observer or
 * a dropped connection should still see a plausible table rather than an empty
 * one — and it is labelled as such in the UI so nobody mistakes it for the
 * live schedule.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BBJ_RULES,
  RAKE_SCHEDULE,
  STAKES_TIERS,
  getBBJPayoutPercentForBB,
} from '../../config/RakeConfig';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { miniTierForBB, type BbjMiniSnapshot } from '../../lib/bbjMiniFeed';
import { BBJ_MINI_SPLIT } from '../../config/bbjMini';
import './BBJBasicPanel.css';

export interface BBJBasicPanelProps {
  /** Live main pool, so each row can show what it would pay today. */
  poolAmount?: number;
  /** Big blind of the table the player is sitting at — its row is marked. */
  highlightBB?: number | null;
  /**
   * WHICH JACKPOT (Dan 2026-09-11: the Basic page "NEEDS TO BE UPDATED WITH NEW
   * MINI BBJ INFO AND DATA"). `mini` renders the mini's own schedule from the
   * live feed: the flat amount per stakes tier, its 50/25/25 split in chips,
   * and whether the reserve can pay it right now.
   */
  kind?: 'main' | 'mini';
  /** The mini feed snapshot (lib/bbjMiniFeed); required for `kind === 'mini'`. */
  mini?: BbjMiniSnapshot | null;
}

interface TierRow {
  pct: number;
  label: string;
  blinds: string;
  fee: string;
  /* The published split, as three independent percentages. They are NOT
     assumed to be pct*0.5 / pct*0.25 / pct*0.25: that identity holds for every
     row today, and hard-coding it means the day an operator retunes one tier
     the panel keeps printing the old shape. */
  loserPct: number;
  winnerPct: number;
  tablePct: number;
  /* The big-blind window this tier owns, used to mark the player's own row.
     Derived from the same source as the payout, so the highlight cannot point
     at a different row than the one that would pay. */
  minBB: number | null;
  maxBB: number | null;
}

/** Human label for each payout percent, matching the published stakes names. */
const PCT_LABEL: Record<number, string> = {
  15: 'Nano',
  25: 'Micro',
  40: 'Small',
  55: 'Mid',
  70: 'High',
  85: 'Nosebleeds',
};

function trimNum(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function chips(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * OFFLINE FALLBACK ONLY. Groups the client's published rake schedule by the
 * payout percent the client believes the server pays. Used when
 * bbj_stakes_tiers cannot be read (observer, dropped connection); the UI says
 * so when it is showing this rather than the live schedule.
 */
function buildFallbackTiers(): TierRow[] {
  const groups = new Map<number, { sb: number; bb: number; fee: number }[]>();
  RAKE_SCHEDULE.forEach((row) => {
    const pct = getBBJPayoutPercentForBB(row.bb);
    const list = groups.get(pct) || [];
    list.push({ sb: row.sb, bb: row.bb, fee: row.bbjFeeBB });
    groups.set(pct, list);
  });

  const rows: TierRow[] = [];
  Object.keys(PCT_LABEL)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((pct) => {
      const list = groups.get(pct);
      if (!list || list.length === 0) {
        // Nosebleeds have no exact schedule row — the engine falls back to the
        // tier table for them, so read the fee from there instead of guessing.
        if (pct === 85) {
          rows.push({
            pct,
            label: PCT_LABEL[pct],
            blinds: STAKES_TIERS.nosebleeds.blindRange,
            fee: `${trimNum(STAKES_TIERS.nosebleeds.bbjFeeBB)} bb`,
            loserPct: pct * 0.5,
            winnerPct: pct * 0.25,
            tablePct: pct * 0.25,
            minBB: null,
            maxBB: null,
          });
        }
        return;
      }
      const sorted = [...list].sort((a, b) => a.bb - b.bb);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const fees = [...new Set(sorted.map((r) => r.fee))].sort((a, b) => a - b);
      rows.push({
        pct,
        label: PCT_LABEL[pct],
        blinds:
          lo.bb === hi.bb
            ? `${trimNum(lo.sb)}/${trimNum(lo.bb)}`
            : `${trimNum(lo.sb)}/${trimNum(lo.bb)} - ${trimNum(hi.sb)}/${trimNum(hi.bb)}`,
        fee:
          fees.length === 1
            ? `${trimNum(fees[0])} bb`
            : `${trimNum(fees[0])} - ${trimNum(fees[fees.length - 1])} bb`,
        loserPct: pct * 0.5,
        winnerPct: pct * 0.25,
        tablePct: pct * 0.25,
        minBB: lo.bb,
        maxBB: hi.bb,
      });
    });

  return rows;
}

/** One row of bbj_stakes_tiers, as PostgREST returns it. */
interface DbTier {
  label: string | null;
  blind_range: string | null;
  min_bb: number | string | null;
  max_bb: number | string | null;
  bbj_fee_bb: number | string | null;
  payout_total_pct: number | string | null;
  payout_loser_pct: number | string | null;
  payout_winner_pct: number | string | null;
  payout_table_pct: number | string | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

function mapDbTiers(rows: DbTier[]): TierRow[] {
  return rows
    .map((r) => ({
      pct: num(r.payout_total_pct),
      label: r.label || '',
      // The DB writes an en dash; the table column is narrow, so normalise to
      // the hyphen the rest of this panel uses.
      blinds: (r.blind_range || '').replace(/\u2013/g, '-'),
      fee: `${trimNum(num(r.bbj_fee_bb))} bb`,
      loserPct: num(r.payout_loser_pct),
      winnerPct: num(r.payout_winner_pct),
      tablePct: num(r.payout_table_pct),
      minBB: r.min_bb == null ? null : num(r.min_bb),
      maxBB: r.max_bb == null ? null : num(r.max_bb),
    }))
    .filter((t) => t.pct > 0)
    .sort((a, b) => a.pct - b.pct);
}

/**
 * THE MINI'S SCHEDULE. Flat amounts, live from the feed - there is no client
 * fallback ladder because the amounts are Dan's configuration (bbj_mini_tiers)
 * and a stale copy printed here would be a number nobody is paying.
 */
export function BBJMiniBasicPanel({
  mini,
  highlightBB = null,
}: {
  mini: BbjMiniSnapshot | null | undefined;
  highlightBB?: number | null;
}) {
  const here =
    typeof highlightBB === 'number' && highlightBB > 0 && mini
      ? miniTierForBB(mini, highlightBB)
      : null;
  const tiers = mini ? [...mini.tiers].sort((a, b) => a.maxBB - b.maxBB) : [];

  return (
    <div className="bbj-basic">
      <p className="bbj-basic__rules">
        The Mini Jackpot Pays A Flat Amount, Set By The Stakes You Were Playing, For A Bad Beat That
        Meets The Mini Bar But Not The Main One: Aces Full Or Better Losing To Quads Or Better In
        Hold’em, Any Quads Losing To Bigger Quads Or Better In Omaha. The Same Pot, Player Count And
        Board Conditions Apply As For The Main Jackpot. No Extra Fee Is Taken For The Mini: It Is
        Paid From The Jackpot’s Backup Reserve, And It Pauses While The Reserve Is At Its Floor.
      </p>

      {!mini && <p className="bbj-basic__stale">Reading The Mini Jackpot Schedule.</p>}

      {mini && !mini.enabled && (
        <p className="bbj-basic__stale">The Mini Jackpot Is Switched Off For This Jackpot.</p>
      )}

      {mini && mini.enabled && (
        <div className="bbj-basic__scroll">
          <table className="bbj-basic__table">
            <thead>
              <tr>
                <th>Stakes</th>
                <th>Blinds</th>
                <th>Mini Pays</th>
                <th>
                  Split
                  <span className="bbj-basic__subhead">Bad Beat / Winner / Table</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const isHere = here?.tierId === t.tierId;
                const loser = t.amount * BBJ_MINI_SPLIT.loser;
                const winner = t.amount * BBJ_MINI_SPLIT.winner;
                const table = t.amount - loser - winner;
                return (
                  <tr key={t.tierId} className={isHere ? 'is-current' : ''}>
                    <td>
                      <span className="bbj-basic__tier">{t.label}</span>
                      {isHere && <span className="bbj-basic__here">YOUR STAKES</span>}
                    </td>
                    <td className="bbj-basic__blinds">{t.blindRange.replace(/\u2013/g, '-')}</td>
                    <td className="bbj-basic__pay">
                      <span className="bbj-basic__pcts">{chips(t.amount)}</span>
                      <span className="bbj-basic__today">
                        {t.enabled ? (t.payable ? 'Pays Now' : 'Paused - Reserve At Floor') : 'Off'}
                      </span>
                    </td>
                    <td className="bbj-basic__pay">
                      <span className="bbj-basic__pcts">
                        {chips(loser)} / {chips(winner)} / {chips(table)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="bbj-basic__note">
        A Mini Is Split Like The Main Jackpot: Half To The Bad Beat Hand, A Quarter To The Winner, A
        Quarter Shared By Everyone Else Dealt In. One Hand Pays One Jackpot, Never Both. Chips Are
        Credited To Your Stack At The Table The Moment It Hits.
      </p>
    </div>
  );
}

export function BBJBasicPanel({
  poolAmount = 0,
  highlightBB = null,
  kind = 'main',
  mini = null,
}: BBJBasicPanelProps) {
  /* Hooks below must run unconditionally; the mini branch is rendered after
     them so React sees the same hook order on every render. */
  const fallback = useMemo(buildFallbackTiers, []);
  const [dbTiers, setDbTiers] = useState<TierRow[] | null>(null);
  /**
   * THREE states, because two were not enough to tell the truth.
   *
   * `dbTiers === null` meant both "the fetch has not run yet" and "the fetch
   * failed", and the banner keyed off it — so every player saw
   * "The Live Table Could Not Be Read" flash on every single open, before the
   * request had been issued. A claim about a money schedule should not be made
   * while we are still finding out.
   */
  const [loadState, setLoadState] = useState<'loading' | 'live' | 'fallback'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('bbj_stakes_tiers')
          .select(
            'label, blind_range, min_bb, max_bb, bbj_fee_bb, payout_total_pct, payout_loser_pct, payout_winner_pct, payout_table_pct'
          );
        if (error) throw error;
        const mapped = mapDbTiers((data ?? []) as DbTier[]);
        if (!alive) return;
        if (mapped.length > 0) {
          setDbTiers(mapped);
          setLoadState('live');
        } else {
          // A successful read that yields no usable tier is not a success. It
          // used to be indistinguishable from a failure: nothing was reported,
          // nobody was told, and the panel showed the fallback forever.
          setLoadState('fallback');
          reportError(
            new Error('bbj_stakes_tiers returned no usable rows - showing the published fallback'),
            'BBJBasicPanel.empty_stakes_tiers'
          );
        }
      } catch (err) {
        if (alive) setLoadState('fallback');
        // Falling back is fine and expected for an observer; it must not be
        // silent, because a permanently-failing read means every player is
        // reading the client's stale ladder without knowing it.
        reportError(err, 'BBJBasicPanel.load_stakes_tiers');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const tiers = dbTiers ?? fallback;

  if (kind === 'mini') return <BBJMiniBasicPanel mini={mini} highlightBB={highlightBB} />;

  /* Highlight the player's own row from the SAME window the payout uses. When
     the live tiers are up that is min_bb/max_bb; only the fallback path is
     allowed to consult the client's boundary function, because that function
     is exactly what disagreed with the engine. */
  const hlPct =
    typeof highlightBB === 'number' && highlightBB > 0
      ? loadState === 'live'
        ? (tiers.find(
            (t) =>
              (t.minBB == null || highlightBB >= t.minBB) &&
              (t.maxBB == null || highlightBB <= t.maxBB)
          )?.pct ?? null)
        : getBBJPayoutPercentForBB(highlightBB)
      : null;

  return (
    <div className="bbj-basic">
      <p className="bbj-basic__rules">
        The Jackpot Drop Is Collected On Every Hand That Sees A Flop With{' '}
        {BBJ_RULES.minPlayersDealt} Or More Players Dealt In. To Win The Jackpot, The Pot Must Be At
        Least {BBJ_RULES.minPotBB} Big Blinds And {BBJ_RULES.minPlayersDealt} Players Must Be Dealt
        In Preflop.
        {BBJ_RULES.requireBothHoleCards
          ? ' Both Hole Cards Must Play, For The Losing Hand And The Winning Hand.'
          : ''}
        {BBJ_RULES.onlyFirstRunout
          ? ' When A Pot Is Run More Than Once, Only The First Runout Counts.'
          : ''}
        {BBJ_RULES.excludeDoubleBoard
          ? ' The Bad Beat Jackpot Is Not Available On Double And Triple Board Games.'
          : ''}
      </p>

      <div className="bbj-basic__scroll">
        <table className="bbj-basic__table">
          <thead>
            <tr>
              <th>Stakes</th>
              <th>Blinds</th>
              <th>Fee</th>
              <th>
                Payout
                <span className="bbj-basic__subhead">Bad Beat / Winner / Table / Total</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => {
              const isHere = hlPct !== null && hlPct === t.pct;
              const total = (poolAmount * t.pct) / 100;
              return (
                <tr key={t.pct} className={isHere ? 'is-current' : ''}>
                  <td>
                    <span className="bbj-basic__tier">{t.label}</span>
                    {isHere && <span className="bbj-basic__here">YOUR STAKES</span>}
                  </td>
                  <td className="bbj-basic__blinds">{t.blinds}</td>
                  <td className="bbj-basic__fee">{t.fee}</td>
                  <td className="bbj-basic__pay">
                    <span className="bbj-basic__pcts">
                      {trimNum(t.loserPct)}% / {trimNum(t.winnerPct)}% / {trimNum(t.tablePct)}% /{' '}
                      {trimNum(t.pct)}%
                    </span>
                    {poolAmount > 0 && (
                      /* Dan 2026-08-23: "the totals displayed under Today aren't
                         mathing correctly."
                         They were arithmetically right — pool x tier% to the
                         cent — but the label made them read as a daily figure,
                         and six different "Today" numbers off one pool cannot
                         all be today's. The pool is cumulative and this is what
                         the tier pays if it hits right now. Say that. */
                      <span className="bbj-basic__today">{chips(total)} If It Hits Now</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="bbj-basic__note">
        The Fee Is Taken From The Pot, Not From Your Stack, And Only On Hands That Meet The
        Conditions Above. A Hit Pays The Share Of The Main Pool Set By The Stakes You Were Playing,
        Never The Whole Pool.
      </p>

      {/* A stale ladder that looks authoritative is worse than one that admits
          it. When the live schedule could not be read, say so rather than
          letting the fallback pass for the real thing. */}
      {loadState === 'fallback' && (
        <p className="bbj-basic__stale">
          Showing The Published Schedule - The Live Table Could Not Be Read. Payouts Follow The
          Schedule In Force When The Hand Is Dealt.
        </p>
      )}
    </div>
  );
}

export default BBJBasicPanel;
