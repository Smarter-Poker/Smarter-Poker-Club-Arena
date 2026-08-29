/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE VOLUME SLIDER IS LINEAR, AND EVERY TOGGLE REACHES THE SAME OWNER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG THIS FILE EXISTS FOR
 *
 * `createGain` read `volume * this.masterVolume * this.effectsVolume` and then
 * connected to `this.out` — which IS `masterGain`, whose own gain is already
 * `masterVolume * effectsVolume`. So every voice built through that helper was
 * attenuated by master SQUARED:
 *
 *     slider 100 -> 1.00      slider 70 -> 0.49      slider 50 -> 0.25
 *
 * The control was quadratic and the whole app was quieter than every number it
 * displayed. It hid for as long as it did because the other forty gain nodes in
 * that file are hand-rolled and connect to `out` with a raw value — so sounds
 * made through the helper were quieter than sounds that were not, which reads
 * as "some sounds are too quiet" rather than "the slider is wrong".
 *
 * Asserted at the source: the defect is a property of where the multiplication
 * happens, and a behavioural test would have to build a real AudioContext and
 * measure a gain node to see it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOUND = strip(readRaw('src/services/SoundService.ts'));
const TABLE_SOUND = strip(readRaw('src/hooks/useTableSound.ts'));
const TABLE_SETTINGS = strip(readRaw('src/hooks/useTableSettings.ts'));
const TABLE_PAGE = strip(readRaw('src/pages/TablePage.tsx'));
const SETTINGS_PAGE = strip(readRaw('src/pages/SettingsPage.tsx'));
const HAMBURGER = strip(readRaw('src/components/navigation/HamburgerMenu.tsx'));

describe('master volume is applied exactly once', () => {
  it('createGain carries the per-voice amount and nothing else', () => {
    const fn = sliceMethod(SOUND, 'private createGain');
    expect(fn).toMatch(/gain\.gain\.value = volume;/);
    expect(
      fn,
      'master/effects here is a SECOND application — masterGain already has them'
    ).not.toMatch(/masterVolume/);
  });

  it('masterGain is where master and effects live', () => {
    // Set at construction and rewritten by setMasterVolume / setEffectsVolume,
    // which is what makes a live slider work.
    expect(SOUND).toMatch(
      /this\.masterGain\.gain\.value = this\.masterVolume \* this\.effectsVolume/
    );
  });

  it('nothing outside the store applies it any more', () => {
    /* Four writers accumulated behind a comment claiming there was one: a boot
       restore from a key nothing wrote, a TablePage effect on every mount of
       every one of six tables, the settings-panel handler right after the
       `updateSetting` that had already applied it, and SettingsPage on save.
       All four derived it from the same store, so nothing ever visibly
       disagreed — which is exactly how four copies accumulate. */
    expect(TABLE_PAGE).not.toMatch(/soundService\.setMasterVolume/);
    expect(SETTINGS_PAGE).not.toMatch(/soundService\.setMasterVolume/);
    const owner = (TABLE_SETTINGS.match(/soundService\.setMasterVolume/g) || []).length;
    expect(owner, 'the store applies it at boot and on change').toBe(2);
  });
});

