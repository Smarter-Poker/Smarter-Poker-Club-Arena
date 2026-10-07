import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import {
  finalizeMissionCleanupWithEvidence,
  reloadMissionPageWithEvidence,
} from '../e2e/support/missionReloadObservation';

function fixture(
  options: { fails?: boolean; documentFails?: boolean; frameUnavailable?: boolean } = {}
) {
  const events = new EventEmitter();
  const frame = {};
  const original = new Error('net::ERR_ABORTED; original navigation refusal');
  const expected = 'https://smarter.poker/hub/club-arena/challenges/daily?source=certification';
  const request = {
    isNavigationRequest: () => true,
    frame: () => {
      if (options.frameUnavailable) throw new Error('Frame was not created');
      return frame;
    },
    url: () => expected,
    failure: () => ({ errorText: 'net::ERR_ABORTED private-untrusted-text' }),
  };
  const page = Object.assign(events, {
    url: () => expected,
    mainFrame: () => frame,
    reload: vi.fn(async () => {
      if (options.fails) {
        events.emit('requestfailed', request);
        throw original;
      }
    }),
    evaluate: vi.fn(async (fn: (arg: object) => object, arg: object) => {
      if (options.documentFails) throw new Error('context gone');
      return fn(arg);
    }),
  });
  return {
    page: page as unknown as Page,
    events,
    original,
    reload: page.reload,
    evaluate: page.evaluate,
  };
}

describe('failed mission reload evidence', () => {
  it('never lets navigation-before-frame metadata replace the original abort', async () => {
    const f = fixture({ fails: true, documentFails: true, frameUnavailable: true });
    const attach = vi.fn(async (_data: object) => {});
    await expect(reloadMissionPageWithEvidence(f.page, attach)).rejects.toBe(f.original);
    expect(attach.mock.calls[0][0]).toMatchObject({ navigation: [{ event: 'frame_unavailable' }] });
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.events.listenerCount('requestfailed')).toBe(0);
  });

  it('leaves successful navigation unchanged without collecting or attaching document evidence', async () => {
    const f = fixture();
    const attach = vi.fn(async (_data: object) => {});
    await reloadMissionPageWithEvidence(f.page, attach);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith({ waitUntil: 'domcontentloaded' });
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(f.events.listenerCount('requestfailed')).toBe(0);
  });
  it('retains an aborted request even if the actual mission document is rendered', async () => {
    const root = document.createElement('div');
    root.id = 'daily-missions';
    root.setAttribute('aria-busy', 'private-value');
    root.innerHTML =
      '<article id="mission-card-00000000-0000-4000-8000-000000000001"></article><input type="password" value="NEVER_CAPTURE"><article id="mission-card-private-value"></article>';
    document.body.append(root);
    const f = fixture({ fails: true });
    const attach = vi.fn(async (_data: object) => {});
    try {
      await expect(reloadMissionPageWithEvidence(f.page, attach)).rejects.toBe(f.original);
      expect(f.reload).toHaveBeenCalledOnce();
      const observation = attach.mock.calls[0][0] as unknown as {
        document: { missionRootPresent: boolean; missionBusy: string; currentMissionIds: string[] };
        navigation: object[];
      };
      expect(observation.document.missionRootPresent).toBe(true);
      expect(observation.document.missionBusy).toBe('unknown');
      expect(observation.document.currentMissionIds).toEqual([
        '00000000-0000-4000-8000-000000000001',
      ]);
      expect(observation.navigation).toMatchObject([{ event: 'failed', failureClass: 'aborted' }]);
      expect(JSON.stringify(observation)).not.toMatch(
        /NEVER_CAPTURE|private-untrusted-text|private-value|source=certification/
      );
    } finally {
      root.remove();
    }
  });
  it('retains the original abort when no document can be read', async () => {
    const f = fixture({ fails: true, documentFails: true });
    const attach = vi.fn(async (_data: object) => {});
    await expect(reloadMissionPageWithEvidence(f.page, attach)).rejects.toBe(f.original);
    expect(attach.mock.calls[0][0]).toMatchObject({ diagnosticOnly: true, document: null });
    expect(f.events.listenerCount('response')).toBe(0);
  });
  it('retains the original abort when attachment itself fails', async () => {
    const f = fixture({ fails: true, documentFails: true });
    await expect(
      reloadMissionPageWithEvidence(f.page, async () => {
        throw new Error('artifact unavailable');
      })
    ).rejects.toBe(f.original);
    expect(f.reload).toHaveBeenCalledOnce();
  });
  it('bounds a stalled document observation to one second without navigation retry', async () => {
    vi.useFakeTimers();
    const f = fixture({ fails: true });
    f.evaluate.mockImplementation(() => new Promise<object>(() => {}));
    const attach = vi.fn(async (_data: object) => {});
    const failure = expect(reloadMissionPageWithEvidence(f.page, attach)).rejects.toBe(f.original);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
      expect(attach.mock.calls[0][0]).toMatchObject({ observationTimeoutMs: 1000, document: null });
      expect(f.reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('runs evidence before the owned context closes while keeping the reload failure visible', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../e2e/production-daily-missions.spec.ts'),
      'utf8'
    );
    expect(source).toContain('await reloadMissionPageWithEvidence(page, async (observation) =>');
    expect(source.indexOf('daily-missions-reload-observation.json')).toBeLessThan(
      source.indexOf('for (const context of contexts.reverse())')
    );
    const helper = readFileSync(
      resolve(import.meta.dirname, '../e2e/support/missionReloadObservation.ts'),
      'utf8'
    );
    expect(helper).toContain("await page.reload({ waitUntil: 'domcontentloaded' });");
    expect(helper).toContain('throw error;');
    expect(helper).not.toContain("waitUntil: 'commit'");
  });
});

