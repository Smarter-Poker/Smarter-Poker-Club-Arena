/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIPS ARE THE DEFAULT. "RESET TO DEFAULTS" TURNED BIG BLINDS ON.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25 (binding): "tournaments and cash games should ALWAYS be
 * defaulted to actual totals unless the user changes the setting to BB. Enforce
 * that rule and functionality."
 *
 * THE INCIDENT (2026-08-26 audit). Every default in the codebase was already
 * correct — `DEFAULT_USER_TABLE_SETTINGS.show_stack_in_bb: false`,
 * `DEFAULT_TABLE_SETTINGS.showStackInBB: false`, and the seats, the pot and the
 * raise panel all read that one setting. The rule was defeated by the single
 * control whose whole job is restoring defaults:
 *
 *     if (settingsUpdate.showStackInBB !== undefined) toggleV8Setting('show_stack_in_bb');
 *
 * `SettingsPanel`'s per-row switch emits ONLY the key that changed
 * (`{ [key]: !settings[key] }`), so a blind toggle happened to behave. Its Reset
 * button emits the WHOLE `DEFAULT_TABLE_SETTINGS` object — in which
 * `showStackInBB` is present and `false`. `!== undefined` is true of `false`, so
 * Reset TOGGLED: a player sitting on the correct chips default who tapped "Reset
 * To Defaults" got big blinds switched ON across every seat, the pot and the
 * raise panel, and it was persisted to Supabase.
 *
 * Every sibling line in that handler passes the VALUE
 * (`updateSetting('showPotOdds', settingsUpdate.showPotOdds)`). This was the
 * only one that inverted instead — which is why nothing else in the panel had
 * the bug, and why no existing test noticed.
 *
 * WHAT THIS PINS
 *   1. the defaults themselves, in both shapes of the settings object;
 *   2. that no handler applies a supplied boolean by TOGGLING — the shape of
 *      the bug, banned generally so the next key added cannot repeat it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('chips are the default, in every settings object', () => {
  it('user_table_settings defaults to chips', async () => {
    const { DEFAULT_USER_TABLE_SETTINGS } = await import('../../src/hooks/useUserTableSettings');
    expect(DEFAULT_USER_TABLE_SETTINGS.show_stack_in_bb).toBe(false);
  });

  it('the panel-facing settings object defaults to chips', () => {
    // Read as source: importing SettingsPanel drags in the whole table CSS graph.
    const src = stripComments(read('src/components/table/SettingsPanel.tsx'));
    expect(src).toMatch(/showStackInBB:\s*false/);
  });

  it('the action panel and the seats default to chips when told nothing', () => {
    const panel = stripComments(read('src/components/table/ActionPanel.tsx'));
    expect(panel).toMatch(/showStackInBB\s*=\s*false/);
    const seat = stripComments(read('src/components/table/SeatSlot.tsx'));
    expect(seat).toMatch(/showStackInBB\s*=\s*false/);
  });
});

describe('a supplied setting value is applied, never toggled', () => {
  /**
   * The banned shape: a guard that proves a VALUE was supplied, whose body then
   * ignores that value and flips the stored one. Correct for a bare "the user
   * tapped the switch" signal; wrong for any payload that carries state, and
   * `SettingsPanel` sends both kinds through the same callback.
   */
  const BANNED = /!==\s*undefined\s*\)\s*\n?\s*toggle\w*\(/;

  it('no settings handler in the app toggles on a supplied value', () => {
    const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((file) => Boolean(file) && existsSync(resolve(ROOT, file)));

    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(read(f));
      if (BANNED.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      'these apply a supplied setting by TOGGLING the stored value, so any ' +
        'caller that sends a full settings object (SettingsPanel\'s "Reset To ' +
        'Defaults" does) INVERTS the setting instead of assigning it. Compare ' +
        'against the current value, or pass the value through:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('TablePage compares against the current value before toggling BB', () => {
    const src = stripComments(read('src/pages/TablePage.tsx'));
    expect(src).toMatch(
      /settingsUpdate\.showStackInBB\s*!==\s*undefined\s*&&[\s\S]{0,120}settingsUpdate\.showStackInBB\s*!==\s*v8Settings\.show_stack_in_bb/
    );
  });

  it('the rule matches the line that actually shipped', () => {
    // Guarding the guard: a pattern that matches nothing passes forever.
    expect(
      BANNED.test(
        "if (settingsUpdate.showStackInBB !== undefined) toggleV8Setting('show_stack_in_bb');"
      )
    ).toBe(true);
    // ...and not the fixed shape, nor an ordinary user-driven toggle.
    expect(
      BANNED.test(
        'if (settingsUpdate.showStackInBB !== undefined && settingsUpdate.showStackInBB !== v8Settings.show_stack_in_bb) {'
      )
    ).toBe(false);
    expect(BANNED.test("onToggleDisplayMode={() => toggleV8Setting('show_stack_in_bb')}")).toBe(
      false
    );
  });
});