describe('every sound and haptic switch reaches the same two owners', () => {
  it('the shared setter writes the engine, the gate AND the store', () => {
    /* TablePage had FOUR sound call sites that called `setIsSoundEnabled` and
       stopped — the bus TOGGLE_SOUNDS branch, the quick-actions bar, the table
       menu and the side menu. Muting from any of them left the settings panel
       showing Sound ON and `user_table_settings.sound_enabled` unwritten, so it
       never followed the account to another device. Fixing the setter fixes all
       four and any fifth. */
    const setter = sliceMethod(TABLE_SOUND, 'const setIsSoundEnabled');
    expect(setter).toMatch(/soundService\.setEnabled\(v\)/);
    expect(setter).toMatch(/setTableSetting\('isSoundEnabled', v\)/);
    const vib = sliceMethod(TABLE_SOUND, 'const setIsVibrationEnabled');
    expect(vib).toMatch(/setTableSetting\('isHapticEnabled', v\)/);
  });

  it('no call site writes a gate key by hand', () => {
    /* Two raw `localStorage.setItem` calls in the table's side menu were second
       writers of keys the gates own — and each wrote only ONE of its gate's two
       keys, which is the failure mode the gates exist to prevent. */
    expect(TABLE_PAGE).not.toMatch(/setItem\('ca_sound_enabled'/);
    expect(TABLE_PAGE).not.toMatch(/setItem\('ca_vibration_enabled'/);
  });

  it('the store writer is reachable without mounting the hook', () => {
    // The reason four half-writes existed: `updateSetting` was trapped inside
    // `useTableSettings`, so anything that could not call a hook wrote its own.
    expect(TABLE_SETTINGS).toMatch(/export function setTableSetting</);
  });
});

describe('the hamburger menu uses the gates rather than a fourth copy of them', () => {
  it('seeds both switches from the gate, not from one key each', () => {
    /* `soundGate` fails closed on EITHER of its two keys; reading only
       `club_arena_sounds` meant a player muted IN-TABLE opened this menu to a
       Sounds switch reading ON over a silent app. `useTableSound` was converted
       on 2026-08-29 and this was not. */
    expect(HAMBURGER).toMatch(/useState\(\(\) => isSoundAllowed\(\)\)/);
    expect(HAMBURGER).toMatch(/useState\(\(\) => isVibrationPreferred\(\)\)/);
  });

  it('does not write gate-owned keys from the profiles row', () => {
    /* This made `profiles` a SECOND DATABASE OWNER of "is sound on", alongside
       `user_table_settings.sound_enabled`, with nothing reconciling them — so
       opening this menu re-asserted a stale profile value over the gate. */
    expect(HAMBURGER).not.toMatch(/setItem\(STORAGE_KEYS\.SOUNDS/);
    expect(HAMBURGER).not.toMatch(/setItem\(STORAGE_KEYS\.VIBRATIONS/);
  });

  it('the haptic toggle writes through the gate, like its sound sibling', () => {
    /* The sound half got `soundService.setEnabled` on 2026-08-27; the haptic
       half was left, so turning vibration ON here could not clear a mute set by
       the in-table switch. */
    const fn = sliceMethod(HAMBURGER, 'const handleVibrationsToggle');
    expect(fn).toMatch(/setVibrationAllowed\(newValue\)/);
  });
});

describe('the gate seeding is not undone one render later', () => {
  it('the mount effect re-reads the gates instead of one raw key each', () => {
    /* THE FIX ABOVE WAS DEAD ON ARRIVAL WITHOUT THIS. The lazy `useState`
       seeds from `isSoundAllowed()` — and the load effect five lines down read
       `STORAGE_KEYS.SOUNDS` ('club_arena_sounds', one of the gate's TWO keys)
       raw and unconditionally, overwriting the correct seed on mount.

       So in the exact case the seeding fix names — ca_sound_enabled='false',
       club_arena_sounds='true' — the switch survived one render and went back
       to reading ON over a silent app. A fix undone by the code immediately
       after it is indistinguishable from no fix. */
    expect(HAMBURGER).toMatch(/setSoundsEnabled\(isSoundAllowed\(\)\)/);
    expect(HAMBURGER).toMatch(/setVibrationsEnabled\(isVibrationPreferred\(\)\)/);
    expect(HAMBURGER).not.toMatch(/getItem\(STORAGE_KEYS\.SOUNDS\)/);
    expect(HAMBURGER).not.toMatch(/getItem\(STORAGE_KEYS\.VIBRATIONS\)/);
  });

  it('the store writer subscribes to the bus like the hook does', () => {
    /* Two doors into one store must not behave differently: a caller that
       reached it without mounting `useTableSettings` would commit and broadcast
       while never listening for anybody else's changes. */
    const fn = sliceMethod(TABLE_SETTINGS, 'export function setTableSetting<');
    expect(fn).toMatch(/attachBusOnce\(\)/);
  });
});
