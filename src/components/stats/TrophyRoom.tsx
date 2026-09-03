/**
 * TrophyRoom — playstyle badge, milestones, and what is closest to unlocking.
 *
 * WHY MILESTONES ARE DERIVED, NOT STORED
 * --------------------------------------
 * There is an existing achievements stack (achievementService +
 * training_user_achievements), but it belongs to the Training product, not to
 * live poker, and it carries a `_dbReadDisabled` circuit breaker that
 * permanently returns [] for the rest of the session after a single read error.
 * A Trophy Room built on it would show an empty room, with no error and no
 * retry, the first time RLS hiccuped — a bug that is close to undiagnosable
 * from a screenshot.
 *
 * Every milestone here is instead a pure function of stats the page has already
 * loaded. That means: no new table, no write path to secure, no breaker, no
 * cron, and it is correct the instant it renders. Server-side granting (with
 * rewards and notifications) is a later, separate concern; awarding from the
 * client would be forgeable anyway.
 *
 * ON THE PLAYSTYLE BADGE: PlayerStyleClassifier already returns a style, label,
 * colour and a CONFIDENCE. The confidence is honoured rather than ignored —
 * telling someone they are a "Maniac" off 80 hands is both wrong and rude, so
 * below the threshold this shows "Style Forming" and a hands-to-go count.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { playerStyleFromStats, STYLE_MIN_HANDS } from './playerStyleFromStats';
import { staggerContainer, fadeUp } from './statsMotion';
import './TrophyRoom.css';

/** Structural shapes — deliberately not imported from the page's private types. */
interface OverallLike {
  total_hands: number;
  cash_hands: number;
  hands_won: number;
  vpip: number;
  pfr: number;
  three_bet_percent: number;
  aggression_factor: number;
  showdowns_total: number;
  showdowns_won: number;
  wtsd: number;
  total_profit: number;
  biggest_pot_won: number;
  bb_per_100: number;
  hours_played: number;
}

interface TournLike {
  entries: number;
  cashes: number;
  wins: number;
  best_finish: number | null;
}

interface Props {
  overall?: OverallLike | null;
  tournaments?: TournLike | null;
}

type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

interface Milestone {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  /** 0..1 */
  progress: number;
  unlocked: boolean;
  /** Human progress line, e.g. "3,400 / 10,000 hands". */
  detail: string;
}

const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#fbbf24',
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function countMilestone(
  id: string,
  name: string,
  description: string,
  rarity: Rarity,
  value: number,
  target: number,
  unit: string
): Milestone {
  return {
    id,
    name,
    description,
    rarity,
    progress: clamp01(value / target),
    unlocked: value >= target,
    detail: `${Math.min(value, target).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })} / ${target.toLocaleString()} ${unit}`,
  };
}

