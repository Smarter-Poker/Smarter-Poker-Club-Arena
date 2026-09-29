/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE NEXT DAY STARTS ON ITS SCHEDULE (multi-day R5 engine, 2026-09-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A BAGGED tournament has no manager, no lease and no tables. What brings it
 * back is its published schedule: `tournament_stages.scheduled_start_utc` of
 * the next stage. This is the "a job whose schedule IS the product" case of
 * CLAUDE.md 10.12 - it repairs nothing; the stage resume receipt is the state
 * and a timer only wakes the consumer that reads it.
 *
 * GameServer.discoverStageResumes reads the board (every BAGGED row and its
 * resumable stage) and hands it to `StageResumeSchedule.reconcile`, which
 * keeps exactly ONE wake timer per event, keyed on the stage, its schedule
 * generation and its due time. A reschedule bumps the generation, so the old
 * timer is replaced on the next read; the database refuses a stale
 * generation anyway (`fn_begin_stage_resume`: schedule_generation_stale).
 *
 * An event still BAGGED after its wake fired (the resume stood down: frozen
 * past the thaw, a refusal that needs a fix, a lost answer) is woken again
 * with a bounded backoff, so a refusal is re-asked minutes apart rather than
 * every pass. Readable from the board alone; nothing here writes.
 */
import { supabase } from '../services/supabase.js';
import { fetchAllRows } from '../services/supabase/pagination.js';
import { selectInChunks } from '../services/supabase/chunkedIn.js';
import { reportError } from '../services/errorReporter.js';
import { resumeTargetStage, type MultiDayStageRow } from './multiDayStages.js';

export interface StageResumeDue {
  tournamentId: string;
  name: string;
  stageNo: number;
  scheduleGeneration: number;
  /** 0 when the stage is already `resuming`: due now. */
  dueAtMs: number;
}

/** setTimeout's ceiling; a later wake re-arms from the next board read. */
const MAX_TIMER_MS = 2 ** 31 - 1;
export const STAGE_RESUME_BACKOFF_BASE_MS = 30_000;
export const STAGE_RESUME_BACKOFF_MAX_MS = 15 * 60_000;

export function stageResumeBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(
    STAGE_RESUME_BACKOFF_MAX_MS,
    STAGE_RESUME_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20)
  );
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StageResumeTimerApi {
  set: (callback: () => void, delayMs: number) => TimerHandle;
  clear: (timer: TimerHandle) => void;
  now: () => number;
}

const realTimers: StageResumeTimerApi = {
  set: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear: (timer) => clearTimeout(timer),
  now: () => Date.now(),
};

function keyOf(due: StageResumeDue): string {
  return `${due.stageNo}:${due.scheduleGeneration}:${due.dueAtMs}`;
}

export class StageResumeSchedule {
  private readonly armed = new Map<string, { key: string; fireAtMs: number; timer: TimerHandle }>();
  private readonly attempts = new Map<string, { key: string; count: number; lastAtMs: number }>();

  constructor(
    private readonly wake: (due: StageResumeDue) => void,
    private readonly timers: StageResumeTimerApi = realTimers
  ) {}

  /** How many events hold a wake right now (diagnostics and tests). */
  get size(): number {
    return this.armed.size;
  }

  has(tournamentId: string): boolean {
    return this.armed.has(tournamentId);
  }

  /**
   * Make the armed wakes exactly the board's. A complete board is required:
   * the caller passes nothing when its read was partial, and then every wake
   * already armed simply stays as it was.
   */
  reconcile(board: readonly StageResumeDue[]): void {
    const now = this.timers.now();
    const onBoard = new Set(board.map((due) => due.tournamentId));
    for (const [tournamentId, entry] of this.armed) {
      if (!onBoard.has(tournamentId)) {
        this.timers.clear(entry.timer);
        this.armed.delete(tournamentId);
      }
    }
    for (const tournamentId of this.attempts.keys()) {
      if (!onBoard.has(tournamentId)) this.attempts.delete(tournamentId);
    }
    for (const due of board) {
      const key = keyOf(due);
      const tried = this.attempts.get(due.tournamentId);
      if (tried && tried.key !== key) this.attempts.delete(due.tournamentId);
      const retry = this.attempts.get(due.tournamentId);
      const fireAtMs = Math.max(
        due.dueAtMs,
        retry ? retry.lastAtMs + stageResumeBackoffMs(retry.count) : 0
      );
      const existing = this.armed.get(due.tournamentId);
      if (existing && existing.key === key && existing.fireAtMs === fireAtMs) continue;
      if (existing) this.timers.clear(existing.timer);
      const delay = Math.min(MAX_TIMER_MS, Math.max(0, fireAtMs - now));
      const timer = this.timers.set(() => this.fire(due, key, fireAtMs), delay);
      this.armed.set(due.tournamentId, { key, fireAtMs, timer });
    }
  }

