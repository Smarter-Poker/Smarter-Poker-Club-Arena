import { sliceEnclosingBlock } from '../helpers/sourceWindow';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE APP DOES NOT TELL PLAYERS THINGS THAT ARE NOT TRUE (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three false statements and one phantom module, found in the same sweep as
 * the mocked reroll:
 *
 *  - the Help FAQ told players two-factor authentication was "Coming Soon"
 *    while SettingsPage implements enrol / challenge / verify / unenrol
 *    against Supabase MFA, two taps away;
 *  - the lobby injected a featured club card carrying a hard-coded member
 *    count of 580 — a number nobody measured — AND then sorted by member
 *    count, so the fabricated figure outranked real clubs;
 *  - the settlement screen's "Execute Payouts" button called a retired no-op
 *    behind a success gate that could never be true, so it moved nothing and
 *    said nothing at all: no success, no error, on a money screen;
 *  - src/constants/busEvents.ts declared 49 event names, 21 of which do not
 *    exist in BusEventType, and NOTHING imported it — a typo-proof constants
 *    map that was itself full of typos nothing would catch.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const srcPath = (p: string) => resolve(__dirname, '../../src', p);
const read = (p: string) => readFileSync(srcPath(p), 'utf8');

/**
 * Source with comments stripped. Every deletion here leaves a note saying
 * WHAT was removed and why, so a negative assertion against raw text would
 * match the explanation and fail on correct code.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the Help FAQ describes the app that shipped', () => {
  const help = read('pages/HelpPage.tsx');
  const settings = read('pages/SettingsPage.tsx');

  it('2FA is documented as available, because it is', () => {
    // The implementation this claim depends on.
    expect(settings).toContain('supabase.auth.mfa.enroll');
    expect(settings).toContain('mfa.challenge');
    expect(settings).toContain('mfa.verify');
    // And the answer no longer says it is coming.
    const answer = help.slice(
      help.indexOf('Is Two-Factor Authentication Available?'),
      help.indexOf('How Do I Delete My Account?')
    );
    expect(answer).not.toContain('Coming Soon');
    expect(answer).toContain('Settings');
  });
});

describe('the lobby does not invent numbers', () => {
  it('the featured club card carries no fabricated member count', () => {
    const src = read('pages/HomePage.tsx');
    const card = src.slice(src.indexOf("name: 'Shark Club'"), src.indexOf("entity_type: 'club'"));
    expect(card).not.toMatch(/member_count:\s*\d/);
  });
});

describe('a money button that cannot pay says so', () => {
  it('the settlement page reports the no-op instead of failing silently', () => {
    const src = read('pages/SettlementPage.tsx');
    const after = sliceEnclosingBlock(src, 'SettlementService.executeMondayPayouts');
    // A zero result must produce feedback, not silence.
    expect(after).toMatch(/agentsPaid === 0 && result\.playersWithRakeback === 0/);
    expect(after).toContain('toast.info(');
    // The real success path is untouched, so a future implementation still works.
    expect(after).toMatch(/agentsPaid > 0 \|\| result\.playersWithRakeback > 0/);
  });
});

describe('the phantom bus-constants module is gone', () => {
  it('src/constants/busEvents.ts no longer exists', () => {
    expect(existsSync(srcPath('constants/busEvents.ts'))).toBe(false);
  });

  it('and nothing imports it', () => {
    const index = read('constants/index.ts');
    expect(index).not.toContain('busEvents');
  });
});

/**
 * SOUND IS ONE SWITCH (Dan, 2026-08-28, binding): "a simple switch, sounds on
 * / off is all thats needed."
 *
 * An earlier revision of this file pinned the opposite — that the dead
 * `sp_sound_settings` hydrate was KEPT as a documented contract for a future
 * category UI. Dan settled that question: there is no category UI, so the
 * hydrate, the five gates and their two zero-caller setters are deleted, and
 * these assertions replace the ones that guarded them.
 */
describe('sound is one switch', () => {
  const src = read('services/SoundService.ts');
  const code = readCode('services/SoundService.ts');

  it('no longer reads a storage key nothing writes', () => {
    // The panel that wrote it was deleted in #1316, the day before the read
    // was added — it could only ever return null.
    expect(code).not.toMatch(/getItem\('sp_sound_settings'\)/);
    expect(code).not.toMatch(/private restoreStoredConfig\(\)/);
    expect(code).not.toContain('this.restoreStoredConfig()');
  });

  it('still gates every cue on the ONE master switch, both keys', () => {
    // soundGate owns club_arena_sounds + ca_sound_enabled; either off is off.
    expect(src).toMatch(/if \(!this\.enabled \|\| !isSoundAllowed\(\)\) return false;/);
    // setEnabled persists to both keys so the two switches cannot drift.
    expect(src).toMatch(
      /setEnabled\(enabled: boolean\) \{[\s\S]*?persistSoundPreference\(enabled\)/
    );
    expect(src).toMatch(/isEnabled\(\): boolean \{\s*return this\.enabled && isSoundAllowed\(\);/);
  });

  it('keeps SoundCategory as description, since 50 call sites name their cue', () => {
    expect(src).toContain(
      "export type SoundCategory = 'action' | 'chat' | 'turn_alert' | 'win' | 'event';"
    );
  });
});
