/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETTINGS FOLLOW THE USER, AND NEVER CHANGE BACK ON THEIR OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE SETTINGS,
 * THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL PAGES. AND
 * NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM MANUALLY."
 *
 * `tableSettingsAreOneStore` covers the first half — one store, so every table
 * and page in a browser agrees. This covers the second: the settings live on the
 * user's `user_table_settings` row, so they arrive on a second device, and the
 * merge that brings them down can never overwrite something the player just
 * chose.
 *
 * The hydrate is the dangerous half and is the reason most of these exist. It
 * runs while the player may already be using the panel, and a naive
 * "server wins" would show every setting snapping back a second after login.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import { DEFAULT_TABLE_USER_SETTINGS } from '../../src/hooks/useTableSettings';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode, sliceMethod } from '../helpers/sourceWindow';

const SRC = readFileSync(join(process.cwd(), 'src/hooks/useTableSettings.ts'), 'utf8');
const CODE = blankNonCode(SRC);
const SYNC = readFileSync(join(process.cwd(), 'src/services/PostgresSyncHooks.ts'), 'utf8');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('the settings are mirrored to the user row', () => {
  it('writes every panel key to a column', () => {
    /* If a key is missing from the map it silently stays per-browser — the
       exact bug being fixed, reintroduced one setting at a time. */
    for (const key of [
      'isSoundEnabled',
      'soundVolume',
      'isHapticEnabled',
      'animationSpeed',
      'theme',
      'fourColorDeck',
      'showPotOdds',
      'showBetSizePresets',
      'showTicker',
      'autoMuck',
      'autoMuckExplicit',
      'autoMuckWinners',
      'autoPostBlinds',
      'confirmAllIn',
      'cardBack',
    ]) {
      /* RAW source, not CODE: the column name IS a string literal, and
         blankNonCode blanks string literals. Asserting against the blanked copy
         can only ever fail — which it did, on the first run of this spec. */
      expect(SRC, `${key} must map to a column`).toMatch(new RegExp(`${key}:\\s*'[a-z_]+'`));
    }
  });

  it('does not take a second owner for showStackInBB', () => {
    /* useUserTableSettings already owns that column. Two writers is the bug,
       not the fix — and the ticker having two owners is precisely how it could
       change back before today. */
    const map = CODE.slice(CODE.indexOf('COLUMN_FOR_KEY'), CODE.indexOf('KEY_FOR_COLUMN'));
    expect(map).not.toMatch(/showStackInBB/);
    expect(map).not.toMatch(/show_stack_in_bb/);
  });

  it('maps showTicker onto the column that already existed', () => {
    expect(SRC).toMatch(/showTicker:\s*'show_ticker'/);
  });

  it('relays the new columns from another device', () => {
    /* PostgresSyncHooks only forwards columns named in its array; a column
       missing there arrives nowhere and cross-device silently does not work. */
    for (const column of [
      'sound_enabled',
      'sound_volume',
      'animation_speed',
      'color_theme',
      'auto_muck',
      'card_back',
      'show_ticker',
    ]) {
      expect(SYNC, `${column} must be relayed`).toContain(`'${column}'`);
    }
  });

  it('translates an incoming column name back to its key', () => {
    /* Another TAB emits the camelCase key; PostgresSyncHooks relays a row
       change from another DEVICE and names the COLUMN. Both must land. */
    expect(CODE).toMatch(/KEY_FOR_COLUMN\[/);
  });
});

describe('hydration cannot undo a live edit', () => {
  it('skips any key the user has touched this session', () => {
    /* The infuriating shape of "auto change back": flip a switch during the
       second the row is in flight and have the stale answer flip it back. */
    const hydrate = CODE.slice(CODE.indexOf('async function hydrateFromServer'));
    expect(hydrate).toMatch(/locallyTouched\.has\(key\)/);
  });

  it('marks a key as touched on every write path', () => {
    const writes = (CODE.match(/locallyTouched\.add\(/g) || []).length;
    expect(
      writes,
      'updateSetting, updateSettings and resetSettings must all mark'
    ).toBeGreaterThanOrEqual(4);
  });

  it('treats an unreadable row as unknown, not as defaults', () => {
    /* A settings panel that empties itself because one read timed out is worse
       than one that is briefly device-local. */
    const hydrate = CODE.slice(CODE.indexOf('async function hydrateFromServer'));
    expect(hydrate).toMatch(/return;/);
    expect(SRC).toMatch(/Unreadable is UNKNOWN, never "defaults"/);
  });

  it('carries a local choice UP when the server has none', () => {
    /* A returning player has real preferences in localStorage and a row full of
       defaults. Overwriting the former with the latter is every setting
       resetting itself on login. */
    const hydrate = CODE.slice(CODE.indexOf('async function hydrateFromServer'));
    expect(hydrate).toMatch(/toPush\.push\(\[key, local\[key\]\]\)/);
  });

  it('a failed save never reverts the control', () => {
    /* Dan's rule is absolute: nothing changes back unless the user changes it.
       A lost write costs the cross-device copy, not the setting. */
    /* Bounded by the function's own braces. `slice(indexOf(...))` with no end
       runs to the bottom of the file, so a negative assertion like this one
       would read the whole rest of the module and fail on somebody else's
       `commit(` — which is how this spec failed on its first run. */
    const push = sliceMethod(CODE, 'function pushKeyToServer');
    expect(push).not.toMatch(/commit\(/);
    expect(SRC).toMatch(/deliberately does NOT roll the switch back/);
  });
});

describe('the default pairing the upsert depends on', () => {
  it('exports the defaults so the column pairing can be pinned', () => {
    expect(DEFAULT_TABLE_USER_SETTINGS.soundVolume).toBe(70);
    expect(DEFAULT_TABLE_USER_SETTINGS.autoMuck).toBe(true);
    expect(DEFAULT_TABLE_USER_SETTINGS.autoMuckExplicit).toBe(false);
    expect(DEFAULT_TABLE_USER_SETTINGS.cardBack).toBe('classic_blue');
    expect(DEFAULT_TABLE_USER_SETTINGS.theme).toBe('black');
  });
});