function buildMilestones(o: OverallLike, t: TournLike | null): Milestone[] {
  const out: Milestone[] = [
    countMilestone(
      'first_hand',
      'First Hand',
      'Play your first hand.',
      'common',
      o.total_hands,
      1,
      'hands'
    ),
    countMilestone(
      'hundred',
      'Getting Started',
      'Play 100 hands.',
      'common',
      o.total_hands,
      100,
      'hands'
    ),
    countMilestone('grinder', 'Grinder', 'Play 1,000 hands.', 'rare', o.total_hands, 1000, 'hands'),
    countMilestone(
      'ironman',
      'Ironman',
      'Play 10,000 hands.',
      'epic',
      o.total_hands,
      10000,
      'hands'
    ),
    countMilestone(
      'marathon',
      'Marathon',
      'Log 50 hours at the tables.',
      'rare',
      o.hours_played,
      50,
      'hours'
    ),
    countMilestone(
      'showdown_vet',
      'Showdown Veteran',
      'Win 100 showdowns.',
      'rare',
      o.showdowns_won,
      100,
      'showdowns'
    ),
  ];

  // Result milestones. These are pass/fail rather than cumulative, so progress
  // is expressed against the gate that qualifies them.
  out.push({
    id: 'in_the_black',
    name: 'In The Black',
    description: 'Finish Ahead Across All Your Cash Play.',
    rarity: 'rare',
    progress: o.total_profit > 0 ? 1 : 0,
    unlocked: o.total_profit > 0,
    detail:
      o.total_profit > 0
        ? `Up ${Math.round(o.total_profit).toLocaleString()}`
        : `Down ${Math.round(Math.abs(o.total_profit)).toLocaleString()}`,
  });

  const crusherQualified = o.cash_hands >= 5000;
  out.push({
    id: 'crusher',
    name: 'Crusher',
    description: 'Hold A Positive Win Rate Over 5,000 Or More Cash Hands.',
    rarity: 'legendary',
    progress: crusherQualified ? (o.bb_per_100 > 0 ? 1 : 0) : clamp01(o.cash_hands / 5000),
    unlocked: crusherQualified && o.bb_per_100 > 0,
    detail: crusherQualified
      ? `${o.bb_per_100.toFixed(1)} bb/100 over ${o.cash_hands.toLocaleString()} hands`
      : `${o.cash_hands.toLocaleString()} / 5,000 qualifying hands`,
  });

  const disciplineQualified = o.total_hands >= 1000;
  const vpipPct = o.vpip * 100;
  const inBand = vpipPct >= 18 && vpipPct <= 28;
  out.push({
    id: 'disciplined',
    name: 'Disciplined',
    description: 'Hold VPIP Inside The 18-28% Range Over 1,000 Or More Hands.',
    rarity: 'epic',
    progress: disciplineQualified ? (inBand ? 1 : 0) : clamp01(o.total_hands / 1000),
    unlocked: disciplineQualified && inBand,
    detail: disciplineQualified
      ? `VPIP ${vpipPct.toFixed(1)}%`
      : `${o.total_hands.toLocaleString()} / 1,000 qualifying hands`,
  });

  const aggroQualified = o.total_hands >= 1000;
  out.push({
    id: 'aggressor',
    name: 'Aggressor',
    description: 'Hold An Aggression Factor Of 2.0 Or Better Over 1,000 Hands.',
    rarity: 'epic',
    progress: aggroQualified ? clamp01(o.aggression_factor / 2) : clamp01(o.total_hands / 1000),
    unlocked: aggroQualified && o.aggression_factor >= 2,
    detail: aggroQualified
      ? `AF ${o.aggression_factor.toFixed(2)}`
      : `${o.total_hands.toLocaleString()} / 1,000 qualifying hands`,
  });

  if (t) {
    out.push(
      countMilestone(
        'mtt_reg',
        'Tournament Regular',
        'Enter 10 tournaments.',
        'common',
        t.entries,
        10,
        'entries'
      ),
      countMilestone(
        'mtt_cash',
        'In The Money',
        'Cash in a tournament.',
        'rare',
        t.cashes,
        1,
        'cashes'
      ),
      countMilestone(
        'mtt_win',
        'Champion',
        'Win a tournament outright.',
        'legendary',
        t.wins,
        1,
        'wins'
      )
    );
  }

  return out;
}