describe('mission cleanup evidence placement', () => {
  it('finalizes actual cleanup and its evidence inside finally before an original journey failure can exit', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../e2e/production-daily-missions.spec.ts'),
      'utf8'
    );
    const finalizer = source.slice(source.lastIndexOf('} finally {'));
    expect(finalizer).toContain('await finalizeMissionCleanupWithEvidence(');
    expect(finalizer).toContain('daily-missions-cleanup.json');
    expect(finalizer).toContain('cleanupTemporaryCustomizationAccount(environment, account)');
    expect(source).toContain('journeyError = error;');
  });
});

describe('mission cleanup preserves actual failures', () => {
  it('records independently verified absence even when the original journey failed', async () => {
    const original = new Error('original abort');
    const cleanup = vi.fn(async () => {});
    const attach = vi.fn(async (_data: object) => {});
    await finalizeMissionCleanupWithEvidence('owned-fixture', original, cleanup, attach);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0]).toMatchObject({
      cleanupStatus: 'verified_absent',
      journeyFailed: true,
    });
  });
  it('retains BOTH original abort and cleanup refusal instead of skipping the cleanup assertion', async () => {
    const original = new Error('original abort');
    const refusal = new Error('cleanup refused');
    const attach = vi.fn(async (_data: object) => {});
    let result: unknown;
    try {
      await finalizeMissionCleanupWithEvidence(
        'owned-fixture',
        original,
        async () => {
          throw refusal;
        },
        attach
      );
    } catch (error) {
      result = error;
    }
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([original, refusal]);
    expect((result as AggregateError).cause).toBe(original);
    expect(attach.mock.calls[0][0]).toMatchObject({ cleanupStatus: 'refused' });
  });
  it('does not hide cleanup failure behind an unavailable artifact transport', async () => {
    const refusal = new Error('cleanup refused');
    await expect(
      finalizeMissionCleanupWithEvidence(
        'owned-fixture',
        undefined,
        async () => {
          throw refusal;
        },
        async () => {
          throw new Error('artifact unavailable');
        }
      )
    ).rejects.toBeInstanceOf(AggregateError);
  });
  it('bounds stalled evidence delivery without skipping actual cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => {});
    const done = finalizeMissionCleanupWithEvidence(
      null,
      undefined,
      cleanup,
      () => new Promise(() => {})
    );
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
