import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  clubLaunchSkipStorageKey,
  type ClubOpeningChecklistCompletion,
  type ClubOpeningChecklistServerState,
  isOptionalClubLaunchTaskId,
  parseClubOpeningChecklistState,
  readClubLaunchSkips,
  resolveClubLaunchTasks,
  writeClubLaunchSkips,
} from '../../utils/clubOpeningEligibility';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
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

/**
 * What the lobby reads beside the skips when the owner's checklist lives on
 * the server: the completion latch, and the one call that sets it.
 */
export interface ClubLaunchChecklistState extends ClubLaunchSkips {
  /** See ClubOpeningChecklistCompletion: undefined until the server answers. */
  completedAt: ClubOpeningChecklistCompletion;
  /** Latch the list finished. Resolves true once the server holds a latch. */
  complete: () => Promise<boolean>;
}

export interface ClubLaunchSkipOptions {
  /**
   * Read and write the owner's state on the server. The lobby turns this on
   * for the owner of a club that can have the checklist, and only then: the
   * functions answer the owner alone.
   */
  server?: boolean;
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

/**
 * Where the skips of this club and viewer are being kept right now:
 *   'local'    this browser (standalone callers, and the fallback when the
 *              server could not answer: today's behaviour)
 *   'loading'  the server has been asked and has not answered yet
 *   'server'   the server answered; skips and the latch are kept there
 */
type SkipSource = 'local' | 'loading' | 'server';

interface SkipState {
  stateKey: string | null;
  skippedIds: string[];
  completedAt: ClubOpeningChecklistCompletion;
  source: SkipSource;
}

function loadSkipState(
  stateKey: string | null,
  storageKey: string | null,
  server: boolean
): SkipState {
  return {
    stateKey,
    skippedIds: storageKey ? readClubLaunchSkips(storageKey, reportError) : [],
    completedAt: undefined,
    source: server && storageKey ? 'loading' : 'local',
  };
}

const withSkip = (ids: readonly string[], taskId: string): string[] =>
  ids.includes(taskId) ? [...ids] : [...ids, taskId];

/**
 * THE OWNER'S SKIPS AND THE COMPLETION LATCH LIVE ON THE SERVER (2026-09-23).
 *
 * With `server` on, the state is read once per club and viewer from
 * fn_club_opening_checklist_state, each skip or undo is written through
 * fn_club_opening_checklist_skip, and `complete` latches the list through
 * fn_club_opening_checklist_complete. Skips an older build left in this
 * browser are moved to the server once, and removed here only when every one
 * of them landed.
 *
 * Any error or unreadable answer is reported and falls back to today's local
 * behaviour: the skips come from and go to this browser, `completedAt` reads
 * null (not latched) and `complete` asks nothing. No timer, no polling, no
 * retry loop: the next page load asks again.
 *
 * Without `server` (standalone callers), skips are stored per club AND per
 * viewer in this browser, exactly as before. Storage is wrapped, every
 * failure is reported, and a failed write still resolves the step for the
 * current session. Pass an empty club id while the club is unknown.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useClubLaunchSkips(
  clubId: string,
  viewerId: string,
  options: ClubLaunchSkipOptions = {}
): ClubLaunchChecklistState {
  const server = Boolean(options.server && clubId);
  const storageKey = clubId ? clubLaunchSkipStorageKey(clubId, viewerId) : null;
  const stateKey = storageKey ? `${storageKey}:${server ? 'server' : 'local'}` : null;
  const [state, setState] = useState<SkipState>(() => loadSkipState(stateKey, storageKey, server));
  let current = state;
  if (state.stateKey !== stateKey) {
    /* Route-param navigation keeps this hook mounted while the club changes.
       Re-derive during render so one club's skips (and latch) are never
       applied to the next club, not even for a frame. */
    current = loadSkipState(stateKey, storageKey, server);
    setState(current);
  }

  /* One read per club, viewer and mode. The answer is applied only to the
     state it was asked for, so a slow answer about the previous club cannot
     land on the next one. */
  useEffect(() => {
    if (!server || !stateKey || !storageKey) return;
    let live = true;
    const apply = (next: Omit<SkipState, 'stateKey'>) => {
      if (live) setState((prev) => (prev.stateKey === stateKey ? { stateKey, ...next } : prev));
    };
    void (async () => {
      const local = readClubLaunchSkips(storageKey, reportError);
      let answer: ClubOpeningChecklistServerState;
      try {
        const { data, error } = await supabase.rpc('fn_club_opening_checklist_state', {
          p_club_id: clubId,
        });
        if (error) throw error;
        const parsed = parseClubOpeningChecklistState(data, clubId);
        if (!parsed)
          throw new Error('fn_club_opening_checklist_state answered an unreadable shape');
        answer = parsed;
      } catch (error) {
        reportError(error, 'ClubLaunchSkips.server_read_failed');
        apply({ skippedIds: local, completedAt: null, source: 'local' });
        return;
      }
      const known = answer;

      /* ONE-TIME MOVE of the skips an older build kept in this browser. Only
         optional steps travel (the server refuses anything else), and the
         browser copy is removed only when every one of them has landed; a
         failure leaves it for the next load and the owner still sees them. */
      const pending = local.filter(
        (id) => isOptionalClubLaunchTaskId(id) && !known.skippedTaskIds.includes(id)
      );
      let moved = true;
      for (const taskId of pending) {
        try {
          const { data, error } = await supabase.rpc('fn_club_opening_checklist_skip', {
            p_club_id: clubId,
            p_task_id: taskId,
            p_skipped: true,
          });
          if (error) throw error;
          if (!parseClubOpeningChecklistState(data, clubId)) {
            throw new Error('fn_club_opening_checklist_skip answered an unreadable shape');
          }
        } catch (error) {
          reportError(error, 'ClubLaunchSkips.local_move_failed', { taskId });
          moved = false;
          break;
        }
      }
      if (moved && local.length > 0) writeClubLaunchSkips(storageKey, [], reportError);
      apply({
        skippedIds: pending.reduce<string[]>(withSkip, [...known.skippedTaskIds]),
        completedAt: known.completedAt,
        source: 'server',
      });
    })();
    return () => {
      live = false;
    };
  }, [server, stateKey, storageKey, clubId]);

  const { skippedIds, source } = current;

  /* A server write that fails keeps today's behaviour: the step resolves for
     this session and this browser keeps the list, which the next load moves
     to the server. An undo that lands also clears the step from any browser
     copy still waiting to move, so it cannot come back from there. */
  const write = useCallback(
    (taskId: string, skipped: boolean, next: string[]) => {
      if (!storageKey) return;
      if (source !== 'server') {
        writeClubLaunchSkips(storageKey, next, reportError);
        return;
      }
      void (async () => {
        try {
          const { data, error } = await supabase.rpc('fn_club_opening_checklist_skip', {
            p_club_id: clubId,
            p_task_id: taskId,
            p_skipped: skipped,
          });
          if (error) throw error;
          if (!parseClubOpeningChecklistState(data, clubId)) {
            throw new Error('fn_club_opening_checklist_skip answered an unreadable shape');
          }
          if (!skipped) {
            const stored = readClubLaunchSkips(storageKey, reportError);
            if (stored.includes(taskId)) {
              writeClubLaunchSkips(
                storageKey,
                stored.filter((id) => id !== taskId),
                reportError
              );
            }
          }
        } catch (error) {
          reportError(error, 'ClubLaunchSkips.server_write_failed', { taskId, skipped });
          writeClubLaunchSkips(storageKey, next, reportError);
        }
      })();
    },
    [clubId, storageKey, source]
  );

  const commit = useCallback(
    (taskId: string, skipped: boolean, next: string[]) => {
      if (!stateKey) return;
      setState((prev) => (prev.stateKey === stateKey ? { ...prev, skippedIds: next } : prev));
      write(taskId, skipped, next);
    },
    [stateKey, write]
  );

  const skip = useCallback(
    (taskId: string) => {
      if (!skippedIds.includes(taskId)) commit(taskId, true, [...skippedIds, taskId]);
    },
    [skippedIds, commit]
  );
  const undoSkip = useCallback(
    (taskId: string) => {
      if (skippedIds.includes(taskId)) {
        commit(
          taskId,
          false,
          skippedIds.filter((id) => id !== taskId)
        );
      }
    },
    [skippedIds, commit]
  );

  /* The latch. Asked only when the server is the store: on the local
     fallback there is nothing to latch, and today's behaviour stands. */
  const complete = useCallback(async (): Promise<boolean> => {
    if (source !== 'server' || !stateKey) return false;
    try {
      const { data, error } = await supabase.rpc('fn_club_opening_checklist_complete', {
        p_club_id: clubId,
      });
      if (error) throw error;
      const answer = parseClubOpeningChecklistState(data, clubId);
      if (!answer?.completedAt) {
        throw new Error('fn_club_opening_checklist_complete answered without a latch');
      }
      const completedAt = answer.completedAt;
      setState((prev) => (prev.stateKey === stateKey ? { ...prev, completedAt } : prev));
      return true;
    } catch (error) {
      reportError(error, 'ClubLaunchSkips.latch_failed');
      return false;
    }
  }, [clubId, stateKey, source]);

  return {
    skippedIds,
    skip,
    undoSkip,
    completedAt: server ? current.completedAt : undefined,
    complete,
  };
}

/**
 * Renders nothing. Calls `onResolved` when `resolved` turns true. The lobby
 * builds its task list after its loading returns, where no hook can live, so
 * the moment "every step is resolved" is observed here and handed back to the
 * lobby, which owns the once-only, in-flight guard around the latch.
 */
export function ClubLaunchCompletionLatch({
  resolved,
  onResolved,
}: {
  resolved: boolean;
  onResolved: () => void;
}) {
  useEffect(() => {
    if (resolved) onResolved();
  }, [resolved, onResolved]);
  return null;
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
      /* The name is a database row, not a literal the Title Case gates can
         read, so it is cased where it is printed (skill 2, 2026-09-14). */
      title={`Open ${titleCase(clubName)}`}
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
