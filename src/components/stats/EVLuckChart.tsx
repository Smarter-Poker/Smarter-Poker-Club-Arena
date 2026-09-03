/**
 * EVLuckChart — cumulative actual profit against all-in-adjusted EV.
 *
 * The gap between the two lines is the entire point. Above EV means running
 * better than the cards deserved; below means the reverse. It is the one chart
 * that separates "I am losing" from "I am losing right now", which is the
 * difference between a strategy problem and a variance problem.
 *
 * WHERE THE EV COMES FROM: the engine already computed exact all-in equity for
 * every all-in (every hand is known at that point, so it is enumerated against
 * the actual opponents, not estimated against a range) and then discarded it —
 * it went to the client and a Prometheus histogram and nowhere else. It is now
 * persisted on ca_hand_facts. On hands with no all-in, ev_net equals net by
 * construction, so the two series only ever diverge where a stack was actually
 * committed. That is the correct behaviour: this adjusts for runouts, not for
 * every fold.
 *
 * NO BACKFILL: this data begins at the deploy date. An empty chart means "not
 * gathered yet", never "you have not played", and the copy below says so.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import StatsFactsService, { type EVCurvePayload } from '../../services/StatsFactsService';
import { chartReveal } from './statsMotion';
import './EVLuckChart.css';

interface Props {
  userId?: string;
  /** Suppress entrance animation so the print dossier never catches a half-drawn chart. */
  still?: boolean;
  /** Range in days, or null for all time. Mirrors the page's RANGES. */
  days?: number | null;
}

interface Row {
  i: number;
  actual: number;
  ev: number;
  /** Signed gap: positive is running above expectation. */
  luck: number;
  /**
   * The band BETWEEN the two lines, as recharts range areas. `above` spans
   * [ev, actual] where actual is above EV and collapses to [ev, ev] elsewhere;
   * `below` is the mirror. Before 2026-09-03 one Area plotted `luck` against
   * the same axis as the lines, so it filled from y=0 to the gap value - a
   * shape unrelated to either line - and took a single colour from the FINAL
   * sign, so a player who ended above EV saw green over every stretch they had
   * run below it.
   */
  above: [number, number];
  below: [number, number];
}

/**
 * All-in EV is high-variance: 30 spots tells a player almost nothing. Below
 * this the chart still renders — hiding it would be worse — but with a
 * permanent caveat rather than a confident headline.
 */
const MEANINGFUL_ALL_INS = 30;

function toRow(p: EVCurvePayload['points'][number]): Row {
  const actual = Number.isFinite(p.cum_net_bb) ? p.cum_net_bb : 0;
  const ev = Number.isFinite(p.cum_ev_net_bb) ? p.cum_ev_net_bb : 0;
  return {
    i: p.i,
    actual,
    ev,
    luck: actual - ev,
    above: actual >= ev ? [ev, actual] : [ev, ev],
    below: actual < ev ? [actual, ev] : [ev, ev],
  };
}

