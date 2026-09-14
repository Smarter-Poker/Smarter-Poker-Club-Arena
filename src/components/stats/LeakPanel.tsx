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
import { SpadeConsole } from '../console/SpadeConsole';
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
      <SpadeConsole
        className="leak-card"
        eyebrow="Analysis"
        title="What To Work On"
        pill="Not Yet"
        pillInk="muted"
        foot="foot"
      >
        <p className="sc-copy leak-empty-text">
          {handsShort >= LEAK_MIN_HANDS
            ? 'Play Some Hands And This Will Tell You What To Work On First.'
            : `About ${handsShort.toLocaleString()} More Hands And There Will Be Enough Here To Point At Something Real. Naming A Leak Off A Smaller Sample Would Mostly Be Describing Variance.`}
        </p>
      </SpadeConsole>
    );
  }

  if (leaks.length === 0) {
    return (
      <SpadeConsole
        className="leak-card"
        eyebrow="Analysis"
        title="What To Work On"
        pill="Clear"
        pillInk="green"
        foot="foot"
      >
        <p className="sc-copy leak-empty-text">
          Nothing Stands Out As A Clear Leak In Your Numbers Right Now. That Does Not Mean The Game
          Is Solved, Only That The Obvious Structural Problems Are Not There - The Next Gains Are In
          Hand-By-Hand Decisions Rather Than In Your Overall Frequencies.
        </p>
      </SpadeConsole>
    );
  }

  return (
    <SpadeConsole
      className="leak-card"
      eyebrow="Analysis"
      title="What To Work On"
      pill={`${leaks.length.toLocaleString()} ${leaks.length === 1 ? 'Leak' : 'Leaks'}`}
      pillInk="red"
      foot="foot"
    >
      <p className="sc-copy leak-sub">
        Ranked By What Is Costing The Most. Worked Out From Your Own Frequencies, Not From A
        Template.
      </p>

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
              <h4 className="leak-item-title sc-ink--silver">{leak.title}</h4>
            </div>
            <p className="sc-copy leak-evidence sc-ink--muted">{leak.evidence}</p>
            <p className="sc-copy leak-action">{leak.action}</p>
          </motion.div>
        ))}
      </motion.div>

      <p className="sc-copy leak-note sc-ink--muted">
        These Are Frequency-Level Findings. They Cannot See How You Played Any Individual Hand, So
        Treat Them As Where To Look Rather Than As A Verdict.
      </p>
    </SpadeConsole>
  );
}
