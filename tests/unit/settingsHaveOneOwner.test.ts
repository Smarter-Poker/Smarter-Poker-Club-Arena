/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE OWNER PER SETTING, AND NO SWITCH THAT DOES NOTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A line-by-line audit of the settings surface on 2026-08-29 found the same
 * shape over and over: a preference with TWO persisted copies, free to
 * disagree, with the winner decided by whichever code path happened to run
 * last. Every one of them presented to a player as "the app ignoring me".
 *
 *   SOUND       four copies — `ca_sound_enabled`, `club_arena_sounds`,
 *               `TableUserSettings.isSoundEnabled` (+ its column), and a
 *               `useSettingsStore.soundEnabled` nothing read.
 *   HAPTICS     the gate's two keys, plus `useTableSettings.isHapticEnabled`,
 *               which `applySideEffects` stamped over the gate on every table
 *               mount.
 *   VOLUME      `useTableSettings.soundVolume` and
 *               `SoundService.restoreStoredConfig`, which restored it from a
 *               localStorage key NOTHING in the repository has ever written.
 *   DECK        `useTableSettings.fourColorDeck` and a second dead copy in the
 *               zustand store.
 *
 * And two controls that could not do anything: `autoMuckWinners` on /settings
 * (the prompt it governs is behind a `const … = false`), and a
 * `SETTINGS_CHANGED` emit naming `'vibrations'`, which is not a key any store
 * accepts.
 *
 * Asserted at the source: each of these regresses by somebody re-adding a line,
 * not by a value coming out wrong in one render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';
import { DEFAULT_SETTINGS as BRIDGE_DEFAULTS } from '../../src/lib/settingsBridge';
import { DEFAULT_TABLE_USER_SETTINGS } from '../../src/hooks/useTableSettings';
import { DEFAULT_TABLE_SETTINGS } from '../../src/components/table/SettingsPanel';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TABLE_SETTINGS_RAW = readRaw('src/hooks/useTableSettings.ts');
const TABLE_SETTINGS = strip(TABLE_SETTINGS_RAW);
const TABLE_SOUND = strip(readRaw('src/hooks/useTableSound.ts'));
const SOUND_SERVICE = strip(readRaw('src/services/SoundService.ts'));
const SETTINGS_STORE = strip(readRaw('src/stores/useSettingsStore.ts'));
const SETTINGS_PAGE = strip(readRaw('src/pages/SettingsPage.tsx'));
const TABLE_PAGE = strip(readRaw('src/pages/TablePage.tsx'));
const VIBRATION_GATE = strip(readRaw('src/utils/vibrationGate.ts'));

