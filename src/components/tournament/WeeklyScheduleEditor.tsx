/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WEEKLY SCHEDULE EDITOR (2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The recurring-tournament recurrence editor shared by TableConfigPage (MTT
 * tab) and CreateTournamentModal. Pure controlled component: seven day chips
 * (0=Sunday .. 6=Saturday, matching tournament_schedules.days_of_week), one or
 * more HH:MM (24h, UTC) start times, and an alternative "repeat every N
 * minutes" mode. Days are required in BOTH modes — that is what
 * fn_upsert_tournament_schedule enforces.
 *
 * 2026-09-20. Start times are chosen from a dropdown of quarter-hour slots
 * (owner requirement: schedule dates and times are dropdowns, never a native
 * time picker). A saved time that is off the grid, 19:05 for example, stays in
 * the list and stays selected: the editor never rewrites a value nobody
 * touched. `hideInterval` removes the "Repeat Every N Minutes" mode for hosts
 * whose cadence cannot use it (the spawner reads a daily or monthly cadence
 * only from timed schedules); the editor then presents and emits 'times'.
 *
 * The rows print straight onto the console glass with engraved rules between
 * them. There is no card here on purpose: every host already sits inside a
 * painted frame, and a frame never sits on a frame.
 */

import { useEffect, useId } from 'react';
import { quarterHourOptions } from '../../lib/quarterHourStartSelect';
import './WeeklyScheduleEditor.css';

export interface WeeklyScheduleValue {
  daysOfWeek: number[];
  startTimesUtc: string[];
  mode: 'times' | 'interval';
  intervalMinutes: number;
}

export const DEFAULT_WEEKLY_SCHEDULE: WeeklyScheduleValue = {
  daysOfWeek: [],
  startTimesUtc: ['18:00'],
  mode: 'times',
  intervalMinutes: 60,
};

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const TIME_UTC_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Human summary of a stored schedule row — shared with the union manager. */
export function describeSchedule(
  days: number[],
  times: string[],
  intervalMinutes: number | null
): string {
  const dayText =
    days.length === 7
      ? 'Every day'
      : days
          .slice()
          .sort((a, b) => a - b)
          .map((d) => DAY_NAMES[d]?.slice(0, 3) ?? String(d))
          .join(', ');
  if (intervalMinutes) return `${dayText} - every ${intervalMinutes.toLocaleString()} min`;
  return `${dayText} at ${times.join(', ')} UTC`;
}

export default function WeeklyScheduleEditor({
  value,
  onChange,
  hideDays = false,
  hideInterval = false,
}: {
  value: WeeklyScheduleValue;
  onChange: (next: WeeklyScheduleValue) => void;
  hideDays?: boolean;
  /**
   * When true the "Repeat Every N Minutes" mode is not offered and the editor
   * works in 'times' mode only. A value that arrives in interval mode is shown
   * as its start times and handed back as 'times'. Default false.
   */
  hideInterval?: boolean;
}) {
  const modeGroupName = useId();
  const mode: WeeklyScheduleValue['mode'] = hideInterval ? 'times' : value.mode;

  /** Every change leaves through here, so a times-only host never receives 'interval'. */
  const emit = (next: WeeklyScheduleValue) =>
    onChange(hideInterval && next.mode !== 'times' ? { ...next, mode: 'times' } : next);

  // A times-only host that handed over an interval value gets it back as
  // 'times' once, so what it saves is what this editor is showing. Settles in
  // one pass: after the parent stores 'times' the condition is false.
  useEffect(() => {
    if (hideInterval && value.mode !== 'times') onChange({ ...value, mode: 'times' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideInterval, value.mode]);

  const toggleDay = (day: number) => {
    const has = value.daysOfWeek.includes(day);
    emit({
      ...value,
      daysOfWeek: has ? value.daysOfWeek.filter((d) => d !== day) : [...value.daysOfWeek, day],
    });
  };

  const setTime = (index: number, time: string) => {
    const next = value.startTimesUtc.slice();
    next[index] = time;
    emit({ ...value, startTimesUtc: next });
  };

  return (
    <div className="weekly-schedule-editor">
      {!hideDays && (
        <div className="wse-days" role="group" aria-label="Days Of The Week">
          {DAY_LABELS.map((label, day) => (
            <button
              key={day}
              type="button"
              aria-label={DAY_NAMES[day]}
              aria-pressed={value.daysOfWeek.includes(day)}
              className={`wse-day-chip ${value.daysOfWeek.includes(day) ? 'active' : ''}`}
              onClick={() => toggleDay(day)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!hideInterval && (
        <div className="wse-mode-row" role="radiogroup" aria-label="How This Schedule Repeats">
          <label className="wse-mode-option">
            <input
              type="radio"
              className="wse-mode-input"
              name={modeGroupName}
              checked={mode === 'times'}
              onChange={() => emit({ ...value, mode: 'times' })}
            />
            <span className="wse-mode-text">At Set Times (UTC)</span>
          </label>
          <label className="wse-mode-option">
            <input
              type="radio"
              className="wse-mode-input"
              name={modeGroupName}
              checked={mode === 'interval'}
              onChange={() => emit({ ...value, mode: 'interval' })}
            />
            <span className="wse-mode-text">Repeat Every N Minutes</span>
          </label>
        </div>
      )}

      {mode === 'times' ? (
        <div className="wse-times">
          {value.startTimesUtc.map((time, i) => (
            <div key={i} className="wse-time-row">
              <span className="wse-row-label">Start Time {(i + 1).toLocaleString()}</span>
              <select
                className="wse-time-input"
                aria-label={`Start Time ${(i + 1).toLocaleString()} (UTC)`}
                value={time}
                onChange={(e) => setTime(i, e.target.value)}
              >
                {time.trim() === '' && (
                  <option value={time} disabled>
                    Choose A Time
                  </option>
                )}
                {quarterHourOptions(time.trim() === '' ? '' : time).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {value.startTimesUtc.length > 1 && (
                <button
                  type="button"
                  className="wse-remove-time"
                  aria-label="Remove This Start Time"
                  onClick={() =>
                    emit({
                      ...value,
                      startTimesUtc: value.startTimesUtc.filter((_, j) => j !== i),
                    })
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="wse-add-time"
            onClick={() => emit({ ...value, startTimesUtc: [...value.startTimesUtc, '20:00'] })}
          >
            Add Time
          </button>
        </div>
      ) : (
        <div className="wse-interval-row">
          <span className="wse-interval-label">Every</span>
          <input
            type="number"
            className="wse-interval-input"
            min={5}
            max={1440}
            step={5}
            inputMode="numeric"
            value={value.intervalMinutes}
            aria-label="Repeat Interval In Minutes"
            onChange={(e) =>
              emit({ ...value, intervalMinutes: Math.round(Number(e.target.value) || 0) })
            }
          />
          <span className="wse-interval-label">Minutes (5 - 1440)</span>
        </div>
      )}

      <p className="wse-hint">
        Days And Times Are In UTC.{' '}
        {hideDays ? 'Choose At Least One Start Time' : 'Pick At Least One Day'}
        {mode === 'interval' ? ' - The Interval Runs On The Selected Days.' : '.'}
      </p>
    </div>
  );
}

/**
 * Validation shared by both hosts. Returns a message to toast, or null if
 * valid. Title Case in the source: a toast prints exactly what it is handed.
 */
export function validateWeeklySchedule(value: WeeklyScheduleValue): string | null {
  if (value.daysOfWeek.length === 0) return 'Pick At Least One Day Of The Week.';
  if (value.mode === 'times') {
    const times = value.startTimesUtc.filter((t) => t.trim() !== '');
    if (times.length === 0) return 'Add At Least One Start Time.';
    for (const t of times) {
      if (!TIME_UTC_PATTERN.test(t)) return 'Start Times Must Be HH:MM, 24-Hour.';
    }
    return null;
  }
  if (
    !Number.isInteger(value.intervalMinutes) ||
    value.intervalMinutes < 5 ||
    value.intervalMinutes > 1440
  ) {
    return 'The Repeat Interval Must Be 5 To 1440 Minutes.';
  }
  return null;
}
