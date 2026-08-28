/**
 * A DISPLAY STRING WAS ALSO A CONTROL FLAG, AND IT NEVER RESET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ritOpponent` holds the name shown on the Run-It-Twice consent panel. It is
 * ALSO the only thing gating a client-side open of that panel:
 *
 *     handleInsuranceDeclineForHand:
 *       if (ritOpponent !== 'Opponent') setShowRIT(true);
 *
 * `'Opponent'` is its initial value and its sentinel — "RIT is not armed".
 *
 * `resetRitPanelState` is the hand-boundary reset. Its own docstring says it
 * resets every piece of RIT state, and it reset fourteen of them — including
 * `ritDeadlineRef`, which the panel's countdown reads — but not this one. So
 * the gate silently changed meaning from "RIT was armed in THIS hand" to "RIT
 * was armed at some point this session".
 *
 * `handleAllIn` (the A key) sets `ritOpponent` whenever a shove leaves two or
 * more players all in. After that, for the rest of the session, every insurance
 * decline force-opened the RIT panel with a 0-second countdown, stale chooser
 * context, and buttons that POST `respondToRIT` for an offer that does not
 * exist.
 *
 * This is a source-level guard rather than a render test on purpose: the bug is
 * a missing line in a reset function, and what has to stay true is that the
 * function resets the field it gates on. A render test would need the whole
 * 16k-line TablePage plus an engine socket to reach the same conclusion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE_TSX = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
/* Comments in this file quote its own bugs at length, so every scan runs on
   code with the comments stripped — a naive grep would match the description. */
const CODE = TABLE_TSX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The body of `resetRitPanelState`, from its declaration to its closing `}, []);`. */
function resetBody(): string {
  const at = CODE.indexOf('const resetRitPanelState');
  expect(at, 'resetRitPanelState no longer exists under that name').toBeGreaterThan(-1);
  const end = CODE.indexOf('}, []);', at);
  expect(end, 'could not find the end of resetRitPanelState').toBeGreaterThan(at);
  return CODE.slice(at, end);
}

describe('RIT arming cannot outlive the hand it belongs to', () => {
  it('still gates the client-side RIT open on the ritOpponent sentinel', () => {
    // Sanity: if this gate is ever removed or renamed, the rest of this file is
    // asserting about something that no longer exists — which would be a
    // vacuous pass. Fail loudly instead so the next reader re-derives it.
    expect(CODE, 'the ritOpponent gate changed — re-read this test before deleting it').toMatch(
      /ritOpponent\s*!==\s*'Opponent'/
    );
  });

  it('resets ritOpponent to its sentinel at the hand boundary', () => {
    const body = resetBody();
    expect(
      body,
      'resetRitPanelState does not restore the ritOpponent sentinel. The flag ' +
        'will survive the hand, and every later insurance decline will open a ' +
        'RIT panel with a dead timer and buttons that POST to a nonexistent offer.'
    ).toMatch(/setRitOpponent\(\s*'Opponent'\s*\)/);
  });

  it('resets it alongside the rest of the RIT state, not somewhere else', () => {
    /* The whole defect was one field escaping a reset whose contract already
       covered it. Pinning that it lives IN this function — next to
       `ritDeadlineRef.current = 0`, which the panel's countdown depends on —
       is what stops it drifting back out to a caller that forgets one path. */
    const body = resetBody();
    expect(body).toMatch(/ritDeadlineRef\.current\s*=\s*0/);
    expect(body).toMatch(/setRitChooserId\(null\)/);
  });
});
