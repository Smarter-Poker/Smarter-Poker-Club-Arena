import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('qualifies MAIN Inspector transport, kernel ownership and durable operation claim in isolation', () => {
  const root = resolve('..');
  const native = spawnSync(
    process.execPath,
    [
      '--test',
      'tests/operations/retire-owned-main-inspector.test.mjs',
      'tests/operations/main-inspector-socket-qualification.test.mjs',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 131072,
    }
  );
  expect(native.error?.message ?? null, native.stderr).toBeNull();
  expect(native.status, native.stdout + native.stderr).toBe(0);
  if (process.platform === 'linux') expect(native.stdout).toMatch(/# skipped 0\b/);
  const host = spawnSync(
    'python3',
    ['-B', 'tests/operations/main-inspector-retirement-host.test.py'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 35000,
      maxBuffer: 131072,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  expect(host.error?.message ?? null, host.stderr).toBeNull();
  expect(host.status, host.stdout + host.stderr).toBe(0);
}, 60000);

it.skipIf(process.platform !== 'linux')(
  'qualifies the composed MAIN retirement on the exact production Node container',
  () => {
    const native = spawnSync(
      process.execPath,
      ['tests/operations/main-inspector-retirement-container.mjs'],
      {
        cwd: resolve('..'),
        encoding: 'utf8',
        timeout: 225000,
        maxBuffer: 131072,
      }
    );
    expect(native.error?.message ?? null, native.stderr).toBeNull();
    expect(native.status, native.stdout + native.stderr).toBe(0);
    const result = JSON.parse(native.stdout.trim());
    expect(result).toMatchObject({
      ok: true,
      skipped: false,
      image: 'node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
      nativeVersion: 'v22.23.2',
      sameContainerAndProcess: true,
      witnessUnchanged: true,
      gameActions: 0,
      cleanupRemoved: true,
      rawExitSameProcessAlive: true,
      hostEntry: {
        code: 0,
        hostDeadlineMs: 20000,
        extraOuterGraceMs: 0,
        intentDurable: true,
        receiptPresent: true,
        outcome: {
          ok: true,
          stage: 'complete',
          closeRequested: true,
          closeAcknowledged: true,
          connectionClosed: true,
          listenerAbsent: true,
          retryAllowed: false,
        },
      },
      hostTimeoutEntry: {
        busyEntry: {
          targetBusyEntered: true,
          nonceBound: true,
          witnessBound: true,
          pid: 1,
          gameActions: 0,
          beforeFixedClose: true,
        },
        code: 1,
        hostDeadlineMs: 20000,
        extraOuterGraceMs: 0,
        intentDurable: true,
        receiptPresent: false,
        outcome: {
          ok: false,
          reason: 'deadline_exhausted',
          entryStage: 'transport',
          stage: 'native_close',
          closeRequested: true,
          closeAcknowledged: true,
          connectionClosed: false,
          listenerAbsent: null,
          retryAllowed: false,
        },
      },
      timeoutEntry: {
        busyEntry: {
          targetBusyEntered: true,
          nonceBound: true,
          witnessBound: true,
          pid: 1,
          gameActions: 0,
          beforeFixedClose: true,
        },
        outcome: {
          ok: false,
          reason: 'deadline_exhausted',
          entryStage: 'transport',
          stage: 'native_close',
          closeRequested: true,
          closeAcknowledged: true,
          connectionClosed: false,
          retryAllowed: false,
        },
      },
      outcome: {
        ok: true,
        stage: 'complete',
        closeRequested: true,
        closeAcknowledged: true,
        connectionClosed: true,
        listenerAbsent: true,
        retryAllowed: false,
      },
    });
    expect(result.timeoutEntry.busyEntry.remainingMs).toBeGreaterThan(20000);
    expect(result.hostTimeoutEntry.busyEntry.remainingMs).toBeGreaterThan(20000);
  },
  230000
);
