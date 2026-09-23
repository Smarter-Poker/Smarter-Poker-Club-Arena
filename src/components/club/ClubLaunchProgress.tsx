import { useCallback, useState } from 'react';
import {
  clubLaunchSkipStorageKey,
  readClubLaunchSkips,
  resolveClubLaunchTasks,
  writeClubLaunchSkips,
} from '../../utils/clubOpeningEligibility';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { SpadeConsole } from '../console/SpadeConsole';
import './ClubLaunchProgress.css';

export interface ClubLaunchTask {
  id: string;
  label: string;
  detail: string;
  complete: boolean;
  /** Only an optional step draws Skip. A required step can never be skipped. */
  optional?: boolean;
  skipped?: boolean;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  disabledLabel?: string;
}

/** The skip state for one club and one viewer, and the two ways to change it. */
export interface ClubLaunchSkips {
  skippedIds: string[];
  skip: (taskId: string) => void;
  undoSkip: (taskId: string) => void;
}

interface Props {
  clubId: string;
  viewerId: string;
  clubName: string;
  openingBank: number;
  tasks: ClubLaunchTask[];
  /**
   * The lobby owns the skip state so that the checklist, the
   * `data-opening-checklist` attribute and the desktop scroll layout all
   * resolve from one value in one render. Omitted by standalone callers, which
   * then keep their own copy of the same stored state.
   */
  skips?: ClubLaunchSkips;
}

interface SkipState {
  storageKey: string | null;
  skippedIds: string[];
}

function loadSkipState(storageKey: string | null): SkipState {
  return {
    storageKey,
    skippedIds: storageKey ? readClubLaunchSkips(storageKey, reportError) : [],
  };
}

/**
 * Skips are stored per club AND per viewer in this browser. A server-side
 * store is a later database change; until then the storage is wrapped, every
 * failure is reported, and a failed write still resolves the step for the
 * current session. Pass an empty club id while the club is unknown.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useClubLaunchSkips(clubId: string, viewerId: string): ClubLaunchSkips {
  const storageKey = clubId ? clubLaunchSkipStorageKey(clubId, viewerId) : null;
  const [state, setState] = useState<SkipState>(() => loadSkipState(storageKey));
  let current = state;
  if (state.storageKey !== storageKey) {
    /* Route-param navigation keeps this hook mounted while the club changes.
       Re-derive during render so one club's skips are never applied to the
       next club, not even for a frame. */
    current = loadSkipState(storageKey);
    setState(current);
  }

  const commit = useCallback(
    (next: string[]) => {
      if (!storageKey) return;
      setState({ storageKey, skippedIds: next });
      writeClubLaunchSkips(storageKey, next, reportError);
    },
    [storageKey]
  );

  const { skippedIds } = current;
  const skip = useCallback(
    (taskId: string) => {
      if (!skippedIds.includes(taskId)) commit([...skippedIds, taskId]);
    },
    [skippedIds, commit]
  );
  const undoSkip = useCallback(
    (taskId: string) => {
      if (skippedIds.includes(taskId)) commit(skippedIds.filter((id) => id !== taskId));
    },
    [skippedIds, commit]
  );

  return { skippedIds, skip, undoSkip };
}

export default function ClubLaunchProgress({
  clubId,
  viewerId,
  clubName,
  openingBank,
  tasks,
  skips,
}: Props) {
  /* The parent keys this component by the same club and viewer tuple so React
     cannot carry one club's in-memory state into another club during
     route-param navigation. When the lobby supplies `skips`, the local copy is
     read but never used, so there is still exactly one source of truth. */
  const ownSkips = useClubLaunchSkips(skips ? '' : clubId, viewerId);
  const { skippedIds, skip, undoSkip } = skips ?? ownSkips;
  const resolvedTasks = resolveClubLaunchTasks(tasks, skippedIds);
  const completedCount = resolvedTasks.filter((task) => task.complete).length;
  const skippedCount = resolvedTasks.filter((task) => task.skipped).length;
  const allTasksResolved = completedCount + skippedCount === resolvedTasks.length;
  /* The meter counts finished work only. A skipped step is resolved, not done,
     so it never moves the bar; 100 is unreachable while the panel is drawn. */
  const percent = allTasksResolved
    ? 100
    : Math.min(99, Math.round((completedCount / resolvedTasks.length) * 100));
  const [expanded, setExpanded] = useState(percent < 100);

  if (allTasksResolved) return null;

  const progressLine = `${completedCount} Of ${tasks.length} Steps Complete`;
  const subtitle =
    skippedCount > 0
      ? `${progressLine} · ${skippedCount} Skipped`
      : `Prepare For Play · ${progressLine}`;

  return (
    <SpadeConsole
      as="section"
      className="club-launch"
      aria-labelledby="club-launch-title"
      eyebrow="New Club Opening Checklist"
      title={`Open ${clubName}`}
      titleId="club-launch-title"
      subtitle={subtitle}
      pill={`${percent}%`}
      pillInk={percent >= 75 ? 'green' : percent >= 40 ? 'gold' : 'blue'}
      crest="diamond"
      foot="foot"
    >
      <div className="club-launch__command-row">
        <div
          className="club-launch__bank"
          aria-label={`${compactChips(openingBank)} Club Bank Chips`}
        >
          <span>Opening Club Bank</span>
          <strong>{compactChips(openingBank)}</strong>
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
                {task.complete ? 'Done' : task.skipped ? 'Skip' : String(index + 1)}
              </span>
              <div className="club-launch__step-copy">
                <strong>{task.label}</strong>
                <span>
                  {task.complete
                    ? 'Complete'
                    : task.skipped
                      ? 'Skipped'
                      : task.optional
                        ? task.detail
                        : `Required · ${task.detail}`}
                </span>
              </div>
              <div className="club-launch__step-actions">
                {task.optional && !task.complete && !task.skipped && (
                  <button
                    type="button"
                    className="is-skip"
                    aria-label={`Skip ${task.label}`}
                    onClick={() => skip(task.id)}
                  >
                    Skip
                  </button>
                )}
                {task.skipped && (
                  <button
                    type="button"
                    className="is-skip"
                    aria-label={`Undo Skip ${task.label}`}
                    onClick={() => undoSkip(task.id)}
                  >
                    Undo Skip
                  </button>
                )}
                {/* A skipped step keeps its real action: skipping is "not
                    now", never "locked out". */}
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
              </div>
            </article>
          ))}
        </div>
      )}
    </SpadeConsole>
  );
}
