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
      // No production to ask here: an unreadable live build recovers as before.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Load failed');
        })
      );
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

    /* 2026-10-25, production post-deploy (WebKit): the lobby document took
       longer than the grace right after a publish, and the deferred recovery
       hijacked the still-loading navigation on a page that was already on
       the live build. */
    describe('when the grace ends with the page still here', () => {
      // The module's own build id in this suite (no VITE_APP_VERSION is set).
      const BUILD = 'dev';
      async function departedOnBuild(liveSha: string | Error) {
        vi.useFakeTimers();
        const fetchBuildInfo = vi.fn(async () => {
          if (liveSha instanceof Error) throw liveSha;
          return new Response(JSON.stringify({ ca_sha: liveSha }), { status: 200 });
        });
        const doc = await freshDocument();
        vi.stubGlobal('fetch', fetchBuildInfo);
        const uninstall = doc.recovery.installVitePreloadErrorRecovery();
        doc.browser.dispatchEvent(new Event('beforeunload'));
        const event = cancelledLoad();
        doc.browser.dispatchEvent(event);
        void doc.recovery.recoverFromStaleChunk(event.payload);
        await flush();
        return { ...doc, fetchBuildInfo, uninstall };
      }
      it('does not cancel a slow navigation from a page already on the live build', async () => {
        const { replace, recovery, fetchBuildInfo, uninstall } = await departedOnBuild(BUILD);
        await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS + 1);
        await flush();
        expect(fetchBuildInfo).toHaveBeenCalled();
        expect(String(fetchBuildInfo.mock.calls[0][0])).toMatch(/build-info\.json$/);
        expect(replace).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS * 3);
        await flush();
        expect(replace).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(chunkReloadGuardKey())).toBeNull();
        uninstall();
      });

      it('still restores a cancelled navigation once its bounded patience runs out', async () => {
        const { replace, recovery, uninstall } = await departedOnBuild(BUILD);
        await vi.advanceTimersByTimeAsync(
          recovery.CURRENT_BUILD_PATIENCE_MS + recovery.NAVIGATION_GRACE_MS + 1
        );
        await flush();
        expect(replace).toHaveBeenCalledTimes(1);
        expect(String(replace.mock.calls[0][0])).toContain('_cb=');
        uninstall();
      });

      it('recovers at the grace when production serves a newer build', async () => {
        const { replace, recovery, uninstall } = await departedOnBuild(
          'ne0000000000000000000000000000000000000002'
        );
        await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS + 1);
        await flush();
        expect(replace).toHaveBeenCalledTimes(1);
        uninstall();
      });

      it('recovers at the grace when the live build cannot be read', async () => {
        const { replace, recovery, uninstall } = await departedOnBuild(
          new TypeError('Load failed')
        );
        await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS + 1);
        await flush();
        expect(replace).toHaveBeenCalledTimes(1);
        uninstall();
      });
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
      // The origin answers a retired hashed stylesheet with 404.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Not Found', { status: 404 }))
      );
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new Error('Unable to preload CSS for data:text/css,.recovery{}');
      browser.dispatchEvent(event);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(document.querySelector('link[href="data:text/css,.recovery{}"]')).toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(recovery.chunkReloadGuardKey())).toBe('1');
      uninstall();
    }
  );

  /* 2026-10-25, production post-deploy run 40242809027: leaving the Kings
     Club lobby aborted its background route preloads, the aborted CSS reached
     recovery as "Unable to preload CSS", and with no beforeunload to mark the
     departure the page being left reloaded itself over the navigation. */
  describe('a cancelled stylesheet preload', () => {
    const HREF = 'https://example.test/hub/club-arena/assets/PlayerAvatar-D24RRM7w-v6.css';
    async function freshDocument() {
      vi.resetModules();
      const browser = new EventTarget();
      const replace = vi.fn();
      Object.assign(browser, {
        location: { href: 'https://example.test/clubs/kings-club', replace, reload: replace },
      });
      vi.stubGlobal('window', browser);
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('caches', undefined);
      sessionStorage.clear();
      document.head.querySelectorAll('link[rel="stylesheet"]').forEach((node) => node.remove());
      const recovery = await import('../src/utils/lazyWithRetry');
      return { browser, replace, recovery };
    }
    // A stylesheet the test document can really load once it is put back.
    const SERVED = 'data:text/css,.avatar{}';
    const cancelledCss = (href = HREF) => {
      const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
        payload?: unknown;
      };
      event.payload = new Error(`Unable to preload CSS for ${href}`);
      return event;
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('never reloads the page over a stylesheet the server still serves', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      const fetchMock = vi.fn(
        async () =>
          new Response('.avatar{}', {
            status: 200,
            headers: { 'content-type': 'text/css; charset=utf-8' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const uninstall = recovery.installVitePreloadErrorRecovery();
      // No beforeunload: a browser-initiated navigation does not always send one.
      browser.dispatchEvent(cancelledCss(SERVED));
      await settle();
      await vi.advanceTimersByTimeAsync(recovery.NAVIGATION_GRACE_MS * 2);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(SERVED);
      expect(replace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(chunkReloadGuardKey())).toBeNull();
      // Put back exactly once, so the route can never render unstyled.
      expect(document.querySelectorAll(`link[rel="stylesheet"][href="${SERVED}"]`)).toHaveLength(1);
      uninstall();
    });

    it('asks the server at the exact asset address it failed to load', async () => {
      const { recovery } = await freshDocument();
      const fetchMock = vi.fn(
        async () => new Response('.a{}', { status: 200, headers: { 'content-type': 'text/css' } })
      );
      vi.stubGlobal('fetch', fetchMock);
      expect(await recovery.probeStylesheet(HREF)).toBe('present');
      expect(String(fetchMock.mock.calls[0][0])).toBe(HREF);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    });

    it('recovers when the stylesheet put back still cannot load', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      // The server says it exists, but this document cannot load it.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response('.a{}', { status: 200, headers: { 'content-type': 'text/css' } })
        )
      );
      const uninstall = recovery.installVitePreloadErrorRecovery();
      const failing = 'data:text/css,.gone{}';
      browser.dispatchEvent(cancelledCss(failing));
      await settle();
      const restored = document.querySelector(`link[rel="stylesheet"][href="${failing}"]`);
      expect(restored).not.toBeNull();
      expect(replace).not.toHaveBeenCalled();
      restored!.dispatchEvent(new Event('error'));
      await settle();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(document.querySelector(`link[href="${failing}"]`)).toBeNull();
      uninstall();
    });

    it('still recovers a stylesheet the server has retired', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Not Found', { status: 404 }))
      );
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(cancelledCss());
      await settle();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(String(replace.mock.calls[0][0])).toContain('_cb=');
      expect(document.querySelector(`link[href="${HREF}"]`)).toBeNull();
      uninstall();
    });

    it('treats an HTML answer for the stylesheet as retired', async () => {
      vi.useFakeTimers();
      const { replace, recovery } = await freshDocument();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('<!doctype html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
        )
      );
      expect(await recovery.probeStylesheet(HREF)).toBe('gone');
      expect(replace).not.toHaveBeenCalled();
    });

    /* Run 40260290873 (build 2d8564c1d): the probes a leaving document made
       never reached the network, and the old 'unknown' answer reloaded the
       page ten seconds later, over the player's still-pending navigation. */
    it('never reloads while the server cannot be asked, however long that lasts', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(cancelledCss(SERVED));
      await settle();
      const total = recovery.UNANSWERED_STYLESHEET_REPROBE_MS.reduce((a, b) => a + b, 0);
      for (let t = 0; t <= total + 1_000; t += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
        expect(replace).not.toHaveBeenCalled();
      }
      // Asked once, then once per re-probe; then handed to the browser itself.
      expect(fetchMock).toHaveBeenCalledTimes(recovery.UNANSWERED_STYLESHEET_REPROBE_MS.length + 1);
      expect(document.querySelectorAll(`link[rel="stylesheet"][href="${SERVED}"]`)).toHaveLength(1);
      expect(sessionStorage.getItem(chunkReloadGuardKey())).toBeNull();
      uninstall();
    });

    it('acts on the first answer it does get: a served stylesheet is put back', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(
          new Response('.a{}', { status: 200, headers: { 'content-type': 'text/css' } })
        );
      vi.stubGlobal('fetch', fetchMock);
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(cancelledCss(SERVED));
      await settle();
      await vi.advanceTimersByTimeAsync(recovery.UNANSWERED_STYLESHEET_REPROBE_MS[0]);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(replace).not.toHaveBeenCalled();
      expect(document.querySelectorAll(`link[rel="stylesheet"][href="${SERVED}"]`)).toHaveLength(1);
      uninstall();
    });

    it('acts on the first answer it does get: a retired stylesheet still recovers', async () => {
      vi.useFakeTimers();
      const { browser, replace, recovery } = await freshDocument();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockResolvedValue(new Response('Not Found', { status: 404 }))
      );
      const uninstall = recovery.installVitePreloadErrorRecovery();
      browser.dispatchEvent(cancelledCss());
      await settle();
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(recovery.UNANSWERED_STYLESHEET_REPROBE_MS[0]);
      await settle();
      expect(replace).toHaveBeenCalledTimes(1);
      uninstall();
    });
  });

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
