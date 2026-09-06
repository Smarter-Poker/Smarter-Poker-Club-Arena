import { useState } from 'react';
import './ClubLaunchProgress.css';

export interface ClubLaunchTask {
  id: string;
  label: string;
  detail: string;
  complete: boolean;
  skipped?: boolean;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  disabledLabel?: string;
  onSkip?: () => void;
}

interface Props {
  clubId: string;
  viewerId: string;
  clubName: string;
  openingBank: number;
  tasks: ClubLaunchTask[];
}

function readSkippedIds(storageKey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

export default function ClubLaunchProgress({
  clubId,
  viewerId,
  clubName,
  openingBank,
  tasks,
}: Props) {
  /* IDs, never display names: two clubs may share a name, a club may be
     renamed, and two operators can use the same browser. The parent keys this
     component by the same identity tuple so React cannot carry one club's
     in-memory skips into another club during route-param navigation. */
  const storageKey = `club-launch-skips:${clubId}:${viewerId}`;
  const [skippedIds, setSkippedIds] = useState<string[]>(() => readSkippedIds(storageKey));
  const resolvedTasks = tasks.map((task) => ({
    ...task,
    skipped: !task.complete && skippedIds.includes(task.id),
  }));
  const completed = resolvedTasks.filter((task) => task.complete || task.skipped).length;
  const allTasksResolved = completed === resolvedTasks.length;
  const percent = allTasksResolved
    ? 100
    : Math.min(99, Math.round((completed / resolvedTasks.length) * 100));
  const [expanded, setExpanded] = useState(percent < 100);

  if (allTasksResolved) return null;

  return (
    <section className="club-launch" aria-labelledby="club-launch-title">
      <div className="club-launch__rail" aria-hidden="true" />
      <div className="club-launch__header">
        <div className="club-launch__seal" aria-hidden="true">
          <span>{percent}</span>
          <small>%</small>
        </div>
        <div className="club-launch__heading">
          <span className="club-launch__eyebrow">New Club Opening Checklist</span>
          <h2 id="club-launch-title">Open {clubName} For Play</h2>
          <p>
            {completed} Of {tasks.length} Launch Steps Complete
          </p>
        </div>
        <div
          className="club-launch__bank"
          aria-label={`${openingBank.toLocaleString()} Club Bank Chips`}
        >
          <span>Opening Club Bank</span>
          <strong>{openingBank.toLocaleString()}</strong>
          <small>Chips Ready</small>
        </div>
        <button
          type="button"
          className="club-launch__toggle"
          aria-expanded={expanded}
          aria-controls="club-launch-steps"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide Steps' : 'Show Steps'}
        </button>
      </div>

      <div
        className="club-launch__meter"
        role="progressbar"
        aria-label="Club Setup Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      {expanded && (
        <div className="club-launch__steps" id="club-launch-steps">
          {resolvedTasks.map((task, index) => (
            <article
              key={task.id}
              className={`club-launch__step ${task.complete ? 'is-complete' : task.skipped ? 'is-skipped' : ''}`}
            >
              <span className="club-launch__step-number" aria-hidden="true">
                {task.complete ? '✓' : task.skipped ? 'S' : String(index + 1).padStart(2, '0')}
              </span>
              <div className="club-launch__step-copy">
                <strong>{task.label}</strong>
                <span>{task.complete ? 'Complete' : task.skipped ? 'Skipped' : task.detail}</span>
              </div>
              <div className="club-launch__step-actions">
                {!task.complete && !task.skipped && (
                  <button
                    type="button"
                    className="is-skip"
                    onClick={() =>
                      setSkippedIds((current) => {
                        const next = current.includes(task.id) ? current : [...current, task.id];
                        try {
                          localStorage.setItem(storageKey, JSON.stringify(next));
                        } catch {
                          /* Storage can be disabled or full. The current
                             session still resolves the step; persistence is
                             best effort and must never crash the checklist. */
                        }
                        return next;
                      })
                    }
                  >
                    Skip
                  </button>
                )}
                <button
                  type="button"
                  onClick={task.onAction}
                  disabled={task.complete || task.skipped || task.disabled}
                >
                  {task.complete
                    ? 'Done'
                    : task.skipped
                      ? 'Skipped'
                      : task.disabled
                        ? task.disabledLabel || 'Owner Required'
                        : task.actionLabel}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
