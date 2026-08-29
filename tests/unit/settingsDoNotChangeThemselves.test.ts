/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SETTING ONLY CHANGES WHEN THE USER CHANGES IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
 * SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
 * PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
 * MANUALLY."
 *
 * Four ways the app was still changing a setting on its own behalf, found in
 * the 2026-08-28 handoff and fixed on 2026-08-29. Each is pinned here because
 * each was invisible in use: no error, no console, and the setting looks like
 * it simply disagrees with you.
 *
 *  1. A FAILED WRITE REVERTED THE CONTROL. `useUserTableSettings` rebuilt the
 *     old value into state, localStorage and the bus when an upsert was
 *     refused. `toggleSetting` did it with no message at all.
 *
 *  2. TWO CALLBACKS RACED THE SAME KEY. HamburgerMenu read `show_stack_in_bb`
 *     from `user_table_settings` AND `show_stack_bb` from `profiles`, in
 *     unordered `.then()`s, both writing the same state and the same
 *     localStorage key. The legacy value won whenever it answered last.
 *
 *  3. RESET TO DEFAULTS WROTE SETTINGS IT DOES NOT OFFER. Including
 *     `sitOutNextHand`, whose handler makes a real `setSitOut` call — so
 *     restoring display defaults put a sitting-out player back in the game.
 *
 *  4. ONE BROWSER'S PREFERENCES WERE WRITTEN INTO ANOTHER PERSON'S ACCOUNT.
 *     `hydrateFromServer` pushes a local value up when the row has no opinion,
 *     which is the migration path for a returning player — and, on a shared
 *     machine, a permanent cross-device edit to the next person's settings.
 *
 * Asserted at the source for 2 and 4, deliberately: both are properties of the
 * code rather than of one render, and both regress by somebody re-adding a
 * line rather than by a value coming out wrong. 1 has behavioural coverage in
 * useUserTableSettings.realtime.test.tsx; 3 is checked against the real
 * exported payload below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';
import {
  DEFAULT_TABLE_SETTINGS,
  resetPayload,
  type TableSettings,
} from '../../src/components/table/SettingsPanel';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

/* These files quote the bugs they fixed at length, on purpose. Strip comments
   before a negative assertion or the history is mistaken for the code. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HAMBURGER_RAW = readRaw('src/components/navigation/HamburgerMenu.tsx');
const HAMBURGER = stripComments(HAMBURGER_RAW);
const USER_SETTINGS = stripComments(readRaw('src/hooks/useUserTableSettings.ts'));
const TABLE_SETTINGS_RAW = readRaw('src/hooks/useTableSettings.ts');
const TABLE_SETTINGS = stripComments(TABLE_SETTINGS_RAW);

describe('1. a failed save holds the value instead of undoing it', () => {
  it('neither write path rebuilds a previous value to revert to', () => {
    /* The rollback was reconstructed from `durableValueRef`. Nothing may put
       it back: the bug is not one expression, it is having a value on hand
       whose only purpose is to overwrite the user's. */
    expect(USER_SETTINGS).not.toMatch(/durableValueRef/);
    expect(USER_SETTINGS).not.toMatch(/rollbackValue|rollbackAlias/);
  });

  it('does not emit a rolled-back state it can no longer reach', () => {
    expect(USER_SETTINGS).not.toMatch(/state:\s*'rolled-back'/);
    expect(USER_SETTINGS).toMatch(/state:\s*'save-failed'/);
  });

  it('retries a lost write before telling anybody', () => {
    const persist = sliceMethod(USER_SETTINGS, 'async function persistSettingColumn');
    expect(persist).toMatch(/SAVE_RETRY_DELAYS_MS/);
    /* And abandons quietly if a newer tap has taken the column — retrying a
       superseded value IS the auto-change-back, arriving late. */
    expect(persist).toMatch(/stillCurrent\(\)/);
    expect(persist).toMatch(/status:\s*'superseded'/);
  });

  it('says so once, through the Toast layer', () => {
    /* Never a hand-rolled popup: the Toast layer is what applies Dan's Title
       Case and em-dash rules (src/utils/popupStyle.ts). */
    expect(USER_SETTINGS).toMatch(/masterBus\.emit\(\s*'SHOW_TOAST'/);
    const message = USER_SETTINGS.match(/const SAVE_FAILED_TOAST\s*=\s*([\s\S]*?);/)?.[1] ?? '';
    expect(message, 'a failed save must be reported, not silent').toContain('Device Only');
    expect(message, 'em dashes are forbidden in popup text').not.toMatch(/[—–]/);
  });

  it('agrees with the sister hook, which writes the same table', () => {
    expect(TABLE_SETTINGS_RAW).toContain('deliberately does NOT roll the switch back');
  });
});

