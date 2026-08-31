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
 */

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
}: {
  value: WeeklyScheduleValue;
  onChange: (next: WeeklyScheduleValue) => void;
}) {
  const toggleDay = (day: number) => {
    const has = value.daysOfWeek.includes(day);
    onChange({
      ...value,
      daysOfWeek: has ? value.daysOfWeek.filter((d) => d !== day) : [...value.daysOfWeek, day],
    });
  };

  const setTime = (index: number, time: string) => {
    const next = value.startTimesUtc.slice();
    next[index] = time;
    onChange({ ...value, startTimesUtc: next });
  };

  return (
    <div className="weekly-schedule-editor">
      <div className="wse-days">
        {DAY_LABELS.map((label, day) => (
          <button
            key={day}
            type="button"
            title={DAY_NAMES[day]}
            className={`wse-day-chip ${value.daysOfWeek.includes(day) ? 'active' : ''}`}
            onClick={() => toggleDay(day)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="wse-mode-row">
        <label className="wse-mode-option">
          <input
            type="radio"
            checked={value.mode === 'times'}
            onChange={() => onChange({ ...value, mode: 'times' })}
          />
          <span>At Set Times (UTC)</span>
        </label>
        <label className="wse-mode-option">
          <input
            type="radio"
            checked={value.mode === 'interval'}
            onChange={() => onChange({ ...value, mode: 'interval' })}
          />
          <span>Repeat Every N Minutes</span>
        </label>
      </div>

      {value.mode === 'times' ? (
        <div className="wse-times">
          {value.startTimesUtc.map((time, i) => (
            <div key={i} className="wse-time-row">
              <input
                type="time"
                className="wse-time-input"
                value={time}
                onChange={(e) => setTime(i, e.target.value)}
              />
              {value.startTimesUtc.length > 1 && (
                <button
                  type="button"
                  className="wse-remove-time"
                  aria-label="Remove This Start Time"
                  onClick={() =>
                    onChange({
                      ...value,
                      startTimesUtc: value.startTimesUtc.filter((_, j) => j !== i),
                    })
                  }
                >
                  &times;
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="wse-add-time"
            onClick={() => onChange({ ...value, startTimesUtc: [...value.startTimesUtc, '20:00'] })}
          >
            + Add Time
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
            onChange={(e) =>
              onChange({ ...value, intervalMinutes: Math.round(Number(e.target.value) || 0) })
            }
          />
          <span className="wse-interval-label">Minutes (5 - 1440)</span>
        </div>
      )}

      <p className="wse-hint">
        Days And Times Are In UTC. Pick At Least One Day
        {value.mode === 'interval' ? ' - the interval runs on the selected days.' : '.'}
      </p>
    </div>
  );
}

/** Validation shared by both hosts. Returns a message to toast, or null if valid. */
export function validateWeeklySchedule(value: WeeklyScheduleValue): string | null {
  if (value.daysOfWeek.length === 0) return 'Pick at least one day of the week.';
  if (value.mode === 'times') {
    const times = value.startTimesUtc.filter((t) => t.trim() !== '');
    if (times.length === 0) return 'Add at least one start time.';
    for (const t of times) {
      if (!TIME_UTC_PATTERN.test(t)) return 'Start times must be HH:MM, 24-hour.';
    }
    return null;
  }
  if (
    !Number.isInteger(value.intervalMinutes) ||
    value.intervalMinutes < 5 ||
    value.intervalMinutes > 1440
  ) {
    return 'The repeat interval must be 5 to 1440 minutes.';
  }
  return null;
}
