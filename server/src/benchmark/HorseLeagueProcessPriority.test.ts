import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kernel = vi.hoisted(() => ({
  opendirSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  getPriority: vi.fn(),
}));
vi.mock('node:fs', () => kernel);
vi.mock('node:os', () => ({ getPriority: kernel.getPriority }));

// ---------------------------------------------------------------------------
// THE PLATFORM IS A KERNEL FACT, AND IT IS MOCKED LIKE EVERY OTHER ONE.
//
// Every kernel surface this module reads is faked above - opendirSync, openSync,
// readSync, closeSync, getPriority. The one it went on reading for real was
// `process.platform`, which captureCheckpoint() consults before it touches
// anything else. So this file used to open its hook with a hard assertion that
// the host was Linux, and on any machine that is not Linux all fifteen cases
// failed inside beforeEach with "expected 'darwin' to be 'linux'": one
// environment fact wearing the costume of fifteen logic regressions, on a
// benchmark whose entire job is to make a priority regression obvious.
//
// Not one of these cases needs a Linux kernel. They hand the parser fabricated
// /proc bytes and assert what it does with them, which is arithmetic, and is
// the same on every platform. HorseLeagueComputeProcessBoundary.test.ts - the
// sibling covering the launcher half of this same boundary - already settled
// how this tree answers that, and this file now follows it: stub the
// descriptor, restore it afterwards, and leave the REAL host proof to
// HorseLeagueProcessPriority.integration.test.ts, which forks an actual niced
// child and reads actual /proc.
//
// The refusal that assertion stood in for is not lost, it is gained. It was
// unreachable while the hook demanded the one platform on which it cannot fire;
// it has cases of its own below.
// ---------------------------------------------------------------------------
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

const pid = process.pid;
let directories: number[][];
let statValues: Map<number, string[]>;
let handles: Map<number, { bytes: Buffer; offset: number }>;
let directoryCloses: number;
let nextDescriptor: number;

function stat(tid: number, nice = 19, start = '249881547', comm = 'node'): string {
  const fields = Array<string>(50).fill('0');
  fields[0] = 'R';
  fields[16] = String(nice);
  fields[19] = start;
  return `${tid} (${comm}) ${fields.join(' ')}\n`;
}