describe('2. the BB switch has one reader and one writer', () => {
  it('does not touch the legacy profiles column at all', () => {
    /* CORRECTED 2026-08-29 (second pass). This used to assert that
       `handleShowBBToggle` still WROTE `profiles.show_stack_bb` "as a mirror
       for older surfaces" — and it did contain the string, so the test passed.
       The function had no caller. `git log -S` puts that back to the commit
       that added it: no `onClick`, and the switch a player sees lives in the
       expandable TableSettingsPanel, which writes through its own hook.

       So the mirror was never being written, and the commit that removed the
       READS had already made the column dead in both directions. Asserting a
       write EXISTS in a function nobody calls is the shape of test that keeps
       a corpse warm. The column is now untouched, and that is what is pinned. */
    expect(HAMBURGER).not.toMatch(/select\([^)]*show_stack_bb/);
    expect(HAMBURGER).not.toMatch(/show_stack_bb:/);
    expect(HAMBURGER).not.toMatch(/const handleShowBBToggle/);
  });

  it('does not query user_table_settings behind the hook that already has it', () => {
    expect(HAMBURGER).not.toMatch(/from\('user_table_settings'\)/);
    expect(HAMBURGER).toMatch(/useUserTableSettings\(/);
  });

  it('mirrors the canonical value only once the row has actually loaded', () => {
    /* Writing the hook's defaults over the localStorage seed would show a
       cold-open user chips for a moment and then persist that as their
       answer. */
    expect(HAMBURGER).toMatch(/if \(tableSettingsLoading\) return;/);
  });
});

describe('3. Reset To Defaults writes only what the panel offers', () => {
  const payload = resetPayload();

  it('never touches the sit-out switch', () => {
    /* THE SERIOUS ONE. TablePage's handler turns any defined `sitOutNextHand`
       into a real setSitOut round trip, so this reset used to put a player who
       was sitting out back into the game as a side effect of tidying up their
       card colours. */
    expect(Object.keys(payload)).not.toContain('sitOutNextHand');
  });

  it('never writes a setting with no control on the panel', () => {
    for (const orphan of ['confirmAllIn', 'autoMuckWinners', 'showStackInBB']) {
      expect(Object.keys(payload), `${orphan} has no toggle here`).not.toContain(orphan);
    }
  });

  it('restores every control it does render, to the documented default', () => {
    const offered: Array<keyof TableSettings> = [
      'autoMuckLosers',
      'autoPostBlinds',
      'showPotOdds',
      'fourColorDeck',
      'showBetSizePresets',
      'showTicker',
      'animationSpeed',
      'soundEnabled',
      'soundVolume',
      'hapticEnabled',
    ];
    for (const key of offered) {
      expect(payload[key], `${key} must be restored by Reset`).toBe(DEFAULT_TABLE_SETTINGS[key]);
    }
    expect(Object.keys(payload)).toHaveLength(offered.length);
  });
});

describe('4. this browser cannot write its settings into somebody else account', () => {
  it('gates every upward push on ownership of the local values', () => {
    const hydrate = sliceMethod(TABLE_SETTINGS, 'async function hydrateFromServer');
    const pushes = hydrate.match(/toPush\.push\(/g) || [];
    expect(pushes.length, 'the migration path must still exist').toBeGreaterThan(0);
    const guarded =
      hydrate.match(/mayAdoptLocal && local\[key\] !== DEFAULT_SETTINGS\[key\]/g) || [];
    expect(
      guarded.length,
      'every carry-up must be gated, or one of them contaminates the next account'
    ).toBe(pushes.length);
  });

  it('treats an unclaimed browser as the migration case, and a claimed one as theirs', () => {
    const hydrate = sliceMethod(TABLE_SETTINGS, 'async function hydrateFromServer');
    expect(hydrate).toMatch(/owner === null \|\| owner === userId/);
    /* Claimed on the FIRST hydrate of ANY user, so the unclaimed window is one
       sign-in per browser rather than one per sign-out. */
    expect(hydrate).toMatch(/claimLocalSettings\(userId\)/);
  });

  it('keeps the claim out of the sign-out purge', () => {
    /* Purging it would clear the claim and re-open the window on every
       sign-out, which is exactly the case it guards. */
    const purge = readRaw('src/utils/clearUserCaches.ts');
    expect(purge).not.toContain('TABLE_SETTINGS_OWNER_KEY');
    expect(purge).not.toContain('ca_table_settings_owner');
  });
});
