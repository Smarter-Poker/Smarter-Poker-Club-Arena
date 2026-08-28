/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SIT OUT SWITCH REPORTS THE STATE, NOT ITS OWN HISTORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "IF YOU ARE SITTING OUT IT SHOULD BE TURNED ON IN THE
 * HAMBURGER MENU WHEN YOU GO TO IT. FIX THAT BUG."
 *
 * `sitOutNextHand` is a private `useState(false)` in TablePage, and the ONLY
 * thing that ever set it true was the settings switch itself. There are four
 * ways into a sit-out:
 *
 *   1. the hamburger's "Sit Out" quick action  -> handleSitOut
 *   2. masterBus TABLE_MENU_ACTION 'SIT_OUT'   -> handleSitOut
 *   3. this switch                             -> setSitOutNextHand
 *   4. the ENGINE, after three action timeouts -> no client involvement at all
 *
 * Three of the four never touched the flag, and nothing seeded it from the
 * server. So the ordinary path — tap Sit Out in the menu, then open Table
 * Settings — always showed the switch OFF while the player was visibly sitting
 * out, and turning it ON sent a second, redundant sit-out.
 *
 * The fix is to stop asking the flag and start asking the table:
 * `heroIsSittingOut` is derived from the hero seat's status in `tableState`,
 * which comes from the engine snapshot, so it covers case 4 as well.
 *
 * `sitOutNextHand` stays in the expression on purpose. It is the one thing the
 * server view cannot show yet: a sit-out requested DURING a hand is deferred to
 * settlement, so the switch must read ON from the moment it is asked for rather
 * than a hand later.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';

const TABLE_PAGE = readFileSync(join(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');
const PANEL = readFileSync(join(process.cwd(), 'src/components/table/SettingsPanel.tsx'), 'utf8');

describe('the Sit Out Next Hand switch', () => {
  it('is driven by the server view of the seat, not only by the local flag', () => {
    const code = blankNonCode(TABLE_PAGE);
    expect(
      code,
      'the switch must OR in heroIsSittingOut, or it reads OFF while the player is sitting out'
    ).toMatch(/sitOutNextHand=\{sitOutNextHand \|\| heroIsSittingOut\}/);
    // And the bare form must be gone, or the bug is simply back.
    expect(code).not.toMatch(/sitOutNextHand=\{sitOutNextHand\}/);
  });

  it('heroIsSittingOut is derived from the hero seat status, so the engine path counts', () => {
    /* Case 4 above: a player force-sat-out after three action timeouts never
       touches any client control, so a client-only flag can never represent
       them. This derivation is what makes the switch honest for them too. */
    /* Raw source, not blanked: the value being compared is the string literal
       'sitting_out', and blankNonCode blanks string literals — so the assertion
       can only be written against the raw text. The anchor is specific enough
       that a comment cannot satisfy it by accident. */
    expect(TABLE_PAGE).toMatch(/const heroIsSittingOut =\s*\n?\s*tableState\.heroSeat > 0/);
    expect(TABLE_PAGE).toMatch(
      /tableState\.players\[tableState\.heroSeat - 1\]\?\.status === 'sitting_out'/
    );
  });

  it('the panel is fully controlled, so turning it off really sits the player back in', () => {
    /* SettingsPanel keeps no internal copy of `settings` — `handleToggle` sends
       `!settings[key]` straight back out. That is what makes the OR above safe:
       when the switch shows ON because the player is sitting out, tapping it
       emits `false`, and TablePage's handler calls setSitOut(tableId, false).
       If the panel ever grew its own state seeded once from props, this would
       silently stop working. */
    const code = blankNonCode(PANEL);
    expect(code).toMatch(/onSettingsChange\(\{ \[key\]: !settings\[key\] \}\)/);
    expect(code).not.toMatch(/useState.*TableSettings/);
    expect(code).toMatch(/checked=\{settings\.sitOutNextHand\}/);
  });

  it('the handler still round-trips the change to the engine', () => {
    const code = blankNonCode(TABLE_PAGE);
    expect(code).toMatch(/settingsUpdate\.sitOutNextHand !== undefined/);
    expect(code).toMatch(/setSitOut\(tableId, wanted\)/);
    // A refusal must revert the switch rather than leave it lying.
    expect(code).toMatch(/setSitOutNextHand\(!wanted\)/);
  });
});
