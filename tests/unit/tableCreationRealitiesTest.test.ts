/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THREE CONTROLS THAT DID NOTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "MAKE SURE THAT ALL OF THESE ARE ADDED AS OPTIONS AND ARE
 * FULLY BUILT OUT AND IMPLEMENTED FOR ALL CASH GAMES WHEN BEING CREATED OR
 * STARTED ... INSURE THAT EVERY SINGLE FEATURE AND DETAIL IS BUILT AND
 * FUNCTIONAL BEFORE CLAIMING SUCCESS."
 *
 * An audit of all forty-odd creation controls found three that were not merely
 * unenforced but WIRED TO THE WRONG PLACE — a host set them, the form accepted
 * them, and the value went somewhere nothing reads. Those three are fixed and
 * pinned here. The rest of the audit is a programme, not a patch, and is not
 * claimed by this file.
 *
 * These are source assertions rather than behavioural ones because both writers
 * are page-level React that builds one object literal; the defect was always in
 * WHICH KEY it wrote, which is exactly what a source assertion can pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const CONFIG_PAGE = read('src/pages/TableConfigPage.tsx');
const TABLE_SERVICE = read('src/services/TableService.ts');
/** The engine's entire view of a table row. Not in here, not enforceable. */
const ENGINE_SELECT = read('server/src/services/supabase/tables.ts');

describe('the engine select list is the whole contract', () => {
  it('names the ante columns the config page must write', () => {
    expect(ENGINE_SELECT).toContain('ante_enabled');
    expect(ENGINE_SELECT).toMatch(/\bante\b/);
  });

  it('does NOT name ante_bb, which is why writing only that was dead', () => {
    expect(ENGINE_SELECT).not.toContain('ante_bb');
  });

  it('names action_time_seconds, which is why the settings blob was dead', () => {
    expect(ENGINE_SELECT).toContain('action_time_seconds');
  });
});

describe('the Ante slider now reaches the engine', () => {
  it('writes ante and ante_enabled, not just the authored big-blind figure', () => {
    expect(CONFIG_PAGE).toContain('ante_enabled: Number(config.anteBB) > 0');
    expect(CONFIG_PAGE).toMatch(/ante:\s*Number\(config\.anteBB\) > 0/);
  });

  it('keeps ante_bb as well, so the authored unit survives a blind change', () => {
    expect(CONFIG_PAGE).toContain('ante_bb: config.anteBB');
  });
});

describe("the modal stops discarding the operator's numbers", () => {
  it('uses the 40x/200x band as a FALLBACK, not an override', () => {
    // It used to be `min_buy_in: bigBlind * 40` unconditionally, three lines
    // after reading the host's own figure into `settings`.
    expect(TABLE_SERVICE).toContain('Number(settings?.min_buyin_bb) > 0');
    expect(TABLE_SERVICE).toContain('Number(settings?.max_buyin_bb) > 0');
  });

  it('mirrors action time to the column the engine reads', () => {
    expect(TABLE_SERVICE).toContain('Number(settings?.action_time_seconds) > 0');
  });
});
