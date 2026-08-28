/**
 * THE ENGINE OPENS THE RIT PANEL. THE CLIENT DOES NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ─── WHAT THIS FILE PINNED FIRST, AND WHY IT CHANGED ───────────────────────
 *
 * `ritOpponent` holds the name shown on the Run-It-Twice consent panel. It was
 * ALSO the only thing gating a second, client-side way into that panel:
 *
 *     handleInsuranceDeclineForHand:
 *       if (ritOpponent !== 'Opponent') setShowRIT(true);
 *
 * `'Opponent'` is its initial value and its sentinel — "RIT is not armed" — and
 * nothing ever put the sentinel back. `resetRitPanelState`'s own docstring says
 * it resets every piece of RIT state at the hand boundary; it reset fourteen of
 * them, including `ritDeadlineRef`, but missed this one. So the gate silently
 * changed meaning from "RIT was armed in THIS hand" to "RIT was armed at some
 * point this session", and after one `A`-key shove every later insurance
 * decline force-opened the panel.
 *
 * That was fixed by restoring the sentinel. This file then went further, with
 * Dan's go-ahead, and removed the client-side open ENTIRELY — so the gate this
 * file used to assert on no longer exists, and the assertion that pinned it is
 * replaced rather than deleted.
 *
 * ─── THE RULE NOW ─────────────────────────────────────────────────────────
 *
 * The engine is the sole authority on Run It Twice. `handleAllInRunout`
 * broadcasts `rit_offer` (server/src/engine — see RunItTwice.offerpath.test.ts,
 * "THE OFFER FIRES: a 2-way all-in on a RIT cash table emits rit_offer"), and
 * the `eventType === 'rit_offer'` handler in TablePage opens the panel with the
 * real chooser, deadline, maxRuns and playerCount.
 *
 * The client open had none of that: a countdown reading a `ritDeadlineRef` the
 * hand-boundary reset had just zeroed, stale chooser context, and Accept /
 * Decline / choose-runs buttons that POST `respondToRIT` for an offer that does
 * not exist.
 *
 * Source-level guard on purpose: the invariants are "no second door into this
 * panel" and "one shove path". A render test would need the whole 16k-line
 * TablePage plus a live engine socket to reach the same conclusion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

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

describe('only the engine opens the RIT panel', () => {
  it('has no client-side open gated on the ritOpponent display string', () => {
    expect(
      CODE,
      'the legacy client-side RIT open is back. It opens the panel with a dead ' +
        'countdown and stale chooser context, and its buttons POST respondToRIT ' +
        'for an offer the engine never made.'
    ).not.toMatch(/ritOpponent\s*!==\s*'Opponent'/);
  });

  it('still handles the engine rit_offer event — the ONLY way in', () => {
    // Sanity, and the reason the assertion above is safe: removing the client
    // door is only correct while the engine door exists. If this ever fails,
    // RIT has no way to open at all.
    expect(CODE, 'the rit_offer handler is gone — RIT can no longer open').toMatch(
      /eventType === 'rit_offer'/
    );
  });

  it('resets ritOpponent at the hand boundary, with the rest of the RIT state', () => {
    /* It is a display string again rather than a flag, but it is still per-hand
       state and it still belongs in the reset whose docstring claims all of it.
       Leaving it out is how it became a session-scoped value the first time. */
    const body = resetBody();
    expect(body, 'resetRitPanelState does not restore ritOpponent').toMatch(
      /setRitOpponent\(\s*'Opponent'\s*\)/
    );
    expect(body).toMatch(/ritDeadlineRef\.current\s*=\s*0/);
    expect(body).toMatch(/setRitChooserId\(null\)/);
  });
});

describe('there is one shove path', () => {
  it('routes the A key through the same function the ALL IN button runs', () => {
    expect(CODE).toMatch(/onAllIn:\s*\(\)\s*=>\s*void handleActionPanelAction\('allin'\)/);
  });

  it('has deleted the parallel handleAllIn implementation', () => {
    /* It skipped the VPIP/PFR counting the button path does, and it armed the
       legacy client RIT prompt the button never armed — so a shove meant
       different things depending on which control the player used. */
    expect(CODE, 'a second all-in implementation is back').not.toMatch(/const handleAllIn\s*=/);
  });

  it('keeps the guarantees that implementation carried, in the surviving path', () => {
    // Sanity that the delete removed drift and not behaviour: the panel path
    // must still take the lock, validate, mark all-in mode and revert on refusal.
    const at = CODE.indexOf('const handleActionPanelAction');
    expect(at).toBeGreaterThan(-1);
    const body = sliceStatement(CODE, 'const handleActionPanelAction');
    expect(body).toMatch(/validateAndExecuteAction\('allin'\)/);
    expect(body).toMatch(/setIsAllInMode\(true\)/);
    expect(body).toMatch(/applyOptimisticHeroAction\('allin'/);
  });
});
