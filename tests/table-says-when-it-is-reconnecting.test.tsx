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

  /* ── AND IT MUST NOT SAY IT ABOUT A TABLE THAT IS RUNNING (2026-09-07) ────
     Dan: "ALL TABLES STILL SAY CONNECTING TO THE TABLE, INSTEAD OF BEING
     RUNNING AT ALL TIMES, AND PRE LOADED."
     The banner above is right about a felt that has gone stale. It was also
     firing on every ordinary entry, because the SOCKET reports 'connecting'
     on each fresh open while the warm-up roster has already painted a live
     hand. Those are two different facts and only one of them is the player's
     business. */
  it('says nothing about "connecting" when the felt is already showing a hand', async () => {
    render(<TableConnectionBanner status="connecting" hasLiveState />);
    await passGrace();
    expect(screen.queryByTestId('table-connection-banner')).toBeNull();
  });

  it('still says "connecting" on a cold table with nothing painted yet', async () => {
    render(<TableConnectionBanner status="connecting" hasLiveState={false} />);
    await passGrace();
    expect(screen.getByTestId('table-connection-banner').textContent).toContain('Connecting');
  });

  it('a RUNNING table that genuinely drops is still told about it', async () => {
    // The suppression is narrow on purpose: only 'connecting'. Here the pixels
    // really are stale, which is the whole reason this component exists.
    for (const status of ['reconnecting', 'failed'] as const) {
      const { unmount } = render(<TableConnectionBanner status={status} hasLiveState />);
      await passGrace();
      expect(screen.getByTestId('table-connection-banner')).toBeTruthy();
      unmount();
    }
  });

  it('TablePage feeds it the hand number, which only the engine can supply', () => {
    // A warm-up roster can paint seats and avatars; it cannot invent a dealt
    // hand. So this is the honest test for "the felt is showing real state".
    expect(TABLE_PAGE).toMatch(/hasLiveState=\{\(tableState\.handNumber \?\? 0\) > 0\}/);
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

  it('sits on the felt above the wordmark, not in the BBJ plate lane', () => {
    // Dan 2026-08-30, with a screenshot: "ANY 'RELOADING' OR 'DISCONNECTED'
    // NOTIFICATIONS SHOULD APPEAR ON THE TABLE ABOVE THE SMARTER.POKER BADGE
    // ON THE TABLE. (CURRENTLY IT APPEARS AS LAYER 2, BEHIND THE BBJ)".
    //
    // It shipped at `top: 12px` of .table-container. `.bbj-widget` is at
    // `top: 6px` of the same box, also centred, also a pill, and it paints
    // later - so the banner was a sliver of orange behind it. The fix is the
    // POSITION, not a bigger z-index in the same lane: a pixel offset from the
    // top of the container IS the bug.
    const ruleAt = BANNER_CSS.indexOf('.table-conn-banner {');
    expect(ruleAt).toBeGreaterThan(-1);
    const rule = BANNER_CSS.slice(ruleAt, BANNER_CSS.indexOf('}', ruleAt));
    expect(rule).not.toMatch(/\btop:\s*\d+px/);
    /* 2026-08-30 audit: the anchor is no longer a literal. `--sp-brand-top` is
       declared on `.table-surface` (58%) and MOVED by the `[data-boards]`
       rules to 72% / 84%, so a multi-board table carries its masthead lower
       and the banner has to come with it. A hard-coded 52% left the banner a
       third of the felt above the wordmark, in the middle of the board stack,
       on run-it-twice and bomb-pot tables. The literal is the bug now. */
    expect(rule).toMatch(/top:\s*calc\(var\(--sp-brand-top,\s*58%\)\s*-\s*6%\)/);
    expect(rule).not.toMatch(/top:\s*52%/);
    // Bottom-anchored, so it grows UP off the wordmark rather than over it.
    expect(BANNER_CSS).toMatch(/transform:\s*translate\(-50%,\s*-100%\)/);
    // And it is rendered inside the felt surface, above .table-brand - not as
    // a sibling pinned to the top of the table container.
    const surface = TABLE_PAGE.indexOf('className="table-surface"');
    const brand = TABLE_PAGE.indexOf('className="table-brand"');
    /* Matched whitespace-insensitively, like the sibling pin above (2026-09-05).
       The element gained a third prop in Realtime Phase 3 (`authRefused`), so
       Prettier wraps it across lines and a literal `'<TableConnectionBanner
       status='` finds nothing - which failed this pin while the placement it
       guards had not moved by a pixel. What is being asserted is WHERE the
       banner is mounted, not how it happens to be formatted. */
    const banner = TABLE_PAGE.search(/<TableConnectionBanner\s+status=/);
    expect(surface).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(surface);
    expect(banner).toBeLessThan(brand);
    // Exactly one. Two would race each other on the same felt.
    expect(TABLE_PAGE.match(/<TableConnectionBanner\s+status=/g)).toHaveLength(1);
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
