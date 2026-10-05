/**
 * THE TABLE SAYS WHEN THE DEVICE IS OFFLINE (2026-10-05).
 *
 * With the browser offline the reconnect ladder waits on the 'online' event,
 * not on the table, and "Reconnecting To The Table" sent players to refresh a
 * page that could not load. The banner now names the cause. Text only: the
 * reconnect behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TableConnectionBanner, {
  AUTH_REFUSED_LABEL,
  GRACE_MS,
  OFFLINE_LABEL,
  labelFor,
} from '../src/components/table/TableConnectionBanner';

describe('labelFor names an offline device', () => {
  it('for the two states that blame the link', () => {
    expect(labelFor('reconnecting', false, null, true)).toBe(OFFLINE_LABEL);
    expect(labelFor('failed', false, null, true)).toBe(OFFLINE_LABEL);
  });

  it('and nowhere else: online words, sign-in and access verdicts are unchanged', () => {
    expect(labelFor('reconnecting', false, null, false)).toBe('Reconnecting To The Table');
    expect(labelFor('reconnecting')).toBe('Reconnecting To The Table');
    expect(labelFor('reconnecting', true, null, true)).toBe(AUTH_REFUSED_LABEL);
    expect(labelFor('connecting', false, null, true)).toBe('Connecting To The Table');
    expect(labelFor('connected', false, null, true)).toBeNull();
    expect(labelFor('idle', false, null, true)).toBeNull();
  });

  it('is Title Case with no em dash (CLAUDE.md 5.7)', () => {
    expect(OFFLINE_LABEL).not.toContain('—');
    for (const word of OFFLINE_LABEL.replace(/[.,]/g, '').split(' ')) {
      expect(word[0]).toBe(word[0].toUpperCase());
    }
  });
});

describe('the banner follows the browser', () => {
  let onLine: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    onLine = vi.spyOn(navigator, 'onLine', 'get');
  });
  afterEach(() => {
    onLine.mockRestore();
    vi.useRealTimers();
  });

  it('reads navigator.onLine and the offline/online events', async () => {
    onLine.mockReturnValue(false);
    render(<TableConnectionBanner status="reconnecting" />);
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS + 50);
    });
    expect(screen.getByTestId('table-connection-banner').textContent).toContain(
      'You Are Offline. Reconnecting When Your Connection Returns'
    );
    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('table-connection-banner').textContent).toContain(
      'Reconnecting To The Table'
    );
  });
});
