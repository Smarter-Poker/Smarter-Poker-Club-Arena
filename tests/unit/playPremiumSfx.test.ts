import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importWithRetry } from '../../src/utils/lazyWithRetry';

function host(load: () => unknown) {
  const source = readFileSync(path.resolve(__dirname, '../../src/utils/playPremiumSfx.ts'), 'utf8');
  // Expose the fire-and-forget chain's settlement to this observer. Its loader,
  // callback, retry utility and error boundary all execute as maintained.
  const observed = source.replace(/\bvoid (?=(?:import|importWithRetry)\()/, 'return ');
  const code = ts.transpileModule(observed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const reportError = vi.fn();
  const exports: { playPremiumSfx?: (cue: string) => Promise<void> } = {};
  runInContext(
    code,
    createContext({
      exports,
      require: (name: string) => {
        if (name === '../services/PremiumSFX') return load();
        if (name === './lazyWithRetry') return { importWithRetry };
        if (name === './errorReporter') return { reportError };
        throw new Error(`Unexpected import: ${name}`);
      },
    })
  );
  return { play: exports.playPremiumSfx!, reportError };
}

afterEach(() => vi.useRealTimers());

describe('an owed premium sound survives a failed module fetch', () => {
  it('retries the import and plays each requested cue exactly once', async () => {
    vi.useFakeTimers();
    const tapFlip = vi.fn();
    const navigate = vi.fn();
    const module = { default: { tapFlip, navigate } };
    const load = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new TypeError('Failed to fetch dynamically imported module');
      })
      .mockReturnValue(module);
    const { play, reportError } = host(load);
    const first = play('tapFlip');
    const second = play('navigate');
    // Attach observers before advancing the real retry utility's timers.
    const settled = Promise.allSettled([first, second]);
    await vi.runAllTimersAsync();
    expect(await settled).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
    expect(tapFlip).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(3);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports final fetch failure and lets a later interaction load again', async () => {
    vi.useFakeTimers();
    const failure = new TypeError('Failed to fetch dynamically imported module');
    const tapFlip = vi.fn();
    const load = vi.fn().mockImplementation(() => {
      throw failure;
    });
    const { play, reportError } = host(load);
    const settled = Promise.allSettled([play('tapFlip')]);
    await vi.runAllTimersAsync();
    expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(load).toHaveBeenCalledTimes(4);
    expect(reportError).toHaveBeenCalledWith(failure, 'PremiumSFX.load');
    expect(tapFlip).not.toHaveBeenCalled();
    load.mockReturnValue({ default: { tapFlip } });
    await play('tapFlip');
    expect(tapFlip).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('does not retry or duplicate a cue whose implementation throws', async () => {
    const failure = new Error('sound synthesis failed');
    const tapFlip = vi.fn(() => {
      throw failure;
    });
    const load = vi.fn(() => ({ default: { tapFlip } }));
    const { play, reportError } = host(load);
    await expect(play('tapFlip')).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    expect(tapFlip).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure, 'PremiumSFX.load');
  });

  it('leaves the sound setting and cue implementation in the synthesizer', async () => {
    let enabled = false;
    const audible = vi.fn();
    const tapFlip = vi.fn(() => {
      if (enabled) audible();
    });
    const load = vi.fn(() => ({ default: { tapFlip } }));
    const { play } = host(load);
    await play('tapFlip');
    expect(audible).not.toHaveBeenCalled();
    enabled = true;
    await play('tapFlip');
    expect(audible).toHaveBeenCalledOnce();
    expect(tapFlip).toHaveBeenCalledTimes(2);
  });
});
