import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { titleWithUnread, useUnreadTabTitle } from '@/components/common/useUnreadTabTitle';

describe('unread messages in the browser tab title', () => {
  it('prefixes the count and strips it at zero', () => {
    expect(titleWithUnread('Club Arena', 3)).toBe('(3) Club Arena');
    expect(titleWithUnread('(3) Club Arena', 5)).toBe('(5) Club Arena');
    expect(titleWithUnread('(5) Club Arena', 0)).toBe('Club Arena');
    expect(titleWithUnread('Club Arena', 250)).toBe('(99+) Club Arena');
    expect(titleWithUnread('(99+) Club Arena', 0)).toBe('Club Arena');
  });

  it('keeps the prefix as the count changes and cleans up on unmount', () => {
    document.title = 'Lobby';
    const { rerender, unmount } = renderHook(({ count }) => useUnreadTabTitle(count), {
      initialProps: { count: 2 },
    });
    expect(document.title).toBe('(2) Lobby');
    rerender({ count: 0 });
    expect(document.title).toBe('Lobby');
    rerender({ count: 7 });
    expect(document.title).toBe('(7) Lobby');
    unmount();
    expect(document.title).toBe('Lobby');
  });
});