beforeEach(() => {
  // The module refuses a non-Linux host before it reads proc. These cases are
  // about what it does once past that gate; the gate itself is asserted below.
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  vi.resetModules();
  vi.clearAllMocks();
  directories = [
    [pid, pid + 1],
    [pid, pid + 1],
    [pid, pid + 1],
    [pid, pid + 1],
  ];
  statValues = new Map();
  handles = new Map();
  directoryCloses = 0;
  nextDescriptor = 10;
  kernel.getPriority.mockReturnValue(19);
  kernel.opendirSync.mockImplementation(() => {
    const ids = directories.shift() ?? [pid, pid + 1];
    let index = 0;
    return {
      readSync: () =>
        index < ids.length ? { name: String(ids[index++]), isDirectory: () => true } : null,
      closeSync: () => {
        directoryCloses += 1;
      },
    };
  });
  kernel.openSync.mockImplementation((path: string) => {
    const tid = Number(path.split('/')[4]);
    const values = statValues.get(tid);
    const value = values?.length ? (values.length > 1 ? values.shift()! : values[0]) : stat(tid);
    const fd = nextDescriptor++;
    handles.set(fd, { bytes: Buffer.from(value), offset: 0 });
    return fd;
  });
  kernel.readSync.mockImplementation(
    (fd: number, target: Buffer, offset: number, length: number) => {
      const handle = handles.get(fd)!;
      const count = Math.min(length, handle.bytes.length - handle.offset);
      handle.bytes.copy(target, offset, handle.offset, handle.offset + count);
      handle.offset += count;
      return count;
    }
  );
  kernel.closeSync.mockImplementation((fd: number) => {
    handles.delete(fd);
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('Horse League inherited process priority evidence', () => {
  it.each(['darwin', 'win32'])(
    'refuses %s before reading proc, the gate the old platform assertion made unreachable',
    async (platform) => {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
      const module = await import('./HorseLeagueProcessPriority.js');
      expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(
        /Linux proc metadata is required/
      );
      // Refusing FIRST is the contract: a non-Linux host must not be probed at
      // all, so no priority read and no proc read may have happened.
      expect(kernel.getPriority).not.toHaveBeenCalled();
      expect(kernel.opendirSync).not.toHaveBeenCalled();
      expect(kernel.openSync).not.toHaveBeenCalled();
      // And a refused bootstrap leaves no proof behind for READY to lean on.
      expect(() => module.horseLeagueReadyPriorityProof()).toThrow(/bootstrap proof is absent/);
    }
  );

  it('does not repair a normal-priority launch or touch proc after the leader refusal', async () => {
    kernel.getPriority.mockReturnValue(0);
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/did not inherit/);
    expect(kernel.opendirSync).not.toHaveBeenCalled();
    expect(() => module.horseLeagueReadyPriorityProof()).toThrow(/bootstrap proof is absent/);
  });

  it('rejects a nice-19 leader with an ordinary helper, the observed production defect', async () => {
    statValues.set(pid + 1, [stat(pid + 1, 0)]);
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/inherited nice 0/);
    expect(handles.size).toBe(0);
    expect(directoryCloses).toBe(1);
  });

  it('requires bootstrap and verifies newly created startup threads before READY', async () => {
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.horseLeagueReadyPriorityProof()).toThrow(/bootstrap proof is absent/);
    module.verifyHorseLeagueBootstrapPriority();
    directories = [
      [pid, pid + 1, pid + 2],
      [pid, pid + 1, pid + 2],
    ];
    const proof = module.horseLeagueReadyPriorityProof();
    expect(proof.bootstrap.threadCount).toBe(2);
    expect(proof.ready.threadCount).toBe(3);
    expect(proof.pid).toBe(pid);
    expect(proof.expectedNice).toBe(19);
    expect(handles.size).toBe(0);
    expect(directoryCloses).toBe(4);
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/already verified/);
  });

  it('rejects a helper priority change during hydration', async () => {
    const module = await import('./HorseLeagueProcessPriority.js');
    module.verifyHorseLeagueBootstrapPriority();
    statValues.set(pid + 1, [stat(pid + 1, 0)]);
    expect(() => module.horseLeagueReadyPriorityProof()).toThrow(/inherited nice 0/);
    expect(handles.size).toBe(0);
  });

  it.each([
    { name: 'empty', ids: [] },
    { name: 'missing leader', ids: [pid + 1] },
    { name: 'duplicate', ids: [pid, pid] },
    { name: 'over cap', ids: Array.from({ length: 33 }, (_, i) => pid + i) },
  ])('refuses $name without partial success and closes the directory', async ({ ids }) => {
    directories = [ids];
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/verification failed/);
    expect(directoryCloses).toBe(1);
    expect(kernel.openSync).not.toHaveBeenCalled();
  });

  it('accepts exactly 32 verified threads and a bounded serialized proof', async () => {
    const ids = Array.from({ length: 32 }, (_, i) => pid + i);
    directories = [ids, ids, ids, ids];
    for (const tid of ids) statValues.set(tid, [stat(tid, 19, '18446744073709551615')]);
    const module = await import('./HorseLeagueProcessPriority.js');
    module.verifyHorseLeagueBootstrapPriority();
    const proof = module.horseLeagueReadyPriorityProof();
    expect(proof.ready.threadCount).toBe(32);
    expect(Buffer.byteLength(JSON.stringify(proof))).toBeLessThanOrEqual(512);
    expect(kernel.openSync).toHaveBeenCalledTimes(128);
    expect(kernel.closeSync).toHaveBeenCalledTimes(128);
    expect(handles.size).toBe(0);
  });

  it('rejects changed TID sets rather than retrying until a convenient snapshot', async () => {
    directories = [
      [pid, pid + 1],
      [pid, pid + 2],
    ];
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/identities changed/);
    expect(kernel.opendirSync).toHaveBeenCalledTimes(2);
    expect(handles.size).toBe(0);
  });

  it('rejects TID reuse with changed start ticks', async () => {
    statValues.set(pid + 1, [stat(pid + 1, 19, '123'), stat(pid + 1, 19, '124')]);
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/identities changed/);
    expect(handles.size).toBe(0);
  });

  it('rejects changed leader identity between bootstrap and READY', async () => {
    const module = await import('./HorseLeagueProcessPriority.js');
    module.verifyHorseLeagueBootstrapPriority();
    statValues.set(pid, [stat(pid, 19, '999')]);
    expect(() => module.horseLeagueReadyPriorityProof()).toThrow(
      /identity changed after bootstrap/
    );
  });

  it('closes the stat descriptor after a read error', async () => {
    kernel.readSync.mockImplementationOnce(() => {
      throw new Error('proc read refused');
    });
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow('proc read refused');
    expect(handles.size).toBe(0);
    expect(kernel.closeSync).toHaveBeenCalledTimes(1);
  });

  it('rejects oversize data with a capped buffer and closes the descriptor', async () => {
    statValues.set(pid, ['x'.repeat(4097)]);
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(() => module.verifyHorseLeagueBootstrapPriority()).toThrow(/byte limit/);
    expect(handles.size).toBe(0);
    expect(kernel.readSync.mock.calls[0][1].length).toBe(4097);
  });

  it('parses comm parentheses without shifting kernel priority fields', async () => {
    const module = await import('./HorseLeagueProcessPriority.js');
    expect(module.parseHorseLeagueThreadStat(stat(pid, 19, '123', 'node (helper)'), pid)).toEqual({
      tid: pid,
      nice: 19,
      startTicks: '123',
    });
    expect(() => module.parseHorseLeagueThreadStat(stat(pid + 1), pid)).toThrow(/identity/);
    expect(() => module.parseHorseLeagueThreadStat(`${pid} (node) R 0`, pid)).toThrow(/malformed/);
    expect(() => module.parseHorseLeagueThreadStat(stat(pid, 20), pid)).toThrow(/Linux range/);
    expect(() =>
      module.parseHorseLeagueThreadStat(stat(pid, 19, '18446744073709551616'), pid)
    ).toThrow(/malformed/);
  });
});
