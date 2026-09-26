import { describe, expect, it } from 'vitest';
import {
  HORSE_DECISION_WORKER_NICE,
  currentThreadId,
  decisionWorkersCanYield,
  lowerDecisionWorkerPriority,
} from './workerPriority.js';

describe('decision worker priority', () => {
  it('reads its tid from /proc/thread-self and nothing else', () => {
    expect(currentThreadId(() => '1769150/task/1769254')).toBe(1769254);
    expect(currentThreadId(() => '1769150/task/1769150')).toBe(1769150);
    for (const bad of [
      '',
      'task/12',
      '12/task/',
      '12/task/0',
      '/proc/12/task/13',
      '12/task/13/x',
      'a/task/b',
    ])
      expect(currentThreadId(() => bad)).toBeNull();
    expect(
      currentThreadId(() => {
        throw new Error('ENOENT');
      })
    ).toBeNull();
  });

  it('lowers only this thread to nice 10 on linux and verifies the read-back', () => {
    const calls: Array<[number, number]> = [];
    let nice = 0;
    const outcome = lowerDecisionWorkerPriority({
      platform: 'linux',
      readlink: () => '100/task/207',
      getPriority: (pid) => (pid === 207 ? nice : -99),
      setPriority: (pid, priority) => {
        calls.push([pid, priority]);
        nice = priority;
      },
    });
    expect(HORSE_DECISION_WORKER_NICE).toBe(10);
    expect(calls).toEqual([[207, 10]]);
    expect(outcome).toEqual({
      status: 'lowered',
      platform: 'linux',
      tid: 207,
      nice: 10,
      reason: null,
    });
  });

  it('never raises a priority the kernel already lowered', () => {
    const calls: number[] = [];
    const outcome = lowerDecisionWorkerPriority({
      platform: 'linux',
      readlink: () => '100/task/207',
      getPriority: () => 19,
      setPriority: () => calls.push(1),
    });
    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe('already');
    expect(outcome.nice).toBe(19);
  });

  it('reports a kernel refusal or a lying read-back without throwing', () => {
    expect(
      lowerDecisionWorkerPriority({
        platform: 'linux',
        readlink: () => '100/task/207',
        getPriority: () => 0,
        setPriority: () => {
          throw new Error('EACCES');
        },
      })
    ).toMatchObject({ status: 'refused', tid: 207, reason: 'EACCES' });
    expect(
      lowerDecisionWorkerPriority({
        platform: 'linux',
        readlink: () => '100/task/207',
        getPriority: () => 0,
        setPriority: () => undefined,
      })
    ).toMatchObject({ status: 'refused', tid: 207, nice: 0 });
    expect(
      lowerDecisionWorkerPriority({ platform: 'linux', readlink: () => 'nonsense' })
    ).toMatchObject({ status: 'refused', tid: null });
  });

  it('keeps the inherited priority off linux', () => {
    const outcome = lowerDecisionWorkerPriority({
      platform: 'darwin',
      setPriority: () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome).toEqual({
      status: 'unsupported',
      platform: 'darwin',
      tid: null,
      nice: null,
      reason: 'not linux',
    });
    expect(decisionWorkersCanYield('linux')).toBe(true);
    expect(decisionWorkersCanYield('darwin')).toBe(false);
    expect(decisionWorkersCanYield('win32')).toBe(false);
  });
});
