import { useState } from 'react';
import './ClubLaunchProgress.css';

export interface ClubLaunchTask {
  id: string;
  label: string;
  detail: string;
  complete: boolean;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  disabledLabel?: string;
}

interface Props {
  clubName: string;
  openingBank: number;
  tasks: ClubLaunchTask[];
}

export default function ClubLaunchProgress({ clubName, openingBank, tasks }: Props) {
  const completed = tasks.filter((task) => task.complete).length;
  const percent = tasks.length === 0 ? 100 : Math.round((completed / tasks.length) * 100);
  const [expanded, setExpanded] = useState(percent < 100);

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
          {tasks.map((task, index) => (
            <article
              key={task.id}
              className={`club-launch__step ${task.complete ? 'is-complete' : ''}`}
            >
              <span className="club-launch__step-number" aria-hidden="true">
                {task.complete ? '✓' : String(index + 1).padStart(2, '0')}
              </span>
              <div className="club-launch__step-copy">
                <strong>{task.label}</strong>
                <span>{task.complete ? 'Complete' : task.detail}</span>
              </div>
              <button
                type="button"
                onClick={task.onAction}
                disabled={task.complete || task.disabled}
              >
                {task.complete
                  ? 'Done'
                  : task.disabled
                    ? task.disabledLabel || 'Owner Required'
                    : task.actionLabel}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