export default function TrophyRoom({ overall, tournaments }: Props) {
  const reduceMotion = useReducedMotion();

  // Shared with the share card on PlayerStatsPage, so the two surfaces can
  // never disagree about a player's style. Returns null below STYLE_MIN_HANDS.
  const style = useMemo(() => playerStyleFromStats(overall), [overall]);

  const milestones = useMemo(
    () => (overall ? buildMilestones(overall, tournaments ?? null) : []),
    [overall, tournaments]
  );

  const unlocked = milestones.filter((m) => m.unlocked);
  const nextUp = milestones
    .filter((m) => !m.unlocked)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 3);

  if (!overall || overall.total_hands === 0) {
    return (
      <div className="trophy-card trophy-empty">
        <h3 className="trophy-title">Trophy Room</h3>
        <p className="trophy-empty-text">
          Play Some Hands And Your Trophies, And A Read On Your Playing Style, Will Appear Here.
        </p>
      </div>
    );
  }

  // playerStyleFromStats already returns null below STYLE_MIN_HANDS, so its
  // result IS the confidence gate. The previous `confidence >= 0.5` check was a
  // no-op: confidence is min(1, hands / 100), and hands is >= 300 by that point,
  // so it was always exactly 1.
  const styleConfident = style !== null;

  return (
    <div className="trophy-wrap">
      {/* ── Playstyle ── */}
      <div className="trophy-card">
        <h3 className="trophy-title">Your Style</h3>
        {styleConfident && style ? (
          <div className="trophy-style">
            <span
              className="trophy-style-badge"
              style={{ background: style.bgColor, color: style.color, borderColor: style.color }}
            >
              {style.icon}
            </span>
            <div className="trophy-style-body">
              <span className="trophy-style-label" style={{ color: style.color }}>
                {style.label}
              </span>
              <p className="trophy-style-note">{style.tooltip}</p>
            </div>
          </div>
        ) : (
          <div className="trophy-style">
            <span className="trophy-style-badge is-forming">--</span>
            <div className="trophy-style-body">
              <span className="trophy-style-label is-forming">Style Forming</span>
              <p className="trophy-style-note">
                {overall.total_hands < STYLE_MIN_HANDS
                  ? `${(STYLE_MIN_HANDS - overall.total_hands).toLocaleString()} More Hands And There Will Be Enough To Read Your Style Honestly. Guessing From ${overall.total_hands.toLocaleString()} Would Mostly Be Describing Variance.`
                  : 'Your Numbers Do Not Yet Sit Clearly In One Style. That Is Common, And Not A Bad Thing.'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Next up ── */}
      {nextUp.length > 0 && (
        <div className="trophy-card">
          <h3 className="trophy-title">Closest To Unlocking</h3>
          <ul className="trophy-next">
            {nextUp.map((m) => (
              <li key={m.id} className="trophy-next-item">
                <div className="trophy-next-head">
                  <span className="trophy-next-name" style={{ color: RARITY_COLORS[m.rarity] }}>
                    {m.name}
                  </span>
                  <span className="trophy-next-detail">{m.detail}</span>
                </div>
                <div className="trophy-progress">
                  <span
                    className="trophy-progress-fill"
                    style={{
                      width: `${Math.round(m.progress * 100)}%`,
                      background: RARITY_COLORS[m.rarity],
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── All trophies ── */}
      <div className="trophy-card">
        <div className="trophy-head-row">
          <h3 className="trophy-title">Trophies</h3>
          <span className="trophy-count">
            {unlocked.length} Of {milestones.length}
          </span>
        </div>

        {/* Plain <ul>/<li> with the animation on an inner motion.div.
            motion.div is the only element wrapper this codebase has used in
            production; motion.ul / motion.li were introduced here and are not
            worth the risk for a stagger. Semantics unchanged. */}
        <motion.div
          className="trophy-grid"
          variants={reduceMotion ? undefined : staggerContainer}
          initial="initial"
          animate="animate"
          role="list"
        >
          {milestones.map((m) => (
            <motion.div
              key={m.id}
              role="listitem"
              className={`trophy-item${m.unlocked ? ' is-unlocked' : ''}`}
              variants={reduceMotion ? undefined : fadeUp}
              style={
                m.unlocked
                  ? {
                      borderColor: `${RARITY_COLORS[m.rarity]}66`,
                      background: `linear-gradient(145deg, ${RARITY_COLORS[m.rarity]}1f, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                className="trophy-rarity"
                style={{ color: RARITY_COLORS[m.rarity] }}
                title={m.rarity}
              >
                {m.rarity}
              </span>
              <span className="trophy-name">{m.name}</span>
              <span className="trophy-desc">{m.description}</span>
              <span className="trophy-detail">{m.detail}</span>
              {!m.unlocked && (
                <div className="trophy-progress">
                  <span
                    className="trophy-progress-fill"
                    style={{
                      width: `${Math.round(m.progress * 100)}%`,
                      background: RARITY_COLORS[m.rarity],
                    }}
                  />
                </div>
              )}
            </motion.div>
          ))}
        </motion.div>

        <p className="trophy-note">
          Trophies Are Worked Out From Your Live Stats Each Time This Page Loads, So They Are Always
          Current And Never Need To Be Claimed.
        </p>
      </div>
    </div>
  );
}
