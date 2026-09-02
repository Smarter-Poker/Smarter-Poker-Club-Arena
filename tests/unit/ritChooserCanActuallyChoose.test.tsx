import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { RunItTwicePrompt } from '../../src/components/table/RunItTwice';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CHOOSER CAN ACTUALLY CHOOSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-28, from a live all-in on a phone (screenshot attached to the
 * report): "the 'run it twice' pop up is blocked and you can't click run it
 * once, twice or 3 times. It's cut off ... Also this card says 'kingfish offers
 * to run it twice'. I didn't offer anything yet, but that's the pop up on
 * screen."
 *
 * Both sentences are ONE line of TablePage:
 *
 *     const [ritChosenRuns, setRitChosenRuns] = useState<2 | 3>(2);
 *
 * `RunItTwicePrompt` picks its face with `isChooser && !chosenRuns` — "I am the
 * chooser and nothing has been chosen yet". A `2` that really means "no answer
 * yet" makes that false on the FIRST render, so the panel skipped the chooser's
 * own question entirely and fell through to `isChooser && !!chosenRuns`, the
 * WAITING state. The three buttons were unreachable code from the day they were
 * written — nothing was cut off, there was nothing there to cut off.
 *
 * The same phantom answer produced the sentence Dan quoted: the message read
 * `${opponentName} Requests To Run It Twice`, and `ritOpponent` is set to the
 * CHOOSER's display name, so the hero was told by name that he had asked for
 * something he had not been offered the chance to ask for.
 *
 * THREE PINS, because there are three ways this comes back:
 *
 *   1. BEHAVIOUR — a chooser with no answer yet is shown all three buttons.
 *   2. THE STATE — TablePage may not initialise or reset `ritChosenRuns` to a
 *      number, and both paths that begin a RIT question must clear it. A stale
 *      2 or 3 surviving a hand boundary puts the NEXT chooser straight back
 *      into the waiting state.
 *   3. THE WIRING — TableModalsLayer must forward the consent sheet's content.
 *      Six props were declared on the component and never passed, so the board
 *      row drew five face-down slots over a live flop and the per-player rows
 *      never rendered at all.
 *
 * Deliberately NOT tested here: any live money path, and no engine call (see
 * CLAUDE.md 11.5). This is the client's rendering of an offer.
 */

const src = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

const noop = () => {};
const noopAsync = async () => {};

const baseProps = {
  isOpen: true,
  onAccept: noop,
  onDecline: noop,
  onChooserDecide: noopAsync,
  timeRemaining: 19,
  opponentName: 'Kingfish',
};

describe('run it twice — the chooser can actually choose', () => {
  it('shows Run Once / Run It Twice / Run It 3 Times to a chooser who has not answered', () => {
    render(<RunItTwicePrompt {...baseProps} isChooser chosenRuns={undefined} maxRuns={3} />);

    expect(screen.getByRole('button', { name: /run once/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /run it twice/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /run it 3 times/i })).toBeTruthy();

    // And it must NOT have skipped ahead to the waiting state.
    expect(screen.queryByText(/waiting for other players/i)).toBeNull();
  });

  it('offers two runs only when the table allows two', () => {
    render(<RunItTwicePrompt {...baseProps} isChooser chosenRuns={undefined} maxRuns={2} />);

    expect(screen.getByRole('button', { name: /run once/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /run it twice/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /run it 3 times/i })).toBeNull();
  });

  it('never tells the hero, by name, what the hero requested', () => {
    /* The exact sentence Dan photographed. A chooser who HAS answered is
       addressed in the second person; only a responder is told whose request
       this is. */
    render(<RunItTwicePrompt {...baseProps} isChooser chosenRuns={2} />);
    expect(screen.queryByText(/Kingfish Requests To Run It/i)).toBeNull();
    expect(screen.getByText(/You Asked To Run It Twice/i)).toBeTruthy();

    // A responder still gets the name — that is who they are waiting on.
    render(<RunItTwicePrompt {...baseProps} isChooser={false} chosenRuns={2} />);
    expect(screen.getByText(/Kingfish Requests To Run It Twice/i)).toBeTruthy();
  });

  it('gives a responder something to press', () => {
    render(<RunItTwicePrompt {...baseProps} isChooser={false} chosenRuns={2} />);
    expect(screen.getByRole('button', { name: /decline/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /accept/i })).toBeTruthy();
  });

  it('holds "no answer yet" as undefined, and clears it wherever a question begins', () => {
    const tablePage = src('pages/TablePage.tsx');

    const decl = tablePage.match(/useState<([^>]*)>\((\w+)\);\s*$/m);
    expect(decl, 'could not find any useState declaration to reason about').toBeTruthy();

    const ritDecl = tablePage.match(
      /const \[ritChosenRuns, setRitChosenRuns\] = useState<([^>]+)>\(([^)]*)\)/
    );
    expect(ritDecl, 'ritChosenRuns is gone or was renamed').toBeTruthy();

    expect(
      ritDecl![1].replace(/\s/g, ''),
      'ritChosenRuns must be able to hold "not answered yet". Typing it `2 | 3` is ' +
        "what made the chooser's own question unreachable."
    ).toBe('2|3|undefined');

    expect(
      ritDecl![2].trim(),
      'ritChosenRuns must START as undefined. A number here is a phantom answer ' +
        'the player never gave.'
    ).toBe('undefined');

    // Both places that begin a RIT question must clear it. `resetRitPanelState`
    // is the hand boundary; the `rit_offer` handler is the new offer.
    const reset = tablePage.match(/const resetRitPanelState = useCallback\([\s\S]*?\n {2}\}, \[/);
    expect(reset, 'resetRitPanelState is gone or was renamed').toBeTruthy();
    expect(
      /setRitChosenRuns\(undefined\)/.test(reset![0]),
      'resetRitPanelState must clear ritChosenRuns — a stale 2 or 3 surviving the ' +
        "hand boundary opens the next chooser's panel with no buttons on it"
    ).toBe(true);

    const offer = tablePage.match(/if \(eventType === 'rit_offer'\) \{[\s\S]*?\n {6}\}/);
    expect(offer, 'the rit_offer handler is gone or was reshaped').toBeTruthy();
    expect(
      /setRitChosenRuns\(undefined\)/.test(offer![0]),
      'the rit_offer handler resets every other panel field; it must reset this one too'
    ).toBe(true);
  });

  it('forwards the consent sheet its own content', () => {
    const layer = src('components/table/TableModalsLayer.tsx');
    const el = layer.match(/<RunItTwicePrompt[\s\S]*?\/>/);
    expect(el, 'TableModalsLayer no longer renders RunItTwicePrompt').toBeTruthy();

    /* Every one of these was declared on RunItTwicePrompt and silently dropped
       here until 2026-08-28, so each fell to its default: an empty board (five
       face-down slots over a live flop), no pot, no consent rows, a countdown
       measured against the wrong denominator, and a hero whose own accept never
       changed what the panel said. */
    for (const prop of [
      'boardCards',
      'players',
      'potAmount',
      'totalSeconds',
      'heroAccepted',
      'currency',
    ]) {
      expect(
        new RegExp(`\\b${prop}=`).test(el![0]),
        `RunItTwicePrompt is rendered without ${prop} — the panel falls back to its ` +
          'default and shows the player something that is not the hand they are in'
      ).toBe(true);
    }
  });
});

