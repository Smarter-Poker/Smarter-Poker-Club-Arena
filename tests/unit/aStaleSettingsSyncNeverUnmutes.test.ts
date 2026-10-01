/**
 * A STALE SETTINGS SYNC NEVER UN-MUTES A PLAYER (2026-09-27).
 *
 * TablePage's SETTINGS_UPDATED listener receives the Settings page's cached
 * copy, re-sent on every tab return and theme change. That copy goes stale the
 * moment a player mutes at the table or in the menu, so the listener may only
 * ever turn sound OFF (through the engine, which also releases the Safari audio
 * session). A stale `true` turning sound back on was the regression this pins.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TABLE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('the table settings sync', () => {
  const at = TABLE.indexOf("useMasterBusSubscription('SETTINGS_UPDATED'");
  const handler = TABLE.slice(at, TABLE.indexOf('});', at));

  it('exists', () => {
    expect(at).toBeGreaterThan(0);
  });

  it('only ever mutes, and mutes through the engine', () => {
    expect(handler).toContain('if (s.soundEnabled === false) {');
    expect(handler).toContain('soundService.setEnabled(false);');
    expect(handler).not.toMatch(/setEnabled\(s\.soundEnabled\)/);
    expect(handler).not.toMatch(/setEnabled\(true\)/);
    expect(handler).not.toMatch(/localStorage\.setItem\([^)]*SOUNDS/);
  });
});
