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

  /* WHY THIS FILE GREW A BEHAVIOURAL TEST (2026-09-06).
     Every assertion above passed while fn_ca_insert_hand_with_awards was
     INCAPABLE OF INSERTING A ROW: it used jsonb_populate_record over a NULL
     base, which supplies an explicit NULL for every column the caller did not
     name, and an explicit NULL overrides a DEFAULT - so hand_history.id came
     out NULL against a NOT NULL column and the function failed 23502 on every
     call. Reading the code told me the wiring was right. It was. The thing on
     the other end of the wire did not work.

     So the migration that defines a money-path function now CALLS it against
     the real table inside the migration, checks what it wrote, and rolls that
     back - and aborts the migration if it cannot. This test pins that habit,
     because the next author will be as sure as I was. */
  it('the migration that defines the atomic insert proves it against the real table', () => {
    const mig = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'supabase',
        'migrations',
        '20260906113554_the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it.sql'
      ),
      'utf8'
    );
    // it calls the function for real
    expect(mig).toContain('public.fn_ca_insert_hand_with_awards(');
    // it checks a DEFAULT actually applied, which is the bug it exists for
    expect(mig).toContain('created_at is NULL - the defaults are still being overridden');
    // it checks the units landed with the row
    expect(mig).toContain('expected 1 award unit written with the row');
    // and it undoes itself
    expect(mig).toContain('ca_verify_rollback');
    expect(mig).toContain('the probe row survived its rollback');
    // the insert names only the supplied columns, so defaults survive
    expect(mig).toContain('p_row ? c.column_name');
    expect(mig).not.toMatch(
      /INSERT INTO public\.hand_history\s*\n\s*SELECT \* FROM jsonb_populate_record/
    );
  });

  it('no repair cron is the answer here', () => {
    // the fix is the transaction, not a sweep that follows it around
    expect(settle).not.toMatch(/cron\.schedule\(\s*'bomb/);
    expect(hist).not.toMatch(/cron\.schedule\(\s*'bomb/);
  });
});
