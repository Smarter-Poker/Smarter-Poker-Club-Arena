import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearChunkRecoveryState,
  installVitePreloadErrorRecovery,
  isChunkLoadError,
} from '../src/utils/lazyWithRetry';

describe('stale deployment chunk recovery', () => {
  it('does not rearm document reloads when another lazy module succeeds', async () => {
    const navigations = vi.fn();
    // Keep the browser's durable tab storage across fresh module/document
    // instances; the transport itself stays local and never navigates.
    const browser = new EventTarget();
    Object.assign(browser, {
      location: {
        href: 'https://example.test/notifications',
        replace: navigations,
        reload: navigations,
      },
    });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    // Exercise each real import factory without React's rendering scheduler.
    vi.doMock('react', () => ({ lazy: (load: () => Promise<unknown>) => load }));
    sessionStorage.clear();

    for (let documentIndex = 0; documentIndex < 4; documentIndex += 1) {
      vi.resetModules();
      const recovery = await import('../src/utils/lazyWithRetry');
      const loadNeighbor = recovery.lazyWithRetry(async () => ({ default: () => null }));
      await (loadNeighbor as unknown as () => Promise<unknown>)();
      const uninstall = recovery.installVitePreloadErrorRecovery();
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new TypeError(
        'Failed to fetch dynamically imported module: /assets/route.js'
      );
      browser.dispatchEvent(event);
      // Concurrent preload failures in this same document share one recovery.
      const concurrent = new Event('vite:preloadError', { cancelable: true }) as typeof event;
      concurrent.payload = event.payload;
      browser.dispatchEvent(concurrent);
      await Promise.resolve();

      expect(navigations).toHaveBeenCalledTimes(Math.min(documentIndex + 1, 2));
      expect(event.defaultPrevented).toBe(documentIndex < 2);
      expect(concurrent.defaultPrevented).toBe(documentIndex < 2);
      uninstall();
    }
    expect(sessionStorage.getItem('club_arena_chunk_reload')).toBe('2');
  });

  afterEach(() => {
    clearChunkRecoveryState();
    sessionStorage.clear();
    vi.doUnmock('react');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    new TypeError('Failed to fetch dynamically imported module: /assets/old.js'),
    new Error('Importing a module script failed.'),
    new Error('Unable to preload CSS for /assets/old.css'),
    Object.assign(new Error('chunk failed'), { name: 'ChunkLoadError' }),
  ])('recognizes every browser form of a retired asset', (error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('does not take ownership of an unrelated application error', () => {
    expect(isChunkLoadError(new Error('wallet reconciliation failed'))).toBe(false);
  });

  it('leaves an exhausted preload failure visible to the importing route', () => {
    // Keep recovery at its bounded ceiling so this unit test never navigates.
    sessionStorage.setItem('club_arena_chunk_reload', '2');
    const uninstall = installVitePreloadErrorRecovery();
    const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new TypeError('Failed to fetch dynamically imported module: /assets/old.js');

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });
});
