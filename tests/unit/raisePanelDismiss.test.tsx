/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TAP ABOVE THE SIZING PANEL PUTS THE THREE HOT KEYS BACK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-29, with a screenshot of the open panel standing over his own
 * hole cards: "you should be able to click the back button or anywhere on the
 * top of the screen to close the action bar and go back to the 3 hot keys."
 *
 * Before this, the ways out were the Back button at the top of the overlay and
 * the Raise button behind it. Both are small, both are at the BOTTOM of the
 * screen, and neither is where a thumb goes when the reflex is "get this out
 * of my way" — so a player who tapped the felt got nothing.
 *
 * These beats pin the behaviour by rendering the real component and dispatching
 * real events, not by matching source text. Three of them are about damage the
 * naive version of this fix would do:
 *
 *   - a tap INSIDE the panel must not close it (the slider, the presets and the
 *     amount field are all taps);
 *   - the dismissing tap must NOT also reach the felt underneath. Dismissing
 *     over an open seat would otherwise try to seat the player, which is the
 *     class of surprise that costs money;
 *   - the listener must be scoped to THIS table's root. Tile view paints four
 *     tables at once, and the same mistake on `document.body` is what
 *     ActionPanel's `ca-raising` flag had to be moved off in the first place.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ActionPanel from '../../src/components/table/ActionPanel';

/** 1/2 no-limit, hero facing an open to 10 with 200 behind. */
const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  currentBet: 10,
  callAmount: 10,
  minRaise: 12,
  maxRaise: 200,
  pot: 30,
  bigBlind: 2,
  isMyTurn: true,
};

function atWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

const openPanel = () => {
  const opener =
    screen.queryByLabelText('Open Bet Panel') ?? screen.getByLabelText('Open Raise Panel');
  fireEvent.click(opener);
};

/** The panel is open exactly when its own modifier class is on the panel. */
const isOpen = (container: HTMLElement) => !!container.querySelector('.action-panel--raise');

/** Render inside a `.table-page`, which is the root the component scopes to. */
function renderInTable() {
  const host = document.createElement('div');
  host.className = 'table-page';
  document.body.appendChild(host);
  const utils = render(<ActionPanel {...base} onAction={vi.fn()} />, { container: host });
  /* The felt is appended AFTER render, not before: React owns the container it
     is given and clears whatever was in it, so a felt added first is detached
     by the time the first beat taps it — and every beat then "passes" against
     a node that is not on the page. Found by instrumenting the harness when
     Escape closed the panel and a tap did not. */
  const felt = document.createElement('div');
  felt.className = 'table-scaler';
  host.appendChild(felt);
  return { ...utils, host, felt };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('.table-page').forEach((n) => n.remove());
  document.body.classList.remove('ca-raising');
  atWidth(1024);
});

describe('the sizing panel closes when the player taps above it', () => {
  it('a tap on the felt closes the panel and returns the three hot keys', () => {
    atWidth(375);
    const { container, felt } = renderInTable();
    openPanel();
    expect(isOpen(container), 'the panel did not open, so this beat proves nothing').toBe(true);

    fireEvent.pointerDown(felt);
    expect(isOpen(container)).toBe(false);
    // And the ordinary row is back, which is what "the 3 hot keys" means.
    expect(container.querySelector('.action-panel--raise')).toBeNull();
  });

  it('the dismissing tap does NOT also reach the felt', () => {
    /* The whole reason this is a capture-phase listener that stops the event.
       A tap that closes the panel AND lands on an open seat would buy in. */
    atWidth(375);
    const { container, felt } = renderInTable();
    const feltTap = vi.fn();
    felt.addEventListener('pointerdown', feltTap);
    openPanel();

    fireEvent.pointerDown(felt);
    expect(isOpen(container)).toBe(false);
    expect(
      feltTap,
      'the felt received the tap that was meant to dismiss the panel'
    ).not.toHaveBeenCalled();
  });

  it('a tap INSIDE the panel leaves it open', () => {
    atWidth(375);
    const { container } = renderInTable();
    openPanel();

    const inside = container.querySelector('.action-panel--raise') as HTMLElement;
    fireEvent.pointerDown(inside);
    expect(isOpen(container), 'tapping the slider or a preset closed the panel').toBe(true);
  });

  it('Escape closes it too', () => {
    atWidth(1024);
    const { container } = renderInTable();
    openPanel();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen(container)).toBe(false);
  });

  it('a tap on ANOTHER table does not close this one', () => {
    /* Tile view paints four tables at once. A document-level listener would
       let a tap on table two dismiss table one's slider - the same defect the
       `ca-raising` flag had to be moved off `document.body` to fix. */
    atWidth(375);
    const other = document.createElement('div');
    other.className = 'table-page';
    document.body.appendChild(other);

    const { container } = renderInTable();
    openPanel();

    fireEvent.pointerDown(other);
    expect(isOpen(container), "a tap on a different table closed this table's panel").toBe(true);
  });
});