describe('sound and haptics have one owner: the gates', () => {
  it('the in-table switches seed from the gate, not from one of its two keys', () => {
    /* Seeding sound state from `ca_sound_enabled` alone made the badge read ON
       for a player muted in Settings, and the mount effects then fought each
       other so the FIRST press muted something already muted. Two presses to
       get sound back, with the switch lying throughout. */
    expect(TABLE_SOUND).toMatch(/useState<boolean>\(\(\) => isSoundAllowed\(\)\)/);
    /* Haptics must consider BOTH keys for the same reason. UPDATED 2026-08-29
       (second pass): this used to pin the two hand-rolled `readBool` calls that
       did it here. They were a third copy of the gate's own rule and are gone —
       `isVibrationPreferred` is that rule, living in the gate beside the fail-
       closed logic it belongs to. Same property, one owner. */
    expect(TABLE_SOUND).toMatch(/isVibrationPreferred\(\)/);
  });

  it('the in-table haptic switch persists through the gate, which writes both keys', () => {
    /* Writing only `ca_vibration_enabled` was the haptic twin of the sound bug,
       and it survived the sweep that fixed the sound side: turning vibration ON
       at the table could not clear a mute set in Settings, because the gate
       fails closed on either key. */
    expect(TABLE_SOUND).toMatch(/setVibrationAllowed\(isVibrationEnabled\)/);
    expect(TABLE_SOUND).not.toMatch(/setItem\(STORAGE_VIBRATION/);
  });

  it('the table-settings store is no longer a second writer of the gate key', () => {
    /* `applySideEffects` runs on the FIRST snapshot — the first render of any
       table, settings page or ticker — so it stamped `vibrationsEnabled` from a
       possibly-stale blob straight over a mute the user had just set. */
    const apply = sliceMethod(TABLE_SETTINGS, 'function applySideEffects');
    expect(apply).not.toMatch(/vibrationsEnabled/);
  });

  it('but a real user change still reaches both the engine and the gate', () => {
    /* And from `commit`, so it covers every route a value can take: a local
       toggle, updateSettings, a reset, a cross-TAB echo, and a cross-DEVICE
       relay. `isSoundEnabled` used to be persisted, mirrored to a column and
       synced across devices with nothing reading it back to the audio engine —
       muting on a phone updated a column and left the laptop playing. */
    const gate = sliceMethod(TABLE_SETTINGS, 'function applyGateChanges');
    expect(gate).toMatch(/soundService\.setEnabled\(next\.isSoundEnabled\)/);
    expect(gate).toMatch(/setVibrationAllowed\(next\.isHapticEnabled\)/);
    expect(TABLE_SETTINGS).toMatch(/applyGateChanges\(previous, next\)/);
  });

  it('setVibrationAllowed cannot throw out of a bus dispatch', () => {
    /* It was the one function in either gate file with no try/catch, and
       `setItem` throws in private mode — the environment the sibling catch
       names by name. Its caller runs inside a MasterBus subscriber. */
    const setter = sliceMethod(VIBRATION_GATE, 'export function setVibrationAllowed');
    expect(setter).toMatch(/try\s*\{/);
    expect(setter).toMatch(/catch/);
  });
});

describe('master volume has one owner', () => {
  it('the settings store applies it', () => {
    const gate = sliceMethod(TABLE_SETTINGS, 'function applyGateChanges');
    expect(gate).toMatch(/setMasterVolume/);
    // 0-100 in the store, 0-1 in the engine. One conversion, in one place.
    expect(gate).toMatch(/\/ 100/);
  });

  it('SoundService no longer restores it from a key nothing writes', () => {
    /* `sp_sound_settings` appeared EXACTLY ONCE in the whole repository: in the
       read. The component its doc-comment named as the shape owner does not
       exist. So it was a no-op that read as working code AND a second writer of
       master volume at boot. */
    expect(SOUND_SERVICE).not.toMatch(/sp_sound_settings/);
  });
});

describe('no control that cannot do anything', () => {
  it('the settings page does not offer an auto-muck-winners switch', () => {
    /* The show-or-muck prompt it governs has been hard-disabled since
       2026-08-23 (`ASK_TO_SHOW_ON_UNCONTESTED_WIN = false`), so flipping this
       wrote localStorage, the table blob AND a database column, said "Settings
       saved!", and changed nothing that exists. */
    expect(SETTINGS_PAGE).not.toMatch(/updateSetting\('autoMuckWinners'/);
    // The prompt really is still off; if it comes back, restore the control.
    expect(TABLE_PAGE).toMatch(/const ASK_TO_SHOW_ON_UNCONTESTED_WIN = false/);
  });

  it('the bridge does not write a column no control governs', () => {
    const to = sliceMethod(
      strip(readRaw('src/lib/settingsBridge.ts')),
      'export function toTableSettings'
    );
    expect(to).not.toMatch(/autoMuckWinners:/);
  });

  it('the tab-bar vibration item names a setting the stores accept', () => {
    /* It emitted `setting: 'vibrations'` — not a key of DEFAULT_SETTINGS, not a
       column in COLUMN_FOR_KEY, not a key of DEFAULT_USER_TABLE_SETTINGS — so
       every store dropped it and the blob went stale while the phone did stop
       buzzing. The identical bug on TOGGLE_SOUNDS was fixed the day before and
       this branch was left carrying it. */
    expect(TABLE_PAGE).not.toMatch(/setting:\s*'vibrations'/);
    expect(TABLE_PAGE).toMatch(/updateSetting\('isHapticEnabled', !isVibrationAllowed\(\)\)/);
  });

  it('the zustand store keeps only the interface mode it actually owns', () => {
    /* `toggleSound`, `toggleFourColorDeck` and `toggleNotifications` had zero
       call sites, and the state behind them zero readers — a fourth copy of
       "is sound on" and a third of the deck preference, persisted and free to
       disagree, waiting for somebody to wire up a switch that does nothing. */
    for (const dead of [
      'toggleSound',
      'toggleFourColorDeck',
      'toggleNotifications',
      'soundEnabled',
      'fourColorDeck',
      'notificationsEnabled',
    ]) {
      expect(SETTINGS_STORE, `${dead} is back in the settings store`).not.toContain(dead);
    }
    expect(SETTINGS_STORE).toContain('setTheme');
  });
});

describe('the defaults that four files have to agree on', () => {
  it('sound volume is 70 everywhere', () => {
    /* settingsBridge said 80. It was masked on the normal path because
       `fromTableSettings` overrides it from the table store — but
       `validateSettings` falls back to it for any stored blob that fails
       validation, at which point Save raised the player's volume by 14%. The
       `sound_volume` column's own COMMENT says the client and DB MUST agree. */
    expect(BRIDGE_DEFAULTS.soundVolume).toBe(70);
    expect(DEFAULT_TABLE_USER_SETTINGS.soundVolume).toBe(70);
    expect(DEFAULT_TABLE_SETTINGS.soundVolume).toBe(70);
  });
});

describe('a numeric column does not come back as a number', () => {
  it('the row is coerced against the type of the default', () => {
    /* `animation_speed` is `numeric`, and PostgREST serialises numeric as a
       STRING — this repo documents that for `tables.small_blind`. So
       `"1" !== 1` was always true, `animationSpeed` was permanently judged
       "the server chose this", and a player who picked Slow on this browser had
       it reset to normal on every sign-in. Coerced against the DEFAULT's type
       rather than a list of column names, so a column that turns numeric later
       cannot bring it back. */
    expect(TABLE_SETTINGS).toMatch(/function coerceToDefaultType/);
    const hydrate = sliceMethod(TABLE_SETTINGS, 'async function hydrateFromServer');
    expect(hydrate).toMatch(/coerceToDefaultType\(key, serverValue\)/);
  });
});

describe('hydration knows what was chosen instead of guessing from the value', () => {
  it('reads the touched column rather than comparing against the default', () => {
    /* Every column is NOT NULL with a default, so "equals the default" and
       "never set" were the same thing. Turn the ticker off on a laptop, back on
       from a phone, and the laptop read the row's `true` as "no opinion" and
       pushed its stale `false` back up: the ticker turned itself off on both
       devices with nobody touching a control. */
    const hydrate = sliceMethod(TABLE_SETTINGS, 'async function hydrateFromServer');
    expect(hydrate).toMatch(/touched\.has\(column\)/);
    expect(hydrate).not.toMatch(/const serverChose = serverValue !== DEFAULT_SETTINGS\[key\]/);
  });

  it('the column is selected, or the answer is always "never chosen"', () => {
    const hydrate = sliceMethod(TABLE_SETTINGS, 'async function hydrateFromServer');
    expect(hydrate).toMatch(/TOUCHED_COLUMN/);
  });

  it('a successful write records the choice', () => {
    const push = sliceMethod(TABLE_SETTINGS, 'function pushKeyToServer');
    expect(push).toMatch(/markSettingsTouched\(\[column\]\)/);
    expect(TABLE_SETTINGS).toMatch(/fn_mark_table_setting_touched/);
  });

  it('the other hook records it too, since it writes the same row', () => {
    const other = strip(readRaw('src/hooks/useUserTableSettings.ts'));
    expect(other).toMatch(/markSettingsTouched\(\[column\]\)/);
  });

  it('a fire-and-forget write still catches a transport rejection', () => {
    /* `.then(onFulfilled)` handles fulfilment only, and a PostgREST builder
       REJECTS when the connection is down. So every settings change made
       offline was an unhandled rejection that reached telemetry through neither
       branch: reportError sat on the path never taken. */
    const push = sliceMethod(TABLE_SETTINGS, 'function pushKeyToServer');
    expect(push).toMatch(/catch \(error\)/);
    expect(push).toMatch(/reportError/);
  });

  it('the whitelist checks OWN keys, not the prototype chain', () => {
    /* `'constructor' in DEFAULT_SETTINGS` is true. */
    expect(TABLE_SETTINGS).toMatch(
      /Object\.prototype\.hasOwnProperty\.call\(DEFAULT_SETTINGS, name\)/
    );
  });
});

describe('the second hook cannot be undone by its own stale read', () => {
  it('reconciles the loaded row against edits made while it was in flight', () => {
    /* The sister hook has had this guard since 2026-08-28 and this one did not:
       the panel mounts, the read goes out, the user taps a switch inside that
       window, and the stale answer lands and puts it back — writing the old
       value to the cache and to `ca_ws_mux` too. The in-flight de-duplication
       WIDENS that window rather than closing it. */
    const other = strip(readRaw('src/hooks/useUserTableSettings.ts'));
    expect(other).toMatch(/locallyTouchedRef/);
    expect(other).toMatch(/for \(const key of locallyTouchedRef\.current\)/);
    // …and it must not survive an account switch.
    expect(other).toMatch(/locallyTouchedRef\.current\.clear\(\)/);
  });

  it('a failed or thrown row read is reported, not just console-warned', () => {
    const other = strip(readRaw('src/hooks/useUserTableSettings.ts'));
    expect(other).toMatch(/reportError\(error, 'useUserTableSettings\.Load_failed'\)/);
    expect(other).toMatch(/reportError\(err, 'useUserTableSettings\.Load_threw'\)/);
  });
});

describe('the boot hole, closed 2026-08-29 (second pass)', () => {
  it('the blob adopts the gates on first read, rather than nothing reconciling them', () => {
    /* `applyGateChanges` runs only from `commit`, and deliberately NOT from
       `applySideEffects` — writing the blob over the gate keys on every table
       mount is the second-writer bug that silently un-muted people. But that
       left the opposite hole: at boot NOTHING reconciled the two.

       Cold load, blob says sound ON (synced from another device last session),
       gate keys say muted because the player muted from the hamburger menu.
       The blob is what the switches RENDER, so they read ON while the app is
       silent — and `hydrateFromServer` only commits when something CHANGED, so
       if the server agrees with the blob nothing ever corrects it.

       The gates win, because they are what `SoundService.shouldPlay` and every
       haptic call site actually consult. */
    expect(TABLE_SETTINGS).toMatch(/function reconcileWithGates/);
    expect(TABLE_SETTINGS).toMatch(/sharedSettings = reconcileWithGates\(loadFromStorage\(\)\)/);
    const fn = sliceMethod(TABLE_SETTINGS, 'function reconcileWithGates');
    expect(fn).toMatch(/isSoundAllowed\(\)/);
    expect(fn).toMatch(/isVibrationPreferred\(\)/);
  });

  it('the haptics switch reads the PREFERENCE, not "can this device buzz"', () => {
    /* `isVibrationAllowed` returns false on a desktop with no vibrate API,
       which is correct for firing a buzz and wrong for painting a switch — it
       tells a desktop player they turned something off that they did not. */
    const gate = strip(readRaw('src/utils/vibrationGate.ts'));
    expect(gate).toMatch(/export function isVibrationPreferred/);
    expect(TABLE_SOUND).toMatch(/isVibrationPreferred\(\)\s*\)?;?/);
  });

  it('useTableSound keeps no private copy of the gate rule', () => {
    /* Two hand-rolled `readBool` calls here were a THIRD copy of the two-key
       rule, and a copy is exactly how the haptic switch got left behind by the
       2026-08-27 sound fix. `readBool` was also fail-OPEN (`raw !== 'false'`
       treats '0' and 'off' as ON) against both gates' fail-CLOSED convention. */
    expect(TABLE_SOUND).not.toMatch(/function readBool/);
    expect(TABLE_SOUND).not.toMatch(/const SETTINGS_VIBRATION/);
  });

  it('the touched-mark RPC cannot wedge the ordered write queue', () => {
    /* `useUserTableSettings` awaits it INSIDE its write queue, so the promise it
       returns is what the next tap of the same switch chains behind. A
       `supabase.rpc` on a hung connection never settles — without a ceiling one
       stalled call blocks that switch from ever reaching the server again,
       silently, because the optimistic UI has already flipped. */
    const fn = sliceMethod(TABLE_SETTINGS, 'export async function markSettingsTouched');
    expect(fn).toMatch(/Promise\.race/);
    expect(fn).toMatch(/TOUCH_MARK_TIMEOUT_MS/);
  });
});

describe('nothing left claiming to be wired that is not', () => {
  it('SoundService no longer calls an empty method at boot', () => {
    expect(SOUND_SERVICE).not.toMatch(/this\.restoreStoredConfig\(\)/);
    expect(SOUND_SERVICE).not.toMatch(/private restoreStoredConfig/);
  });

  it('the hamburger menu does not keep a dead BB toggle or write-only state', () => {
    /* `handleShowBBToggle` never had a caller — no onClick, and the switch a
       player sees lives in the expandable TableSettingsPanel. It was left in
       place beside a comment claiming it still wrote the legacy column "for
       older surfaces", which was false in both halves: it wrote nothing because
       nothing called it, and the same commit had deleted the reads. */
    const menu = strip(readRaw('src/components/navigation/HamburgerMenu.tsx'));
    expect(menu).not.toMatch(/const handleShowBBToggle/);
    expect(menu).not.toMatch(/setShowBBEnabled/);
    // The canonical column is still mirrored to the first-paint seed.
    expect(menu).toMatch(/STORAGE_KEYS\.SHOW_STACK_BB, String\(tableSettings\.show_stack_in_bb\)/);
  });

  it('TablePage has no branch for a settings key the panel cannot emit', () => {
    /* `settingsUpdate` comes only from SettingsPanel: three single-key controls
       plus resetPayload(). There is no autoMuckWinners control and the key is
       not in RESETTABLE_KEYS, so the branch could never run. */
    expect(TABLE_PAGE).not.toMatch(/settingsUpdate\.autoMuckWinners/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE FELT COLOUR IS NOT THE INTERFACE MODE (found live 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The same shape as everything above - one thing with two meanings, the winner
 * decided by whichever ran last - except this one SURVIVED the fix that was
 * meant to end it.
 *
 * `data-theme` once carried both the table felt colour and the light/dark
 * interface mode; useTableSettings.ts documents that fight and the split, and
 * states the intent plainly: "`data-theme` itself now belongs exclusively to
 * the light/dark interface mode." The felt colour moved to `data-color-theme`.
 *
 * But design-tokens.css was given BOTH attributes for every palette, `light`
 * included, and `theme` stayed an unvalidated `string`. So a felt setting still
 * holding the old value "light" kept stamping `<html data-color-theme="light">`
 * on every page, and that still matched the light palette.
 *
 * MEASURED ON PRODUCTION, signed in, 2026-09-05:
 *   data-color-theme="light",  data-theme unset
 *   club-arena-table-settings.theme === "light"
 *   club-arena-user-settings.theme  === "dark"
 *   --bg-primary resolved to #f0f4f0, --bg-secondary to #e8ede8
 * The player had chosen dark, and the felt attribute was serving them the light
 * token palette - against "THE WHOLE BACKGROUND SHOULD BE SOLID BLACK AND ALL
 * THE SAME COLOR" (Dan 2026-08-30).
 */
describe('the felt colour is not the interface mode', () => {
  const DESIGN_TOKENS = readRaw('src/styles/design-tokens.css');

  it('only data-theme selects the light palette', () => {
    // The felt attribute must not be able to turn the whole app light.
    const lightRule = DESIGN_TOKENS.slice(
      DESIGN_TOKENS.indexOf('THEME: Light Mode'),
      DESIGN_TOKENS.indexOf('--bg-primary: #f0f4f0')
    );
    expect(lightRule).toContain("[data-theme='light']");
    expect(lightRule).not.toContain("[data-color-theme='light']");
  });

  it('the felt palettes still answer to both attributes, so no skin changed', () => {
    for (const felt of ['black', 'blue', 'gold', 'purple', 'red']) {
      expect(DESIGN_TOKENS, `${felt} lost an attribute`).toContain(`[data-color-theme='${felt}']`);
    }
  });

  it('a stored theme that is not a felt palette cannot be stamped on the DOM', () => {
    // Both doors: what load() returns, and what applySideEffects() writes. The
    // second matters because a bus message from another tab and a server
    // settings row never pass through load().
    expect(TABLE_SETTINGS).toMatch(/const FELT_THEMES = new Set\(/);
    expect(TABLE_SETTINGS).toMatch(/merged\.theme = coerceFeltTheme\(merged\.theme\)/);
    expect(TABLE_SETTINGS).toMatch(
      /setAttribute\(DOM_ATTR_THEME, coerceFeltTheme\(next\.theme\)\)/
    );
  });

  it('the coercion falls back to the declared default rather than a literal', () => {
    // A second hardcoded 'black' would be a third place to change the default,
    // which is how the copies audited above came to disagree in the first place.
    expect(TABLE_SETTINGS).toMatch(/: DEFAULT_SETTINGS\.theme;/);
    expect(DEFAULT_TABLE_USER_SETTINGS.theme).toBe('black');
  });
});
