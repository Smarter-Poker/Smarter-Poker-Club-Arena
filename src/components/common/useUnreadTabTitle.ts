import { useEffect } from 'react';

const PREFIX = /^\(\d+\+?\)\s+/;

/** Pure: the tab title for a base title and an unread count. */
export function titleWithUnread(title: string, count: number): string {
  const base = title.replace(PREFIX, '');
  if (!Number.isFinite(count) || count <= 0) return base;
  return `(${count > 99 ? '99+' : Math.floor(count)}) ${base}`;
}

/**
 * Keeps "(N) " at the front of the browser tab title while messages are
 * unread, and removes it at zero. Pages set their own titles as the player
 * moves around, so a title change is re-prefixed rather than overwritten.
 */
export function useUnreadTabTitle(count: number): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = () => {
      const next = titleWithUnread(document.title, count);
      if (next !== document.title) document.title = next;
    };
    apply();
    const titleEl = document.querySelector('title');
    let observer: MutationObserver | null = null;
    if (titleEl && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(apply);
      observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      // Leave the title clean if this unmounts (sign-out, teardown).
      const clean = titleWithUnread(document.title, 0);
      if (clean !== document.title) document.title = clean;
    };
  }, [count]);
}