  private fire(due: StageResumeDue, key: string, fireAtMs: number): void {
    const entry = this.armed.get(due.tournamentId);
    if (!entry || entry.key !== key || entry.fireAtMs !== fireAtMs) return;
    this.armed.delete(due.tournamentId);
    const now = this.timers.now();
    // A wake capped by the timer ceiling is early; the next read re-arms it.
    if (now < fireAtMs) return;
    const tried = this.attempts.get(due.tournamentId);
    this.attempts.set(due.tournamentId, {
      key,
      count: tried && tried.key === key ? tried.count + 1 : 1,
      lastAtMs: now,
    });
    this.wake(due);
  }

  clear(): void {
    for (const entry of this.armed.values()) this.timers.clear(entry.timer);
    this.armed.clear();
    this.attempts.clear();
  }
}

/**
 * Every BAGGED event with a resumable next stage, or null when the board
 * could not be read completely (UNKNOWN is not "nothing is due").
 *
 * Before the multi-day migrations are installed no row can be BAGGED, so this
 * is one empty keyset read of `tournaments` and nothing else.
 */
export async function readStageResumeBoard(): Promise<StageResumeDue[] | null> {
  const board = await fetchAllRows<{ id: string; name: string | null }>(
    (cursor, want) => {
      let query = supabase
        .from('tournaments')
        .select('id, name')
        .eq('status', 'BAGGED')
        .order('id', { ascending: true })
        .limit(want);
      if (cursor) query = query.gt('id', cursor);
      return query;
    },
    { label: 'GameServer.stageResumes', maxRows: 50_000 }
  );
  if (!board.complete) return null;
  if (board.rows.length === 0) return [];

  const stages = await selectInChunks<Record<string, unknown>>(
    board.rows.map((row) => row.id),
    (batch) =>
      supabase
        .from('tournament_stages')
        .select('tournament_id, stage_no, scheduled_start_utc, schedule_generation, state')
        .in('tournament_id', batch)
        .in('state', ['bagged', 'scheduled', 'resuming']),
    'GameServer.stageResumeStages'
  );
  if (!stages.complete) return null;

  const byTournament = new Map<string, MultiDayStageRow[]>();
  for (const raw of stages.rows) {
    const tournamentId = raw.tournament_id;
    const stageNo = raw.stage_no;
    const generation = Number(raw.schedule_generation);
    const start = raw.scheduled_start_utc;
    if (
      typeof tournamentId !== 'string' ||
      !Number.isSafeInteger(stageNo) ||
      !Number.isSafeInteger(generation) ||
      typeof raw.state !== 'string' ||
      (start !== null && (typeof start !== 'string' || !Number.isFinite(Date.parse(start))))
    ) {
      reportError(
        new Error('[GameServer] stage resume board carried an unreadable stage row'),
        'GameServer.stage_resume_board_malformed'
      );
      return null;
    }
    const rows = byTournament.get(tournamentId) ?? [];
    rows.push({
      stageNo: stageNo as number,
      endAfterLevel: null,
      scheduledStartUtc: start as string | null,
      scheduleGeneration: generation,
      state: raw.state,
    });
    byTournament.set(tournamentId, rows);
  }

  const due: StageResumeDue[] = [];
  for (const row of board.rows) {
    const rows = (byTournament.get(row.id) ?? []).sort((a, b) => a.stageNo - b.stageNo);
    const target = resumeTargetStage(rows);
    if (!target) continue;
    const dueAtMs =
      target.state === 'resuming'
        ? 0
        : target.scheduledStartUtc === null
          ? Number.NaN
          : Date.parse(target.scheduledStartUtc);
    if (!Number.isFinite(dueAtMs)) continue;
    due.push({
      tournamentId: row.id,
      name: String(row.name ?? row.id),
      stageNo: target.stageNo,
      scheduleGeneration: target.scheduleGeneration,
      dueAtMs,
    });
  }
  return due;
}
