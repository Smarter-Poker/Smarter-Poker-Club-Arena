import { useId, type ReactNode } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import {
  SpadeConsole,
  type ConsoleCrest,
  type ConsoleInk,
  type PlateButtonProps,
} from '../console/SpadeConsole';
import styles from './RewardsSurfaceHeader.module.css';
import './RewardsCircuitSurfaces.css';
import './PlayCircuitSurfaces.css';
import './UnionCircuitSurfaces.css';

export interface RewardMetric {
  label: string;
  value: number | string;
  tone?: 'default' | 'live' | 'attention';
}

/** The art the pre-console header showed beside its copy. Accepted so no caller
 *  changes; the console carries its own emblem (the crest) and paints nothing else. */
type RewardArt = 'diamonds' | 'vault' | 'vip' | 'missions' | 'market';

interface RewardsSurfaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  metrics?: RewardMetric[];
  /** Free-form controls printed on the glass under the metrics. Prefer `plates`. */
  actions?: ReactNode;
  /** The two painted plates in the console's foot. */
  plates?: { secondary?: PlateButtonProps; primary?: PlateButtonProps };
  art?: RewardArt;
  artPath?: string;
  status?: string;
  /** Overrides the word the console prints in its painted pill slot. */
  pill?: string;
  pillInk?: ConsoleInk;
  /** The emblem this page's console wears. Every page picks its own. */
  crest?: ConsoleCrest;
  /** More of the page, printed on the same glass so the surface stays one picture. */
  children?: ReactNode;
}

const TONE_INK: Record<NonNullable<RewardMetric['tone']>, ConsoleInk> = {
  default: 'silver',
  live: 'green',
  attention: 'gold',
};

/**
 * "WALLET LEDGER // SYNCHRONIZED" prints its last word in the painted pill.
 *
 * The slot is 197 master pixels wide, so a twelve-letter word fills it to the
 * rim and its glow spills onto the chrome (Dan: "MAKE SURE FONT SIZES NEVER GO
 * OVER THE EDGES OF THE FRAME"). Long states are therefore SAID SHORTER rather
 * than shrunk to nothing: the readout keeps its meaning and keeps its air.
 */
const PILL_SHORT: Record<string, string> = {
  SYNCHRONIZED: 'Synced',
  SYNCHRONIZING: 'Syncing',
  RECONCILING: 'Syncing',
  CALCULATING: 'Working',
  UNAVAILABLE: 'Offline',
};

function pillFromStatus(status: string): { text: string; ink: ConsoleInk } {
  const tail = (status.split('//').pop() || status).trim();
  const short = PILL_SHORT[tail.toUpperCase()] ?? tail;
  const ink: ConsoleInk = /\b(LIVE|SYNCED|SYNCHRONIZED|READY|OPEN)\b/i.test(tail)
    ? 'green'
    : /\b(SYNCING|PENDING|CHECKING|LOADING|WORKING)\b/i.test(tail)
      ? 'gold'
      : /\b(OFFLINE|PAUSED|CLOSED)\b/i.test(tail)
        ? 'red'
        : 'blue';
  return { text: formatPopupText(short), ink };
}

/**
 * THE REWARDS CIRCUIT HEADER, ON THE SPADE CONSOLE (#ClubArenaConsole).
 *
 * One sheet for nineteen pages: wallet, VIP, rakeback, promotions, bonuses,
 * achievements, marketplace, transactions, session history, the union pages
 * and the tournament pages. Dan, 2026-09-09: "upgrade these using
 * #ClubArenaConsole, these pages are still generic ... NONE OF THOSE FOLLOW
 * the Painted-Chassis Standard."
 *
 * So the header is Dan's approved master and nothing is drawn: the eyebrow,
 * the title and the status word print into the head's measured zones, the
 * description and the metrics print on the black glass between the rails,
 * a page's own content can print on the same glass (children), and a page
 * with two actions gets them on the painted plates in the foot. The crest
 * is the emblem; there is no art panel, no gradient, no conduit.
 */
export default function RewardsSurfaceHeader({
  eyebrow,
  title,
  description,
  metrics = [],
  actions,
  plates,
  status = 'VALUE NETWORK // LIVE',
  pill,
  pillInk,
  crest = 'spade',
  children,
}: RewardsSurfaceHeaderProps) {
  const titleId = useId();
  /* The master's eyebrow zone ends where the crest begins, so the eyebrow
     prints the family ("Rewards Circuit"); the section is the title. */
  const family = eyebrow.split('/')[0].trim();
  const fromStatus = pillFromStatus(status);
  const pillText = pill ? formatPopupText(pill) : fromStatus.text;
  const ink = pillInk ?? (pill ? 'blue' : fromStatus.ink);

  return (
    <div className={styles.header}>
      <SpadeConsole
        as="section"
        eyebrow={formatPopupText(family)}
        title={formatPopupText(title)}
        titleId={titleId}
        pill={pillText}
        pillInk={ink}
        crest={crest}
        foot={plates ? 'plates' : 'foot'}
        plates={plates}
        className={styles.console}
        aria-labelledby={titleId}
      >
        <p className={`sc-copy ${styles.description}`}>{formatPopupText(description)}</p>

        {metrics.length > 0 && (
          <dl className={styles.metrics} aria-label={`${title} Live Summary`}>
            {metrics.map((metric) => (
              <div className={styles.metric} key={metric.label}>
                <dt className={`sc-label sc-ink--blue ${styles.metricLabel}`}>
                  {formatPopupText(metric.label)}
                </dt>
                <dd
                  className={`sc-ink--${TONE_INK[metric.tone || 'default']} ${styles.metricValue}`}
                >
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {actions && <div className={styles.actions}>{actions}</div>}

        {children}
      </SpadeConsole>
    </div>
  );
}
