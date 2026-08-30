/**
 * THE TABLE MUST SAY WHEN IT IS NOT CONNECTED.
 *
 * Dan, 2026-08-30, from a live tournament seat: "I had to hard refresh to get
 * the tournament seat, but its not displaying, there are no animations, no
 * chips in the boxes, everything is white... if its 'reconnecting' it should
 * say that as a pop up on the table."
 *
 * The connection status was never missing. `useEngineTableState` has always
 * exposed 'connecting' | 'reconnecting' | 'failed' | 'auth_failed', and
 * TablePage already passed it down -- to TableMenu, which renders
 * "Reconnecting…" inside the DRAWER HEADER. So the only way to find out why
 * the felt had gone blank was to open the hamburger menu, which is the one
 * thing nobody does at that moment.
 *
 * These pin the behaviour, not the pixels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import TableConnectionBanner, {
  GRACE_MS,
  MIN_VISIBLE_MS,
} from '../src/components/table/TableConnectionBanner';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const BANNER_CSS = read('src/components/table/TableConnectionBanner.css');
const TABLE_PAGE = read('src/pages/TablePage.tsx');

/** Advance past the grace delay inside act(), so React commits the state. */
async function passGrace(extra = 50) {
  await act(async () => {
    vi.advanceTimersByTime(GRACE_MS + extra);
  });
}

describe('the table says when it is not connected', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "Reconnecting" on the felt once the drop persists', async () => {
    render(<TableConnectionBanner status="reconnecting" />);
    // Nothing yet: a blip must not strobe the table mid-hand.
    expect(screen.queryByTestId('table-connection-banner')).toBeNull();

    await passGrace();

    const banner = screen.getByTestId('table-connection-banner');
    expect(banner.textContent).toContain('Reconnecting');
  });

  it('stays silent for a blip that recovers inside the grace window', async () => {
    const { rerender } = render(<TableConnectionBanner status="reconnecting" />);
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS - 300);
    });
    rerender(<TableConnectionBanner status="connected" />);
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS + MIN_VISIBLE_MS + 100);
    });
    expect(screen.queryByTestId('table-connection-banner')).toBeNull();
  });

  it('says nothing at all when connected, or when idle before a game starts', async () => {
    // 'idle' is a seat-first tournament table before the game begins. There is
    // no socket to hold yet, and telling somebody choosing a seat that they are
    // disconnected would simply be false.
    for (const status of ['connected', 'idle'] as const) {
      const { unmount } = render(<TableConnectionBanner status={status} />);
      await passGrace();
      expect(
        screen.queryByTestId('table-connection-banner'),
        `${status} must not raise a banner`
      ).toBeNull();
      unmount();
    }
  });

  it('names what happens next when the connection is lost', async () => {
    // "Disconnected" on its own invites a hard refresh -- which is exactly what
    // Dan reached for, and a refresh mid-hand is the worst available move.
    render(<TableConnectionBanner status="failed" />);
    await passGrace();
    expect(screen.getByTestId('table-connection-banner').textContent).toMatch(
      /Trying To Get You Back/
    );
  });

  it('obeys the popup law: Title Case, and no em dashes', async () => {
    for (const status of ['connecting', 'reconnecting', 'failed', 'auth_failed'] as const) {
      const { unmount } = render(<TableConnectionBanner status={status} />);
      await passGrace();
      const text = screen.getByTestId('table-connection-banner').textContent || '';
      expect(text, `${status} must carry no em dash`).not.toMatch(/[–—]/);
      for (const word of text.trim().split(/\s+/)) {
        const first = word[0];
        if (first && /[a-zA-Z]/.test(first)) {
          expect(first, `"${word}" in ${status} must start capitalised`).toBe(first.toUpperCase());
        }
      }
      unmount();
    }
  });

  it('is rendered on the felt, not only inside the menu drawer', () => {
    // The whole bug: the status existed and went somewhere nobody looks.
    expect(TABLE_PAGE).toMatch(/<TableConnectionBanner\s+status=\{engineWsStatus\}/);
    const container = TABLE_PAGE.indexOf('className="table-container"');
    const banner = TABLE_PAGE.indexOf('<TableConnectionBanner');
    expect(container).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(container);
  });

  it('cannot swallow a tap on the felt or an action button', () => {
    // It is painted over the table surface. If it ever caught pointer events it
    // would be a worse bug than the silence it replaces.
    expect(BANNER_CSS).toMatch(/pointer-events:\s*none/);
  });

  it('reduced motion drops the motion, never the message', () => {
    // Animation law: reduced motion collapses movement but never meaning. The
    // banner must still be there and still readable.
    const idx = BANNER_CSS.indexOf('prefers-reduced-motion');
    expect(idx).toBeGreaterThan(-1);
    const block = BANNER_CSS.slice(idx);
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility:\s*hidden/);
  });
});
