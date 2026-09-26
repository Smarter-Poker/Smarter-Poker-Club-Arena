import { readlinkSync } from 'node:fs';
import { getPriority, setPriority } from 'node:os';

/**
 * THE DECISION WORKERS YIELD TO THE MAIN LOOP (2026-09-26).
 *
 * Two decision workers on engine-01 (two EPYC Milan cores, four SMT threads)
 * made the horses think (fallbacks 24-31/s to 0.0/s) and starved the main
 * thread: poker_event_loop_delay_p50_ms 20 to 300-650, the tournament lease
 * renewal pass missed its 20 s proof window in every storm, and
 * poker_tournament_managers_quarantined went 0 to 27 and then 436 in the
 * 08:19Z resume storm, with 487 stalled tables behind it (#5303, #5314). The
 * database was not the problem: heartbeat_tournament_leases_v4 stayed at a
 * 47 ms mean and a 4.6 s maximum through the same window. The main thread
 * simply lost the CPU race to two threads doing best-effort work.
 *
 * Decision work is best-effort by construction: every job carries a
 * deadline and a legal fallback, while the main loop is the authority that
 * renews leases, runs timers and broadcasts. So on Linux each decision
 * worker lowers its own thread priority (nice 10) before it loads a single
 * solver store, and the kernel gives the main thread the core whenever both
 * want it. The league compute process already runs at nice 19; decisions
 * sit between it and the main loop.
 *
 * Linux schedules threads as tasks, so setpriority(PRIO_PROCESS, tid)
 * applies to this thread alone; /proc/thread-self names the tid. On any
 * other platform, or if the kernel refuses, the worker keeps the inherited
 * priority and says so once; lane.ts then keeps one worker on a small host.
 */
export const HORSE_DECISION_WORKER_NICE = 10;

export interface DecisionWorkerPriorityOutcome {
  status: 'lowered' | 'already' | 'unsupported' | 'refused';
  platform: NodeJS.Platform;
  tid: number | null;
  nice: number | null;
  reason: string | null;
}

export interface DecisionWorkerPriorityDeps {
  platform?: NodeJS.Platform;
  readlink?: (path: string) => string;
  getPriority?: (pid: number) => number;
  setPriority?: (pid: number, priority: number) => void;
}

/** The tid of the calling thread, from /proc/thread-self ("<pid>/task/<tid>"). */
export function currentThreadId(readlink: (path: string) => string): number | null {
  let target: string;
  try {
    target = readlink('/proc/thread-self');
  } catch {
    return null;
  }
  const match = /^[1-9]\d{0,9}\/task\/([1-9]\d{0,9})$/.exec(target);
  if (!match) return null;
  const tid = Number(match[1]);
  return Number.isSafeInteger(tid) ? tid : null;
}

export function lowerDecisionWorkerPriority(
  deps: DecisionWorkerPriorityDeps = {}
): DecisionWorkerPriorityOutcome {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') {
    return { status: 'unsupported', platform, tid: null, nice: null, reason: 'not linux' };
  }
  const tid = currentThreadId(deps.readlink ?? ((path) => readlinkSync(path)));
  if (tid === null) {
    return {
      status: 'refused',
      platform,
      tid: null,
      nice: null,
      reason: '/proc/thread-self did not name this thread',
    };
  }
  const read = deps.getPriority ?? getPriority;
  const write = deps.setPriority ?? setPriority;
  try {
    const before = read(tid);
    if (before >= HORSE_DECISION_WORKER_NICE) {
      return { status: 'already', platform, tid, nice: before, reason: null };
    }
    write(tid, HORSE_DECISION_WORKER_NICE);
    const after = read(tid);
    if (after !== HORSE_DECISION_WORKER_NICE) {
      return {
        status: 'refused',
        platform,
        tid,
        nice: after,
        reason: `nice read back ${after} after setting ${HORSE_DECISION_WORKER_NICE}`,
      };
    }
    return { status: 'lowered', platform, tid, nice: after, reason: null };
  } catch (error) {
    return {
      status: 'refused',
      platform,
      tid,
      nice: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether this platform lets a worker yield to the main loop (lane.ts reads it). */
export function decisionWorkersCanYield(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}
