/**
 * THE BOMB BREAKDOWN TRAVELS WITH THE HAND.
 *
 * hand_history and bomb_pot_award_units were TWO writes with no transaction
 * between them: the row went in first, and the per-board breakdown followed as
 * a deliberately unawaited upsert so it "could never fail a hand". Measured on
 * production 2026-09-06: 3 of the 125 bomb pots dealt in one hour had NO award
 * units at all - pot paid, rake taken, and no record of which board or which
 * player got which share. The detector under-reported it as 18 in seven days
 * because it carries a grace period and an epoch floor.
 *
 * Two writes with no transaction means one of them can be the only one that
 * lands, and no amount of retrying changes that. They are one write now.
 *
 * NOT a repair sweep. Dan, 2026-09-06: "WE AREN'T USING ANY CRONS TO MONITOR OR
 * FIX, THATS A BANDAID... NOT CONSTANTLY RUNNING AROUND RECONCILING."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const hist = readFileSync(join(__dirname, '..', 'services', 'supabase', 'handHistory.ts'), 'utf8');
const settle = readFileSync(join(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');

describe('the bomb breakdown travels with the hand', () => {
  it('the award units are written by the same call that writes the row', () => {
    expect(hist).toContain("supabase.rpc('fn_ca_insert_hand_with_awards'");
    const fn = hist.slice(
      hist.indexOf('async function insertHandHistoryRow'),
      hist.indexOf('// ── Background retry queue')
    );
    // the atomic path is taken whenever there is a breakdown to keep, and it
    // is chosen BEFORE the plain insert, or the plain insert wins and the
    // units are orphaned again
    expect(fn.indexOf('fn_ca_insert_hand_with_awards')).toBeLessThan(
      fn.indexOf(".from('hand_history')")
    );
    expect(fn).toContain('if (bombAwardUnits.length > 0)');
  });

  it('settlement hands the units to logHandHistory rather than writing them after', () => {
    expect(settle).toContain('bombAwardUnits,');
    const build = settle.slice(
      settle.indexOf('const bombAwardUnits ='),
      settle.indexOf('const result = await logHandHistory(')
    );
    expect(build).toContain('snap.perPotAwards.map');
    expect(build).toContain('snap.bombPot && snap.perPotAwards.length > 0');
  });

  it('the old fire-and-forget upsert only runs when the atomic write did not', () => {
    expect(settle).toContain('if (!result.wroteAwardUnits) {');
    const guard = settle.slice(
      settle.indexOf('if (!result.wroteAwardUnits) {'),
      settle.indexOf('if (!result.wroteAwardUnits) {') + 400
    );
    expect(guard).toContain('void writeAwardUnits()');
  });

  it('logHandHistory reports whether the breakdown went in with the row', () => {
    expect(hist).toContain('wroteAwardUnits: boolean');
    expect(hist).toContain('wroteAwardUnits: handId !== null && bombUnits.length > 0');
  });

  it('no repair cron is the answer here', () => {
    // the fix is the transaction, not a sweep that follows it around
    expect(settle).not.toMatch(/cron\.schedule\(\s*'bomb/);
    expect(hist).not.toMatch(/cron\.schedule\(\s*'bomb/);
  });
});