describe('run it twice — the panel is reachable on a phone', () => {
  /* Comments stripped: these rules carry long notes that quote the very
     numbers being asserted ("at the old flat min-width: 108px..."), and a
     regex reading declarations must not read the prose about them. */
  const css = readFileSync(
    resolve(__dirname, '../../src/components/table/RunItTwice.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('measures its height against the DYNAMIC viewport', () => {
    /* iOS resolves `vh` against the viewport with the URL bar RETRACTED, so a
       panel capped in `vh` can extend under a visible URL bar — taking the
       actions row, which is the bottom-most thing in it, off screen. */
    expect(
      /max-height:\s*\d+dvh/.test(css),
      '.rit-panel must cap its height in dvh; vh alone hides the buttons behind ' +
        "iOS Safari's URL bar"
    ).toBe(true);
  });

  it('stays scrollable at BOTH ends when it is taller than the screen', () => {
    const overlay = css.match(/\.rit-overlay\s*\{[\s\S]*?\}/)![0];
    const panel = css.match(/\.rit-panel\s*\{[\s\S]*?\}/)![0];

    expect(
      /overflow-y:\s*auto/.test(overlay),
      'the overlay must scroll, or an oversized panel is clipped by the viewport'
    ).toBe(true);
    expect(
      /margin:\s*auto/.test(panel),
      'a centered flex item taller than its container overflows the TOP too, and ' +
        'that overflow cannot be scrolled back to. `margin: auto` centers while it ' +
        'fits and top-aligns when it does not.'
    ).toBe(true);
  });

  it('keeps the decision on screen while the countdown runs', () => {
    const actions = css.match(/\.rit-panel__actions\s*\{[\s\S]*?\}/)![0];
    expect(
      /position:\s*sticky/.test(actions),
      'the panel scrolls internally once the consent rows make it tall; the buttons ' +
        'must not be able to scroll out from under a 25-second engine deadline'
    ).toBe(true);
  });

  it('fits three buttons on one row of a 375px phone', () => {
    const btn = css.match(/\.rit-panel__btn\s*\{[\s\S]*?\}/)![0];
    const minW = Number(btn.match(/min-width:\s*(\d+)px/)![1]);

    /* A 340px panel has 312px inside its 14px padding, and the chooser's row is
       three buttons with two 10px gaps. */
    expect(
      3 * minW + 2 * 10,
      `three buttons at min-width ${minW}px need ${3 * minW + 20}px against 312px of ` +
        'panel; the third wraps to its own line and pushes the row off the bottom'
    ).toBeLessThanOrEqual(312);

    expect(
      /flex:\s*1 1 0/.test(btn),
      'the buttons must share the row rather than each claiming a label width'
    ).toBe(true);

    expect(
      Number(btn.match(/min-height:\s*(\d+)px/)![1]),
      'a time-critical control needs a real touch target'
    ).toBeGreaterThanOrEqual(44);
  });
});
