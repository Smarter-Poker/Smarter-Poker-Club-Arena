import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunkReloadGuardKey,
  clearChunkRecoveryState,
  installVitePreloadErrorRecovery,
  isChunkLoadError,
} from '../src/utils/lazyWithRetry';

describe('stale deployment chunk recovery', () => {
  it('lets an optional Safari preload failure retry without replacing the active table document', async () => {
    vi.resetModules();
    const browser = new EventTarget();
    const replace = vi.fn();
    Object.assign(browser, {
      location: { href: 'https://example.test/table/observer', replace, reload: replace },
    });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    sessionStorage.clear();
    const recovery = await import('../src/utils/lazyWithRetry');
    const uninstall = recovery.installVitePreloadErrorRecovery();
    const module = { warmTable: vi.fn() };
    let attempts = 0;
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts > 1) return module;
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new TypeError('Importing a module script failed.');
      browser.dispatchEvent(event);
      // Vite resolves a cancelled event to undefined instead of rejecting.
      if (event.defaultPrevented) return undefined;
      throw event.payload;
    });
    await expect(recovery.importWithRetry(load, 2, 0)).resolves.toBe(module);
    expect(load).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(recovery.chunkReloadGuardKey())).toBeNull();
    uninstall();
  });

  it('recovers a critical lazy import only after its bounded preload retries', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('react', () => ({ lazy: (load: () => Promise<unknown>) => load }));
    const browser = new EventTarget();
    const replace = vi.fn();
    Object.assign(browser, {
      location: { href: 'https://example.test/table/observer', replace, reload: replace },
    });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    sessionStorage.clear();
    const recovery = await import('../src/utils/lazyWithRetry');
    const uninstall = recovery.installVitePreloadErrorRecovery();
    const importFn = vi.fn(async () => {
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new TypeError('Importing a module script failed.');
      browser.dispatchEvent(event);
      if (!event.defaultPrevented) throw event.payload;
      return undefined as never;
    });
    const load = recovery.lazyWithRetry(importFn) as unknown as () => Promise<unknown>;
    let state = 'pending';
    void load().then(
      () => (state = 'resolved'),
      () => (state = 'rejected')
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(importFn).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(importFn).toHaveBeenCalledTimes(3);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(state).toBe('pending');
    uninstall();
  });

  it.each([undefined, {}, { default: undefined }])(
    'rejects an invalid module outside recovery: %s',
    async (module) => {
      vi.resetModules();
      vi.doMock('react', () => ({ lazy: (load: () => Promise<unknown>) => load }));
      const recovery = await import('../src/utils/lazyWithRetry');
      const load = recovery.lazyWithRetry(
        async () => module as never
      ) as unknown as () => Promise<unknown>;
      await expect(load()).rejects.toThrow('Lazy route module has no default export');
    }
  );

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
      void recovery.recoverFromStaleChunk(event.payload);
      // Concurrent preload failures in this same document share one recovery.
      const concurrent = new Event('vite:preloadError', { cancelable: true }) as typeof event;
      concurrent.payload = event.payload;
      browser.dispatchEvent(concurrent);
      void recovery.recoverFromStaleChunk(concurrent.payload);
      await Promise.resolve();

      // One guarded hard reload per build: the second document of the same
      // build does not reload again, so a broken build cannot loop.
      expect(navigations).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(false);
      expect(concurrent.defaultPrevented).toBe(false);
      uninstall();
    }
    expect(sessionStorage.getItem(chunkReloadGuardKey())).toBe('1');
  });

  /* 2026-10-23, production post-deploy (Chromium and WebKit): navigating
     away cancelled the old page's chunk loads, recovery read the
     cancellations as a stale deploy, and its cache-busted reload of the page
     being LEFT hijacked the player's navigation back to the club. */
  describe('a page that is being navigated away from', () => {
    async function freshDocument(href = 'https://example.test/clubs/kings-club') {
      vi.resetModules();
      vi.doMock('react', () => ({ lazy: (load: () => Promise<unknown>) => load }));
      const browser = new EventTarget();
      const replace = vi.fn();
      Object.assign(browser, { location: { href, replace, reload: replace } });
      vi.stubGlobal('window', browser);
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('caches', undefined);
      sessionStorage.clear();
      const recovery = await import('../src/utils/lazyWithRetry');
      return { browser, replace, recovery };
    }
    const cancelledLoad = () => {
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new TypeError('Importing a module script failed.');
      return event;
    };
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not reload the page the player is leaving, and spends no reload budget', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(new Event('beforeunload'));
      const event = cancelledLoad();
      browser.dispatchEvent(event);
      void recovery.recoverFromStaleChunk(event.payload);
      await flush();
      expect(replace).not.toHaveBeenCalled();
      expect(recovery.documentIsNavigatingAway()).toBe(true);
      expect(sessionStorage.getItem(chunkReloadGuardKey())).toBeNull();
      uninstall();
    });

    it('still recovers a real stale chunk when no navigation is under way', async () => {
      const { browser, replace, recovery } = await freshDocument();
      const uninstall = recovery.installVitePreloadErrorRecovery();
      const event = cancelledLoad();
      browser.dispatchEvent(event);
      void recovery.recoverFromStaleChunk(event.payload);
      await flush();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(String(replace.mock.calls[0][0])).toContain('_cb=');
      uninstall();
    });

    it('recovers after the grace period when the navigation never completed', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(new Event('beforeunload'));
      const event = cancelledLoad();
      browser.dispatchEvent(event);
      void recovery.recoverFromStaleChunk(event.payload);
      browser.dispatchEvent(cancelledLoad());
      void recovery.recoverFromStaleChunk(event.payload);
      await flush();
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS + 1);
      await flush();
      // Still on this page, so the failure was real: one recovery, not two.
      expect(replace).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(chunkReloadGuardKey())).toBe('1');
      uninstall();
    });

    it('defers a direct hard reload requested during a navigation', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      browser.dispatchEvent(new Event('pagehide'));
      await recovery.hardReload();
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS + 1);
      await flush();
      expect(replace).toHaveBeenCalledTimes(1);
    });

    it('keeps a lazy route suspended instead of erroring while the page leaves', async () => {
      vi.useFakeTimers();
      const { browser, recovery } = await freshDocument();
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(new Event('beforeunload'));
      const load = recovery.lazyWithRetry(async () => {
        const event = cancelledLoad();
        browser.dispatchEvent(event);
        if (!event.defaultPrevented) throw event.payload;
        return undefined as never;
      }) as unknown as () => Promise<unknown>;
      let state = 'pending';
      void load().then(
        () => (state = 'resolved'),
        () => (state = 'rejected')
      );
      await flush();
      expect(state).toBe('pending');
      uninstall();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearChunkRecoveryState();
    sessionStorage.clear();
    vi.doUnmock('react');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    new TypeError('Failed to fetch dynamically imported module: /assets/old.js'),
    new TypeError('Importing a module script failed.'),
    new TypeError('error loading dynamically imported module: /assets/old.js'),
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
    sessionStorage.setItem(chunkReloadGuardKey(), '1');
    const uninstall = installVitePreloadErrorRecovery();
    const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new TypeError('Failed to fetch dynamically imported module: /assets/old.js');

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });

  it.each([true, false])(
    'keeps guarded CSS recovery when the failed link is present: %s',
    async (linkPresent) => {
      vi.resetModules();
      const browser = new EventTarget();
      const replace = vi.fn();
      Object.assign(browser, {
        location: { href: 'https://example.test/table/observer', replace, reload: replace },
      });
      vi.stubGlobal('window', browser);
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('caches', undefined);
      sessionStorage.clear();
      const recovery = await import('../src/utils/lazyWithRetry');
      const uninstall = recovery.installVitePreloadErrorRecovery();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('href', 'data:text/css,.recovery{}');
      if (linkPresent) document.head.appendChild(link);
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new Error('Unable to preload CSS for data:text/css,.recovery{}');
      browser.dispatchEvent(event);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(document.querySelector('link[href="data:text/css,.recovery{}"]')).toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(recovery.chunkReloadGuardKey())).toBe('1');
      uninstall();
    }
  );

  /* Dan 2026-10-14: the lobby drew with no CSS on an iPad. A failed
     stylesheet link stayed in the document, and Vite's preloader treats any
     present link as loaded, so every retry rendered the route unstyled. */
  it('drops a failed stylesheet and never cancels a CSS failure into an unstyled render', () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('href', 'data:text/css,.a{}');
    document.head.appendChild(link);
    const uninstall = installVitePreloadErrorRecovery();
    const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error('Unable to preload CSS for data:text/css,.a{}');
    // Keep recovery at its ceiling so the unit test never navigates.
    sessionStorage.setItem(chunkReloadGuardKey(), '1');
    window.dispatchEvent(event);
    expect(document.querySelector('link[href="data:text/css,.a{}"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });
});
