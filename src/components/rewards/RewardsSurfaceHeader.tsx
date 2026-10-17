import { useId, type ReactNode } from 'react';
import PageBar from '../help/PageBar';
import '../club/ClubPageSection.css';
import { formatPopupText } from '../../utils/popupStyle';
import {
  SpadeConsole,
  type ConsoleCrest,
  type ConsoleFamily,
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

interface RewardsSurfaceHeaderProps {
  title: string;
  /** What the page is for. Shown behind the "?" in the top right, never on the page. */
  description: string;
  metrics?: RewardMetric[];
  /** Free-form controls kept beside the live figures. */
  actions?: ReactNode;
  /** The page's two doors. On the console they are its painted plates;
   *  without a console they are lit words in the page bar. */
  plates?: { secondary?: PlateButtonProps; primary?: PlateButtonProps };
  /** Live state, e.g. "OFFER INDEX // LIVE" or a sync word. Only the last
   *  segment prints, and only as a short word. */
  status?: string;
  /** Overrides the word the console prints in its painted pill slot. */
  pill?: string;
  pillInk?: ConsoleInk;
  /** The emblem this page's console wears. Every page picks its own. */
  crest?: ConsoleCrest;
  /** The approved painted chassis this page uses. */
  family?: ConsoleFamily;
  /** The page itself, printed on the console's glass so the surface stays one picture. */
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

const INK_TONE: Partial<Record<ConsoleInk, 'live' | 'attention' | 'danger'>> = {
  green: 'live',
  gold: 'attention',
  red: 'danger',
};

/** "LIVE" is the default state of every page; only a state worth reading prints. */
function barStatus(
  status: string | undefined
): { text: string; tone: 'default' | 'live' | 'attention' | 'danger' } | undefined {
  if (!status) return undefined;
  const { text, ink } = pillFromStatus(status);
  if (/^(live|synced|ready|open)$/i.test(text)) return undefined;
  return { text, tone: INK_TONE[ink] ?? 'default' };
}

function plateWord(props: PlateButtonProps, key: string) {
  const { label, ink = 'blue', haptic: _haptic, buttonRef, href, ...buttonProps } = props;
  return href ? (
    <a key={key} href={href} className={`club-page-action sc-ink--${ink}`}>
      {label}
    </a>
  ) : (
    <button
      key={key}
      {...buttonProps}
      ref={buttonRef}
      type={buttonProps.type || 'button'}
      className={`club-page-action sc-ink--${ink}`}
    >
      {label}
    </button>
  );
}

/**
 * THE REWARDS CIRCUIT HEADER (wallet, VIP, rakeback, promotions, bonuses,
 * achievements, marketplace, transactions, session history, the union pages
 * and the tournament pages).
 *
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS THAT EXIST LIKE THIS ON ANY AND ALL PAGES. ADD A ? MARK ICON
 * INSTEAD IN THE UPPER RIGHT CORNER". The eyebrow and the paragraph are gone
 * from every page; the paragraph is what the painted "?" now explains.
 *
 * Two shapes, decided by whether the page lives on the console:
 *  - A page that prints itself on the console's glass (children) keeps the
 *    Spade Console (#ClubArenaConsole): the painted head carries the title
 *    and the status word, the page sits on the glass, the two doors are the
 *    painted plates. The "?" sits above it, top right.
 *  - Every other page gets the page bar: its live figures and its doors as
 *    lit words, the "?" top right. No console is painted just to frame an
 *    introduction.
 */
export default function RewardsSurfaceHeader({
  title,
  description,
  metrics = [],
  actions,
  plates,
  status,
  pill,
  pillInk,
  crest = 'spade',
  family = 'spade',
  children,
}: RewardsSurfaceHeaderProps) {
  const titleId = useId();
  const pageTitle = formatPopupText(title);

  if (!children) {
    const live = pill ? undefined : barStatus(status);
    return (
      <PageBar
        title={pageTitle}
        summary={formatPopupText(description)}
        status={pill ? formatPopupText(pill) : live?.text}
        statusTone={pill ? (pillInk ? (INK_TONE[pillInk] ?? 'default') : 'default') : live?.tone}
        metrics={metrics}
      >
        {actions}
        {plates?.secondary && plateWord(plates.secondary, 'secondary')}
        {plates?.primary && plateWord(plates.primary, 'primary')}
      </PageBar>
    );
  }

  const fromStatus = pillFromStatus(status || 'LIVE');
  const pillText = pill ? formatPopupText(pill) : fromStatus.text;
  const ink = pillInk ?? (pill ? 'blue' : fromStatus.ink);

  return (
    <div className={styles.header}>
      <PageBar title={pageTitle} summary={formatPopupText(description)} titleAs={false} />
      <SpadeConsole
        as="section"
        title={pageTitle}
        titleId={titleId}
        pill={pillText}
        pillInk={ink}
        crest={crest}
        family={family}
        foot={plates ? 'plates' : 'foot'}
        plates={plates}
        className={styles.console}
        aria-labelledby={titleId}
      >
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
