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

  /**
   * THE HEADS-UP BEFORE THE BREAK (to-do #2563 item 15). Poker rooms have
   * taken synchronized breaks before the hour for decades - it reads as
   * professional exactly when players are told it is COMING rather than
   * discovering it. From :50 the lobby says so. Minute-of-hour is the same
   * in every whole-hour timezone, so no server round trip is needed; the
   * engine's own announcement takes over at :53.
   */
  const [minuteOfHour, setMinuteOfHour] = useState(() => new Date().getMinutes());
  useEffect(() => {
    if (maintenanceBreak.active) return;
    const t = setInterval(() => setMinuteOfHour(new Date().getMinutes()), 15_000);
    return () => clearInterval(t);
  }, [maintenanceBreak.active]);

  if (!maintenanceBreak.active) {
    if (minuteOfHour >= 50 && minuteOfHour < 55) {
      return (
        <div className="maintenance-banner maintenance-banner--upcoming" role="status">
          <span className="maintenance-banner__dot" aria-hidden="true" />
          <span className="maintenance-banner__text">
            Hourly Break At :55. Play Is Expected To Resume On The Hour.
          </span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="maintenance-banner" role="status">
      <span className="maintenance-banner__dot" aria-hidden="true" />
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