const fmtBB = (n: number): string =>
  `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;

export default function EVLuckChart({ userId, days = null, still = false }: Props) {
  // Recharts renders axis ticks with an INLINE fill, which no stylesheet can
  // override - so on a printed white page the near-white ticks disappear and
  // the chart loses both axes. `still` is only true while the dossier renders.
  const axisTick = { fill: still ? '#374151' : 'rgba(200,224,245,0.45)', fontSize: 10 };
  const gridStroke = still ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)';
  const zeroStroke = still ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.18)';
  const reduceMotionPref = useReducedMotion();
  const reduceMotion = reduceMotionPref || still;
  const [data, setData] = useState<EVCurvePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    StatsFactsService.getEVCurve(userId, days)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setReadError(payload.error ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, days, attempt]);

  const rows: Row[] = useMemo(() => {
    if (!data?.points?.length) return [];
    // Thin to a sane number of points: 5,000 SVG nodes is a scroll-jank
    // machine on a phone and indistinguishable from 400 at this width.
    const src = data.points;
    const stride = Math.max(1, Math.ceil(src.length / 400));
    const out: Row[] = [];
    for (let i = 0; i < src.length; i += stride) {
      const p = src[i];
      out.push(toRow(p));
    }
    const last = src[src.length - 1];
    if (out.length && out[out.length - 1].i !== last.i) {
      out.push(toRow(last));
    }
    return out;
  }, [data]);

  if (loading) {
    return (
      <div className="evluck-card evluck-loading">
        <div className="evluck-skeleton" />
      </div>
    );
  }

  const summary = data?.summary;
  const hasHands = (summary?.hands ?? 0) > 0;

  // A failed read is not an empty history. Say which.
  if (readError) {
    return (
      <div className="evluck-card evluck-empty" role="alert">
        <h3 className="evluck-title">Luck: Actual Vs Expected</h3>
        <p className="evluck-empty-text">
          This Chart Could Not Be Loaded Right Now.{' '}
          <button type="button" className="hand-retry" onClick={() => setAttempt((n) => n + 1)}>
            Try Again
          </button>
        </p>
      </div>
    );
  }

  if (!hasHands) {
    return (
      <div className="evluck-card evluck-empty">
        <h3 className="evluck-title">Luck: Actual Vs Expected</h3>
        <p className="evluck-empty-text">
          Nothing To Plot Yet. This Chart Is Built From A New Per-Hand Record That Started
          Collecting Recently, So It Fills In From Your Next Cash Session Onward Rather Than From
          Your Older History.
        </p>
      </div>
    );
  }

  const allIns = summary?.all_in_hands ?? 0;
  const luck = summary?.luck_bb ?? 0;
  const luckPer100 = summary?.luck_bb_per_100 ?? 0;
  const running = luck >= 0 ? 'above' : 'below';

  return (
    <motion.div
      className="evluck-card"
      variants={reduceMotion ? undefined : chartReveal}
      initial="initial"
      animate="animate"
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 22 }}
    >
      <div className="evluck-head">
        <h3 className="evluck-title">Luck: Actual Vs Expected</h3>
        {allIns === 0 ? (
          <p className="evluck-sub">
            No All-In Hands In This Range, So Expected And Actual Are Identical. Once You Get It In,
            The Two Lines Will Separate And The Gap Is Your Luck.
          </p>
        ) : (
          <p className="evluck-sub">
            You Are Running{' '}
            <strong className={luck >= 0 ? 'is-up' : 'is-down'}>
              {fmtBB(luck)} BB ({fmtBB(luckPer100)} BB/100)
            </strong>{' '}
            {running} Expectation Across {(summary?.hands ?? 0).toLocaleString()} Cash Hands,
            Measured Over {allIns.toLocaleString()} All-In {allIns === 1 ? 'Spot' : 'Spots'}.
          </p>
        )}
      </div>

      <div className="evluck-chart">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <defs>
              {/* Gradient ids are document-global in recharts; two charts
                  sharing one silently render the wrong fill. These are
                  namespaced so they cannot collide with the page's existing
                  `profitGradient`.

                  FIX 2026-08-21: there was only a "good" gradient, applied to
                  the gap regardless of sign — so a player running 200bb BELOW
                  expectation saw a reassuring green band. Colour is the only
                  encoding on this band, which inverted the chart's meaning for
                  exactly the players who most need to read it correctly. */}
              <linearGradient id="evluckGoodGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="evluckBadGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey="i" tick={axisTick} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={46} />
            <Tooltip
              contentStyle={{
                background: 'rgba(10,14,24,0.95)',
                border: '1px solid rgba(0,212,255,0.25)',
                borderRadius: 10,
                fontSize: 12,
              }}
              labelFormatter={(v) => `Hand ${Number(v).toLocaleString()}`}
              formatter={(value, name) => [`${fmtBB(Number(value ?? 0))} bb`, String(name ?? '')]}
            />
            <ReferenceLine y={0} stroke={zeroStroke} />
            {/* The band is the story: the space BETWEEN actual and expected.
                Green where actual runs above EV, red where it runs below, per
                point - so a bad stretch stays red even on a chart that ends
                well. See the Row docblock. */}
            <Area
              type="monotone"
              dataKey="above"
              name="Above Expected"
              stroke="none"
              fill="url(#evluckGoodGrad)"
              isAnimationActive={!reduceMotion}
              legendType="none"
              tooltipType="none"
            />
            <Area
              type="monotone"
              dataKey="below"
              name="Below Expected"
              stroke="none"
              fill="url(#evluckBadGrad)"
              isAnimationActive={!reduceMotion}
              legendType="none"
              tooltipType="none"
            />
            <Line
              type="monotone"
              dataKey="ev"
              name="Expected"
              stroke="#8b5cf6"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={!reduceMotion}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#00d4ff"
              strokeWidth={2.4}
              dot={false}
              isAnimationActive={!reduceMotion}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="evluck-legend">
        <span className="evluck-key">
          <i className="evluck-swatch" style={{ background: '#00d4ff' }} /> Actual
        </span>
        <span className="evluck-key">
          <i className="evluck-swatch is-dashed" style={{ borderColor: '#8b5cf6' }} /> Expected
        </span>
        <span className="evluck-key">
          <i className="evluck-swatch" style={{ background: 'rgba(34,197,94,0.45)' }} /> Above
          Expected
        </span>
        <span className="evluck-key">
          <i className="evluck-swatch" style={{ background: 'rgba(239,68,68,0.45)' }} /> Below
          Expected
        </span>
      </div>

      {allIns > 0 && allIns < MEANINGFUL_ALL_INS && (
        <p className="evluck-note">
          Based On {allIns} All-In {allIns === 1 ? 'Spot' : 'Spots'}. All-In EV Is Extremely
          High-Variance And A Sample This Small Can Swing Wildly. Treat It As A Curiosity Until It
          Is Well Past {MEANINGFUL_ALL_INS}.
        </p>
      )}
      {summary?.capped && (
        <p className="evluck-note">
          Showing Your Most Recent {(summary?.hands ?? 0).toLocaleString()} Cash Hands.
        </p>
      )}
      <p className="evluck-note">
        Expected Value Is Adjusted Only For All-In Runouts, Where Equity Is Known Exactly. It Does
        Not Judge Folds, Bet Sizing, Or Anything Else About How You Played.
      </p>
    </motion.div>
  );
}
