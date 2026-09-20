/**
 * THE LAST TWENTY - where the curve stopped, for everyone on this host.
 *
 * The first thing anyone who has played Aviator looks for: the run of recent
 * crash points. Newest on the left. Printed, not drawn: ink alone says what
 * kind of round it was, in the three bands every crash game agrees on (Dan's
 * directive 3, 2026-09-19): red under 2x, green from 2x, gold from 10x. The
 * strip reads at a glance and paints nothing over the glass.
 */

import type { FloorCrashPoint } from '../../services/DiamondGamesService';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import styles from '../../pages/diamondGames.module.css';

export type CrashBand = 'low' | 'mid' | 'high';

/** Under 2x is a loss for most, 2x and up a win, 10x and up the round people talk about. */
export function crashBand(cents: number): CrashBand {
  if (cents >= 1000) return 'high';
  if (cents >= 200) return 'mid';
  return 'low';
}

const INK: Record<CrashBand, string> = {
  low: 'sc-ink--red',
  mid: 'sc-ink--green',
  high: 'sc-ink--gold',
};

export default function CrashPointsStrip({ points }: { points: FloorCrashPoint[] }) {
  if (points.length === 0) return null;
  return (
    <div className={styles.strip} role="list" aria-label="Recent Crash Points">
      <span className={`sc-label sc-ink--blue ${styles.stripLabel}`}>Last {points.length}</span>
      {points.map((p, i) => {
        const band = crashBand(p.crash_cents);
        return (
          <span
            key={`${p.at}-${i}`}
            role="listitem"
            data-band={band}
            className={`${styles.stripItem} ${INK[band]}`}
          >
            {multiplierLabel(p.crash_cents)}
          </span>
        );
      })}
    </div>
  );
}
