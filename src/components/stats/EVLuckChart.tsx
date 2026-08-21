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

import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Range in days, or null for all time. Mirrors the page's RANGES. */
  days?: number | null;
}

interface Row {
  i: number;
  actual: number;
  ev: number;
  /** Signed gap, drawn as the shaded band. */
  luck: number;
}

/**
 * All-in EV is high-variance: 30 spots tells a player almost nothing. Below
 * this the chart still renders — hiding it would be worse — but with a
 * permanent caveat rather than a confident headline.
 */
const MEANINGFUL_ALL_INS = 30;

const fmtBB = (n: number): string =>
  `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;

export default function EVLuckChart({ userId, days = null }: Props) {
  const reduceMotion = useReducedMotion();
  const [data, setData] = useState<EVCurvePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    StatsFactsService.getEVCurve(userId, days)
      .then((payload) => {
        if (!cancelled && aliveRef.current) setData(payload);
      })
      .finally(() => {
        if (!cancelled && aliveRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, days]);

  const rows: Row[] = useMemo(() => {
    if (!data?.points?.length) return [];
    // Thin to a sane number of points: 5,000 SVG nodes is a scroll-jank
    // machine on a phone and indistinguishable from 400 at this width.
    const src = data.points;
    const stride = Math.max(1, Math.ceil(src.length / 400));
    const out: Row[] = [];
    for (let i = 0; i < src.length; i += stride) {
      const p = src[i];
      out.push({
        i: p.i,
        actual: p.cum_net_bb,
        ev: p.cum_ev_net_bb,
        luck: p.cum_net_bb - p.cum_ev_net_bb,
      });
    }
    const last = src[src.length - 1];
    if (out.length && out[out.length - 1].i !== last.i) {
      out.push({
        i: last.i,
        actual: last.cum_net_bb,
        ev: last.cum_ev_net_bb,
        luck: last.cum_net_bb - last.cum_ev_net_bb,
      });
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

  if (!hasHands) {
    return (
      <div className="evluck-card evluck-empty">
        <h3 className="evluck-title">Luck: Actual vs Expected</h3>
        <p className="evluck-empty-text">
          Nothing to plot yet. This chart is built from a new per-hand record that started
          collecting recently, so it fills in from your next cash session onward rather than from
          your older history.
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
        <h3 className="evluck-title">Luck: Actual vs Expected</h3>
        {allIns === 0 ? (
          <p className="evluck-sub">
            No all-in hands in this range, so expected and actual are identical. Once you get it in,
            the two lines will separate and the gap is your luck.
          </p>
        ) : (
          <p className="evluck-sub">
            You are running{' '}
            <strong className={luck >= 0 ? 'is-up' : 'is-down'}>
              {fmtBB(luck)} bb ({fmtBB(luckPer100)} bb/100)
            </strong>{' '}
            {running} expectation across {summary?.hands.toLocaleString()} cash hands, measured over{' '}
            {allIns.toLocaleString()} all-in {allIns === 1 ? 'spot' : 'spots'}.
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
                  `profitGradient`. */}
              <linearGradient id="evluckGoodGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="i"
              tick={{ fill: 'rgba(200,224,245,0.45)', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              tick={{ fill: 'rgba(200,224,245,0.45)', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={46}
            />
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
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
            {/* The band is the story: how far actual has drifted from EV. */}
            <Area
              type="monotone"
              dataKey="luck"
              name="Luck"
              stroke="none"
              fill="url(#evluckGoodGrad)"
              isAnimationActive={!reduceMotion}
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
          <i className="evluck-swatch" style={{ background: 'rgba(34,197,94,0.45)' }} /> Gap
        </span>
      </div>

      {allIns > 0 && allIns < MEANINGFUL_ALL_INS && (
        <p className="evluck-note">
          Based on {allIns} all-in {allIns === 1 ? 'spot' : 'spots'}. All-in EV is extremely
          high-variance and a sample this small can swing wildly. Treat it as a curiosity until it
          is well past {MEANINGFUL_ALL_INS}.
        </p>
      )}
      {summary?.capped && (
        <p className="evluck-note">
          Showing your most recent 5,000 cash hands.
        </p>
      )}
      <p className="evluck-note">
        Expected value is adjusted only for all-in runouts, where equity is known exactly. It does
        not judge folds, bet sizing, or anything else about how you played.
      </p>
    </motion.div>
  );
}
