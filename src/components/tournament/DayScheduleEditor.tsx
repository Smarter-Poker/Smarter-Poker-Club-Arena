/**
 * THE DAY SCHEDULE of a multi-day MTT, on the create form.
 *
 * One row per day: Day, Ends After Level, Starts At, and one Time Zone for the
 * whole plan (the zone every start is entered and later printed in). Day 1
 * starts at the form's own Start Time; the last day has no end level because
 * it plays to a winner. The rows become the plan fn_operator_seal_stage_plan
 * seals right after the tournament is created (src/utils/multiDaySchedule.ts
 * buildStagePlan); the database checks every rule again.
 *
 * Rendered only when the multi-day capability is available and the operator
 * has switched Multi-Day MTT on (TableConfigPage).
 */
import {
  MAX_DAYS,
  MIN_DAYS,
  timeZoneOptions,
  type StagePlanDraft,
} from '../../utils/multiDaySchedule';
import './DayScheduleEditor.css';

export default function DayScheduleEditor({
  value,
  onChange,
  day1StartLocal,
}: {
  value: StagePlanDraft;
  onChange: (next: StagePlanDraft) => void;
  /** The form's Start Time (datetime-local), shown on the Day 1 row. */
  day1StartLocal: string;
}) {
  const zones = timeZoneOptions();
  if (!zones.includes(value.timeZone)) zones.unshift(value.timeZone);
  const setDay = (index: number, patch: Partial<StagePlanDraft['days'][number]>) =>
    onChange({
      ...value,
      days: value.days.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    });
  const last = value.days.length - 1;

  return (
    <div className="day-schedule" aria-label="Day Schedule">
      <div className="day-schedule__head">
        <span className="day-schedule__title">Day Schedule</span>
        <label className="day-schedule__zone">
          <span className="day-schedule__label">Time Zone</span>
          <select
            className="config-select"
            value={value.timeZone}
            aria-label="Time Zone"
            onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ol className="day-schedule__rows">
        {value.days.map((day, i) => (
          <li key={i} className="day-schedule__row">
            <span className="day-schedule__day">Day {(i + 1).toLocaleString()}</span>
            <label className="day-schedule__cell">
              <span className="day-schedule__label">Ends After Level</span>
              {i === last ? (
                <span className="day-schedule__fixed">Plays To A Winner</span>
              ) : (
                <input
                  className="config-datetime"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={day.endAfterLevel || ''}
                  aria-label={`Day ${i + 1} Ends After Level`}
                  onChange={(e) =>
                    setDay(i, {
                      endAfterLevel: Math.max(0, Math.round(Number(e.target.value) || 0)),
                    })
                  }
                />
              )}
            </label>
            <label className="day-schedule__cell">
              <span className="day-schedule__label">Starts At</span>
              {i === 0 ? (
                <span className="day-schedule__fixed">
                  {day1StartLocal ? day1StartLocal.replace('T', ' ') : 'The Start Time Above'}
                </span>
              ) : (
                <input
                  className="config-datetime"
                  type="datetime-local"
                  value={day.startsAtLocal}
                  aria-label={`Day ${i + 1} Starts At`}
                  onChange={(e) => setDay(i, { startsAtLocal: e.target.value })}
                />
              )}
            </label>
          </li>
        ))}
      </ol>

      <div className="day-schedule__actions">
        <button
          type="button"
          disabled={value.days.length >= MAX_DAYS}
          onClick={() =>
            onChange({
              ...value,
              // The old last day now ends somewhere; the new one plays to a winner.
              days: [...value.days, { endAfterLevel: 0, startsAtLocal: '' }],
            })
          }
        >
          Add Day
        </button>
        <button
          type="button"
          disabled={value.days.length <= MIN_DAYS}
          onClick={() => onChange({ ...value, days: value.days.slice(0, -1) })}
        >
          Remove Last Day
        </button>
      </div>
    </div>
  );
}
