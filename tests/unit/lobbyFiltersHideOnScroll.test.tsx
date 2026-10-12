/**
 * THE FILTERS GET OUT OF THE WAY WHILE YOU READ (Dan, 2026-10-11).
 *
 * "GAME Filters INSIDE OF THE CLUB need to work like the footer but in reverse.
 * When they hit the top of the page when scrolling down they should 'disappear'
 * but when you scroll back up, they should re appear."
 *
 * jsdom has no layout, so the page's scroll range and the deck's rectangle are
 * stubbed, exactly as the footer's own test does. What is under test is the
 * state machine: the footer's direction rule, gated on the deck being pinned,
 * and held while the filters are in use.
 */
import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClubLobbyCommandTop } from '../../src/components/lobby/ClubLobbyCommandTop';
import { translateYOf } from '../../src/components/lobby/useHideLobbyFiltersOnScroll';

const HEADER = 64;
const DECK_HOME = 400; // where the deck sits in the page before anything scrolls
const BAR_HOME = 760; // the sort row's own place, below the campaign and the ad bay
const DECK_H = 250;

const frames: FrameRequestCallback[] = [];

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 393,
    width: 393,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Where a sticky element lands for a given scroll, the way a browser places it. */
function stuck(home: number, offset: number) {
  return () => Math.max(home - window.scrollY, offset);
}

function Lobby({ hold = false, menuOpen = false }: { hold?: boolean; menuOpen?: boolean }) {
  return (
    <section className="club-lobby-machine">
      <ClubLobbyCommandTop
        holdFilters={hold}
        resetKey="club-1"
        welcome={null}
        controls={<button type="button">All</button>}
        campaign={null}
      />
      <div className="club-home__games club-home__games--v2">
        <div className="lobby-sortbar" style={{ position: 'sticky', top: `${HEADER + DECK_H}px` }}>
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen}>
            Stakes
          </button>
        </div>
      </div>
    </section>
  );
}

function mount(props: { hold?: boolean; menuOpen?: boolean } = {}) {
  const view = render(<Lobby {...props} />);
  const section = screen.getByLabelText('Club Lobby Controls And Promotion');
  const deck = section.querySelector<HTMLElement>('.club-lobby-command-top__controls')!;
  const bar = view.container.querySelector<HTMLElement>('.lobby-sortbar')!;
  deck.style.position = 'sticky';
  deck.style.top = `${HEADER}px`;
  const deckTop = stuck(DECK_HOME, HEADER);
  const barTop = stuck(BAR_HOME, HEADER + DECK_H);
  deck.getBoundingClientRect = () => rect(deckTop(), DECK_H);
  bar.getBoundingClientRect = () => rect(barTop(), 48);
  bar.getClientRects = () => [rect(barTop(), 48)] as unknown as DOMRectList;
  return { ...view, section };
}

async function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  document.documentElement.scrollTop = y;
  await act(async () => {
    document.dispatchEvent(new Event('scroll'));
    // Both hooks coalesce onto the next animation frame; run every one queued.
    while (frames.length) frames.splice(0).forEach((callback) => callback(0));
  });
}

const hidden = (section: HTMLElement) => section.getAttribute('data-filters-hidden');

describe('the lobby filters step aside like the footer, in reverse', () => {
  beforeEach(() => {
    frames.length = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    Object.defineProperty(window, 'innerHeight', { value: 852, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 8000,
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays in its place while it is still travelling up the page with everything else', async () => {
    const { section } = mount();
    expect(hidden(section)).toBe('false');

    // Travelling down, but the deck has not reached the header yet.
    await scrollTo(100);
    await scrollTo(300);
    expect(hidden(section)).toBe('false');
  });

  it('leaves once both the deck and the sort row are pinned, and returns on the way up', async () => {
    const { section } = mount();

    await scrollTo(200);
    await scrollTo(400); // the deck pins at 336, the sort row not until 446
    expect(hidden(section)).toBe('false');

    await scrollTo(900); // both pinned, still travelling down
    expect(hidden(section)).toBe('true');
    await scrollTo(1600);
    expect(hidden(section)).toBe('true');

    // The footer's own threshold: a little bounce does not bring it back...
    await scrollTo(1590);
    expect(hidden(section)).toBe('true');
    // ...a reader travelling back up does, still pinned under the header.
    await scrollTo(1550);
    expect(hidden(section)).toBe('false');

    await scrollTo(0);
    expect(hidden(section)).toBe('false');
  });

  it('never leaves while the Filters sheet is open', async () => {
    const { section } = mount({ hold: true });
    await scrollTo(400);
    await scrollTo(1400);
    expect(hidden(section)).toBe('false');
  });

  it('never leaves while a Stakes or Variant menu is open on the sort row', async () => {
    const { section } = mount({ menuOpen: true });
    await scrollTo(400);
    await scrollTo(1400);
    expect(hidden(section)).toBe('false');
  });

  it('comes back when keyboard focus reaches it', async () => {
    const { section } = mount();
    await scrollTo(400);
    await scrollTo(1400);
    expect(hidden(section)).toBe('true');

    await act(async () => {
      screen.getByRole('button', { name: 'All' }).focus();
    });
    expect(hidden(section)).toBe('false');
  });

  it('reads the transform it is undoing, mid-flight or at rest', () => {
    expect(translateYOf('none')).toBe(0);
    expect(translateYOf(undefined)).toBe(0);
    expect(translateYOf('matrix(1, 0, 0, 1, 0, -250)')).toBe(-250);
    expect(translateYOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -120, 0, 1)')).toBe(-120);
  });
});

describe('the motion is the footer’s: transform only, and instant', () => {
  const CSS = readFileSync(
    resolve(__dirname, '../../src/components/lobby/ClubLobbyCommandTop.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('lifts the deck and the row by their own heights, and nothing else', () => {
    const deck = CSS.match(
      /\[data-filters-hidden='true'\]\s*>\s*\.club-lobby-command-top__controls\s*\{([^}]*)\}/
    )?.[1];
    const bar = CSS.match(/\[data-filters-hidden='true'\][^{]*\.lobby-sortbar\s*\{([^}]*)\}/)?.[1];
    expect(deck).toContain('transform: translateY(-100%)');
    expect(bar).toMatch(/transform:\s*translateY\(calc\(-100% - var\(--ca-lobby-controls-h/);
    for (const body of [deck!, bar!]) {
      // No position, top, height or display change: the slot stays, so no card moves.
      expect(body).not.toMatch(/\b(position|top|height|display|transition)\s*:/);
    }
  });
});
