import { useEffect } from 'react';

/**
 * Extracts generic DOM/Environment side-effects from TablePage:
 * 1. Sets document title
 * 2. Locks mobile viewport (prevents pinch-zoom)
 * 3. Acquires Wake Lock (prevents screen dimming)
 * 4. Adds background tab detection for CSS pausing
 */
export function useTableEnvironment(tableId: string | undefined) {
  // ─── PAGE TITLE ───
  useEffect(() => {
    document.title = tableId ? `${tableId} | Smarter Poker` : 'Table | Smarter Poker';
  }, [tableId]);

  // ─── MOBILE VIEWPORT LOCK — Prevent accidental pinch-zoom during poker play ───
  useEffect(() => {
    let newMeta: HTMLMetaElement | null = null;
    const meta = document.querySelector('meta[name="viewport"]');
    const originalContent = meta?.getAttribute('content') || '';
    const pokerViewport =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

    if (meta) {
      meta.setAttribute('content', pokerViewport);
    } else {
      newMeta = document.createElement('meta');
      newMeta.name = 'viewport';
      newMeta.content = pokerViewport;
      document.head.appendChild(newMeta);
    }

    // Try to lock orientation to portrait (non-blocking, fails silently on unsupported browsers)
    try {
      (screen.orientation as any)?.lock?.('portrait').catch(() => {});
    } catch {
      // Orientation lock not supported — ignore
    }

    return () => {
      // Restore original viewport when leaving the table
      if (newMeta) {
        document.head.removeChild(newMeta);
      } else {
        const restoreMeta = document.querySelector('meta[name="viewport"]');
        if (restoreMeta) {
          restoreMeta.setAttribute(
            'content',
            originalContent || 'width=device-width, initial-scale=1'
          );
        }
      }
      try {
        screen.orientation?.unlock?.();
      } catch {
        // Ignore
      }
    };
  }, []);

  // ─── SCREEN WAKE LOCK — Prevent screen dimming during active poker play ───
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLock) await wakeLock.release().catch(() => {});
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Wake Lock not supported or denied — ignore
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      wakeLock?.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ─── BACKGROUND TAB DETECTION — Pause animations when tab is hidden ───
  useEffect(() => {
    const tablePage = document.querySelector('.table-page');
    if (!tablePage) return;

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        tablePage.classList.add('table-page--backgrounded');
      } else {
        tablePage.classList.remove('table-page--backgrounded');
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      tablePage.classList.remove('table-page--backgrounded');
    };
  }, []);
}
