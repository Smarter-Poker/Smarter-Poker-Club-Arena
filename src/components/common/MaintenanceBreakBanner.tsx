/**
 * THE LOBBY TELLS THE SAME TRUTH AS THE FELT (Dan 2026-09-01).
 *
 * During the :55 maintenance break the lobby used to look perfectly normal:
 * live player counts, enabled Join buttons, a working shopfront for a
 * platform that is deliberately standing still. A player who joined from
 * there had their buy-in refused by the freeze guard with no idea a break was
 * even running - the one place on the platform that never mentioned it was
 * the place people arrive through.
 *
 * Driven by the same hook as the table overlay, so the lobby and the felt can
 * never disagree about whether a break is on, and it keeps correct time
 * through the restart because the end instant is absolute. Renders nothing at
 * all outside a break, which is almost always.
 */

import React, { useEffect, useState } from 'react';
import { useMaintenanceBreak } from '../../hooks/useMaintenanceBreak';
import { serverNow } from '../../utils/serverClock';
import { isRoutineMaintenanceUpcoming } from '../../utils/maintenanceSchedule';
/* The banner prints in the console's own inks, so it loads the console's sheet
   itself rather than trusting the chunk to carry it. */
import '../console/SpadeConsole.css';
import './MaintenanceBreakBanner.css';

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function MaintenanceBreakBanner() {
  const { maintenanceBreak } = useMaintenanceBreak();
  const countingDown =
    maintenanceBreak.phase === 'counting_down' && !!maintenanceBreak.breakEndsAtMs;
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!maintenanceBreak.active || !countingDown) return;
    const read = () =>
      Math.max(0, Math.round(((maintenanceBreak.breakEndsAtMs as number) - serverNow()) / 1000));
    setRemaining(read());
    const t = setInterval(() => setRemaining(read()), 1000);
    return () => clearInterval(t);
  }, [maintenanceBreak.active, countingDown, maintenanceBreak.breakEndsAtMs]);

  // Daily Chicago heads-up; actual engine events still own every active break.
  const [upcoming, setUpcoming] = useState(() => isRoutineMaintenanceUpcoming(serverNow()));
  useEffect(() => {
    if (maintenanceBreak.active) return;
    const refresh = () => setUpcoming(isRoutineMaintenanceUpcoming(serverNow()));
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [maintenanceBreak.active]);

  if (!maintenanceBreak.active) {
    if (upcoming) {
      return (
        <div className="maintenance-banner maintenance-banner--upcoming" role="status">
          <span className="maintenance-banner__dot sc-ink--blue" aria-hidden="true">
            &bull;
          </span>
          <span className="maintenance-banner__text">
            Daily Maintenance At 4 AM Chicago Time. Expected Resume At 4:05 AM.
          </span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="maintenance-banner" role="status">
      <span className="maintenance-banner__dot sc-ink--blue" aria-hidden="true">
        &bull;
      </span>
      <span className="maintenance-banner__text">
        {countingDown
          ? `Maintenance Break In Progress. Expected Resume In ${formatTime(remaining)}. Seats And Chips Are Safe.`
          : maintenanceBreak.phase === 'finalizing'
            ? 'Finalizing Maintenance. Seats And Chips Remain Held. Play Resumes When Ready.'
            : maintenanceBreak.phase === 'resuming'
              ? 'Maintenance Complete. Tables Are Resuming.'
              : 'Maintenance Break Starting. Tables Are Finishing Their Current Hand.'}
      </span>
    </div>
  );
}

export default MaintenanceBreakBanner;
