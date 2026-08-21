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
            ? 'Play some hands and this will tell you what to work on first.'
            : `About ${handsShort.toLocaleString()} more hands and there will be enough here to point at something real. Naming a leak off a smaller sample would mostly be describing variance.`}
        </p>
      </div>
    );
  }

  if (leaks.length === 0) {
    return (
      <div className="leak-card">
        <h3 className="leak-title">What To Work On</h3>
        <p className="leak-empty-text">
          Nothing stands out as a clear leak in your numbers right now. That does not mean the game
          is solved, only that the obvious structural problems are not there — the next gains are in
          hand-by-hand decisions rather than in your overall frequencies.
        </p>
      </div>
    );
  }

  return (
    <div className="leak-card">
      <div className="leak-head">
        <h3 className="leak-title">What To Work On</h3>
        <p className="leak-sub">
          Ranked by what is costing the most. Worked out from your own frequencies, not from a
          template.
        </p>
      </div>

      <motion.ol
        className="leak-list"
        variants={reduceMotion ? undefined : staggerContainer}
        initial="initial"
        animate="animate"
      >
        {leaks.map((leak) => (
          <motion.li
            key={leak.id}
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
          </motion.li>
        ))}
      </motion.ol>

      <p className="leak-note">
        These are frequency-level findings. They cannot see how you played any individual hand, so
        treat them as where to look rather than as a verdict.
      </p>
    </div>
  );
}
