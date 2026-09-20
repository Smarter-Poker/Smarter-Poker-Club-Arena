import { closeSync, openSync, opendirSync, readSync } from 'node:fs';
import { getPriority } from 'node:os';

export const HORSE_LEAGUE_PROCESS_NICE = 19;
export const HORSE_LEAGUE_MAX_PROCESS_THREADS = 32;
const MAX_STAT_BYTES = 4_096;

interface ThreadPriority {
  tid: number;
  nice: number;
  startTicks: string;
}

interface PriorityCheckpoint {
  pid: number;
  leaderStartTicks: string;
  threadCount: number;
  observedNice: 19;
}

export interface HorseLeagueProcessPriorityProof {
  version: 1;
  scope: 'linux-thread-group';
  pid: number;
  leaderStartTicks: string;
  expectedNice: 19;
  bootstrap: { threadCount: number; observedNice: 19 };
  ready: { threadCount: number; observedNice: 19 };
}

let bootstrapCheckpoint: PriorityCheckpoint | null = null;

function refusal(reason: string): Error {
  return new Error(`horse league process priority verification failed: ${reason}`);
}

export function horseLeagueKernelStartTicksAreValid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,19}$/.test(value) &&
    (value.length < 20 || value <= '18446744073709551615')
  );
}

/** Parse only bounded kernel metadata, including comm values containing parentheses. */
export function parseHorseLeagueThreadStat(value: string, expectedTid: number): ThreadPriority {
  if (Buffer.byteLength(value) > MAX_STAT_BYTES) throw refusal('stat exceeds byte limit');
  const prefix = /^([1-9]\d{0,9}) \(/.exec(value);
  const close = value.lastIndexOf(')');
  if (!prefix || Number(prefix[1]) !== expectedTid || close < prefix[0].length) {
    throw refusal('stat thread identity is malformed');
  }
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (
    fields.length < 39 ||
    !/^-?(?:0|[1-9]\d?)$/.test(fields[16] ?? '') ||
    !horseLeagueKernelStartTicksAreValid(fields[19])
  ) {
    throw refusal('stat priority or start identity is malformed');
  }
  const nice = Number(fields[16]);
  if (nice < -20 || nice > 19) throw refusal('stat priority is outside Linux range');
  return { tid: expectedTid, nice, startTicks: fields[19] };
}

function threadIds(): number[] {
  const directory = opendirSync('/proc/self/task', { bufferSize: 8 });
  const ids: number[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (ids.length === HORSE_LEAGUE_MAX_PROCESS_THREADS) {
        throw refusal('thread count exceeds supported limit');
      }
      if (!/^[1-9]\d{0,9}$/.test(entry.name) || !entry.isDirectory()) {
        throw refusal('task directory entry is malformed');
      }
      const tid = Number(entry.name);
      if (!Number.isSafeInteger(tid) || ids.includes(tid)) {
        throw refusal('task directory identity is malformed');
      }
      ids.push(tid);
    }
  } finally {
    directory.closeSync();
  }
  if (ids.length === 0 || !ids.includes(process.pid)) {
    throw refusal('task directory has no process leader');
  }
  return ids.sort((a, b) => a - b);
}

function readThread(tid: number): ThreadPriority {
  const descriptor = openSync(`/proc/self/task/${tid}/stat`, 'r');
  const buffer = Buffer.alloc(MAX_STAT_BYTES + 1);
  let length = 0;
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > MAX_STAT_BYTES) throw refusal('stat exceeds byte limit');
    }
  } finally {
    closeSync(descriptor);
  }
  const thread = parseHorseLeagueThreadStat(buffer.toString('utf8', 0, length), tid);
  if (thread.nice !== HORSE_LEAGUE_PROCESS_NICE) {
    throw refusal(`thread ${tid} inherited nice ${thread.nice}`);
  }
  return thread;
}

function captureCheckpoint(): PriorityCheckpoint {
  if (process.platform !== 'linux') throw refusal('Linux proc metadata is required');
  // Check before any JavaScript priority mutation could conceal a bad launch.
  if (getPriority(0) !== HORSE_LEAGUE_PROCESS_NICE) {
    throw refusal('process leader did not inherit nice 19');
  }
  const first = threadIds().map(readThread);
  const second = threadIds().map(readThread);
  if (
    first.length !== second.length ||
    first.some(
      (thread, index) =>
        thread.tid !== second[index].tid || thread.startTicks !== second[index].startTicks
    )
  ) {
    throw refusal('thread identities changed during observation');
  }
  const leader = second.find((thread) => thread.tid === process.pid)!;
  return {
    pid: process.pid,
    leaderStartTicks: leader.startTicks,
    threadCount: second.length,
    observedNice: HORSE_LEAGUE_PROCESS_NICE,
  };
}

/** Called exactly once by the process entry, before importing solver/simulator code. */
export function verifyHorseLeagueBootstrapPriority(): void {
  if (bootstrapCheckpoint !== null) throw refusal('bootstrap was already verified');
  bootstrapCheckpoint = Object.freeze(captureCheckpoint());
}

export function requireHorseLeagueBootstrapPriority(): void {
  if (bootstrapCheckpoint === null) throw refusal('bootstrap proof is absent');
}

/** A second observation after hydration; never substitutes for the bootstrap observation. */
export function horseLeagueReadyPriorityProof(): HorseLeagueProcessPriorityProof {
  requireHorseLeagueBootstrapPriority();
  const bootstrap = bootstrapCheckpoint!;
  const ready = captureCheckpoint();
  if (ready.pid !== bootstrap.pid || ready.leaderStartTicks !== bootstrap.leaderStartTicks) {
    throw refusal('process identity changed after bootstrap');
  }
  return {
    version: 1,
    scope: 'linux-thread-group',
    pid: ready.pid,
    leaderStartTicks: ready.leaderStartTicks,
    expectedNice: HORSE_LEAGUE_PROCESS_NICE,
    bootstrap: { threadCount: bootstrap.threadCount, observedNice: 19 },
    ready: { threadCount: ready.threadCount, observedNice: 19 },
  };
}
