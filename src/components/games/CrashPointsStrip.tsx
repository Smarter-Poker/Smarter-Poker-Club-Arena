/**
 * THE LAST TWENTY - where the curve stopped, for everyone on this host.
 *
 * The first thing anyone who has played Aviator looks for: the run of recent
 * crash points. Newest on the left. Printed, not drawn: ink alone says what
 * kind of round it was (muted under 2x, silver to 10x, gold past it), so the
 * strip reads at a glance and paints nothing over the glass.
 */

import type { FloorCrashPoint } from '../../services/DiamondGamesService';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import styles from '../../pages/diamondGames.module.css';

function inkFor(cents: number): string {
  if (cents >= 1000) return 'sc-ink--gold';
  if (cents >= 200) return 'sc-ink--silver';
  return 'sc-ink--muted';
}

export default function CrashPointsStrip({ points }: { points: FloorCrashPoint[] }) {
  if (points.length === 0) return null;
  return (
    <div className={styles.strip} role="list" aria-label="Recent Crash Points">
      <span className={`sc-label sc-ink--blue ${styles.stripLabel}`}>Last {points.length}</span>
      {points.map((p, i) => (
        <span
          key={`${p.at}-${i}`}
          role="listitem"
          className={`${styles.stripItem} ${inkFor(p.crash_cents)}`}
        >
          {multiplierLabel(p.crash_cents)}
        </span>
      ))}
    </div>
  );
}
