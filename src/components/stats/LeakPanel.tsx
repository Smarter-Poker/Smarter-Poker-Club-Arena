/**
 * LeakPanel — the page's answer to "so what should I do about it?".
 *
 * Pure presentation over findLeaks(), which is a pure function over stats the
 * page has already loaded. No fetch, no cache, no loading state.
 *
 * The panel says something in all three cases, because a component that
 * renders nothing reads as broken: too few hands, no leaks found, or here are
 * the leaks.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { findLeaks, LEAK_MIN_HANDS, type LeakOverall, type LeakPosition } from './findLeaks';
import { staggerContainer, fadeUp } from './statsMotion';
import './LeakPanel.css';

interface Props {
  overall?: LeakOverall | null;
  positions?: LeakPosition[] | null;
  /** Suppress entrance animation while the print dossier renders. */
  still?: boolean;
}

const SEVERITY_LABEL: Record<string, string> = {
  high: 'Costly',
  medium: 'Worth Fixing',
  low: 'Minor',
};

export default function LeakPanel({ overall, positions, still = false }: Props) {
  const reduceMotionPref = useReducedMotion();
  const reduceMotion = reduceMotionPref || still;

  const { leaks, analysed, handsShort } = useMemo(
    () => findLeaks(overall, positions),
    [overall, positions]
  );

  if (!analysed) {
    return (
      <div className="leak-card">
        <h3 className="leak-title">What To Work On</h3>
        <p className="leak-empty-text">
          {handsShort >= LEAK_MIN_HANDS
            ? 'Play Some Hands And This Will Tell You What To Work On First.'
            : `About ${handsShort.toLocaleString()} More Hands And There Will Be Enough Here To Point At Something Real. Naming A Leak Off A Smaller Sample Would Mostly Be Describing Variance.`}
        </p>
      </div>
    );
  }

  if (leaks.length === 0) {
    return (
      <div className="leak-card">
        <h3 className="leak-title">What To Work On</h3>
        <p className="leak-empty-text">
          Nothing Stands Out As A Clear Leak In Your Numbers Right Now. That Does Not Mean The Game
          Is Solved, Only That The Obvious Structural Problems Are Not There - The Next Gains Are In
          Hand-By-Hand Decisions Rather Than In Your Overall Frequencies.
        </p>
      </div>
    );
  }

  return (
    <div className="leak-card">
      <div className="leak-head">
        <h3 className="leak-title">What To Work On</h3>
        <p className="leak-sub">
          Ranked By What Is Costing The Most. Worked Out From Your Own Frequencies, Not From A
          Template.
        </p>
      </div>

      {/* Plain list semantics with the animation on a motion.div: motion.div
          and motion.button are the only wrappers this codebase uses in
          production, and this component is destined for the Personal
          Assistant, so it should not carry a tag nothing else has proven. */}
      <motion.div
        className="leak-list"
        role="list"
        variants={reduceMotion ? undefined : staggerContainer}
        initial="initial"
        animate="animate"
      >
        {leaks.map((leak) => (
          <motion.div
            key={leak.id}
            role="listitem"
            className={`leak-item sev-${leak.severity}`}
            variants={reduceMotion ? undefined : fadeUp}
          >
            <div className="leak-item-head">
              <span className={`leak-sev sev-${leak.severity}`}>
                {SEVERITY_LABEL[leak.severity] ?? leak.severity}
              </span>
              <h4 className="leak-item-title">{leak.title}</h4>
            </div>
            <p className="leak-evidence">{leak.evidence}</p>
            <p className="leak-action">{leak.action}</p>
          </motion.div>
        ))}
      </motion.div>

      <p className="leak-note">
        These Are Frequency-Level Findings. They Cannot See How You Played Any Individual Hand, So
        Treat Them As Where To Look Rather Than As A Verdict.
      </p>
    </div>
  );
}
