/**
 * TABLE MANAGEMENT: RESCHEDULE DAY 2.
 *
 * Mounted beside a tournament row on the club's table-management board. It
 * renders nothing unless the event is BAGGED, the multi-day capability is
 * available, the stage view reports a sealed plan, and the next day is still
 * `scheduled` (not yet starting). The move goes through
 * fn_operator_reschedule_stage, which checks the operator's club authority and
 * the live session and then runs the one reschedule rule in the database; the
 * expected schedule generation comes from the view, so a second operator's
 * earlier move is refused rather than overwritten.
 *
 * The new start is entered as a wall time in the PLAN's zone, the zone the
 * operator sealed the schedule in; it is shown beside the field.
 */
import { useState } from 'react';
import { useTournamentStageView } from '../../hooks/useTournamentStageView';
import { rescheduleStage, stageRefusalMessage } from '../../services/TournamentStageService';
import { useToast } from '../common/Toast';
import {
  formatStageStart,
  isBaggedStatus,
  utcIsoToZonedWallTime,
  zonedWallTimeToUtcIso,
} from '../../utils/multiDaySchedule';
import './RescheduleStageControl.css';

export default function RescheduleStageControl({
  tournamentId,
  status,
}: {
  tournamentId: string;
  status: string | null | undefined;
}) {
  const bagged = isBaggedStatus(status);
  const { view, reload } = useTournamentStageView(bagged ? tournamentId : null, status ?? null);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const next = view?.nextStart;
  if (!bagged || !view || !view.plan || !next || next.state !== 'scheduled') return null;
  const zone = view.plan.timeZone;
  const label = `Reschedule Day ${next.dayNo.toLocaleString()}`;

  const submit = async () => {
    const iso = zonedWallTimeToUtcIso(startsAt, zone);
    if (!iso) {
      toast.error(`Set When Day ${next.dayNo} Starts`);
      return;
    }
    if (reason.trim() === '') {
      toast.error('Give A Reason For The Move');
      return;
    }
    setBusy(true);
    try {
      const result = await rescheduleStage({
        tournamentId,
        stageNo: next.stageNo,
        newStartUtc: iso,
        expectedGeneration: next.scheduleGeneration,
        reason: reason.trim(),
      });
      if (result.ok) {
        toast.success(`Day ${next.dayNo} Now Starts ${formatStageStart(iso, zone) ?? ''}`.trim());
        setOpen(false);
        setReason('');
      } else {
        toast.error(stageRefusalMessage(result.reason));
      }
      reload();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setStartsAt(utcIsoToZonedWallTime(next.scheduledStartUtc, zone) ?? '');
          setOpen(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="md-reschedule" role="group" aria-label={label}>
      <label className="md-reschedule__field">
        {/* The zone as a place name, "America/New York", the way the Day
            Schedule editor lists it: an IANA id's underscore is not a word. */}
        <span className="md-reschedule__label">Starts At ({zone.replace(/_/g, ' ')})</span>
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          aria-label={`Day ${next.dayNo} Starts At`}
        />
      </label>
      <label className="md-reschedule__field">
        <span className="md-reschedule__label">Reason</span>
        <input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
        />
      </label>
      <div className="md-reschedule__actions">
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving...' : 'Save New Start'}
        </button>
      </div>
    </div>
  );
}
