import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual pure function inside the source-bound Linux fixture.
// Importing that executable would launch its Linux process controls on this
// host. The hosted integration continues to hash and execute the whole file.
const source = readFileSync(
  'scripts/qualification/horse-league-process-priority-native.mjs',
  'utf8'
);
const start = source.indexOf('function cpuDelta(');
const end = source.indexOf('\nasync function observeMatchupCPU', start);
assert(start >= 0 && end > start && end - start < 8000);
const cpuDelta = runInNewContext(`(${source.slice(start, end)})`, { assert }, { timeout: 1000 });

const leader = {
  tid: 4669,
  nice: 19,
  startTicks: '17701',
  policy: 0,
  userTicks: '34',
  systemTicks: '4',
};
const terminalLeader = { ...leader, userTicks: '45', systemTicks: '5' };
const retired = {
  tid: 4709,
  nice: 19,
  startTicks: '17784',
  policy: 0,
  userTicks: '1',
  systemTicks: '0',
};

describe('native Horse League CPU endpoint evidence', () => {
  it('retains the actual hosted retired-thread observation without inventing its final CPU', () => {
    const result = cpuDelta([leader, retired], [terminalLeader], leader.tid);
    expect(result.totalComparableTicks).toBe('12');
    expect(result.threads).toEqual([
      { tid: leader.tid, startTicks: leader.startTicks, userTicks: '11', systemTicks: '1' },
    ]);
    expect(result.absentOriginalThreads).toEqual([retired]);
    expect(result.newThreads).toEqual([]);
    expect(result.scope).toContain('not total process CPU');
  });

  it('does not combine reused TIDs or count a new thread as a comparable delta', () => {
    const reused = { ...retired, startTicks: '17799', userTicks: '900' };
    const result = cpuDelta([leader, retired], [terminalLeader, reused], leader.tid);
    expect(result.totalComparableTicks).toBe('12');
    expect(result.absentOriginalThreads).toEqual([retired]);
    expect(result.newThreads).toEqual([reused]);
  });

  it.each([{ last: [] }, { last: [{ ...terminalLeader, startTicks: '17702' }] }])(
    'refuses missing or replaced original process authority %#',
    ({ last }) => {
      expect(() => cpuDelta([leader], last, leader.tid)).toThrow('original process leader');
    }
  );

  it('refuses regressed counters for the same thread identity', () => {
    expect(() => cpuDelta([leader], [{ ...leader, userTicks: '33' }], leader.tid)).toThrow(
      'counters regressed'
    );
  });

  it('does not manufacture positive CPU from missing or new threads', () => {
    expect(
      cpuDelta([leader, retired], [leader, { ...retired, startTicks: '17799' }], leader.tid)
        .totalComparableTicks
    ).toBe('0');
  });

  it('refuses duplicate observation identities', () => {
    expect(() => cpuDelta([leader, leader], [terminalLeader], leader.tid)).toThrow(
      'duplicate thread identity'
    );
    expect(() => cpuDelta([leader], [terminalLeader, terminalLeader], leader.tid)).toThrow(
      'duplicate thread identity'
    );
  });
});
