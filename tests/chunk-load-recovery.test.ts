import { afterEach, describe, expect, it } from 'vitest';

import {
  clearChunkRecoveryState,
  installVitePreloadErrorRecovery,
  isChunkLoadError,
} from '../src/utils/lazyWithRetry';

describe('stale deployment chunk recovery', () => {
  afterEach(() => {
    clearChunkRecoveryState();
    sessionStorage.clear();
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

  it('prevents Vite from surfacing a handled preload failure as uncaught', () => {
    // Keep recovery at its bounded ceiling so this unit test never navigates.
    sessionStorage.setItem('club_arena_chunk_reload', '2');
    const uninstall = installVitePreloadErrorRecovery();
    const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new TypeError('Failed to fetch dynamically imported module: /assets/old.js');

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    uninstall();
  });
});
