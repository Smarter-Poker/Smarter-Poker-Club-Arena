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

/**
 * One statement, from `anchor` to the semicolon that closes it at depth zero.
 *
 * Inlined rather than imported: `tests/helpers/sourceWindow` lives in the
 * CLIENT tree, and this server tree refuses cross-tree imports twice over (its
 * ESM `.js` specifier guard and tsc's rootDir). Byte counts are forbidden by
 * tests/unit/noFixedSizeSourceWindows.test.ts - which caught the first draft
 * of this very assertion slicing `start + 2400`, which is the rule working.
 * The window has to be the statement because the ternary chain gains a branch
 * every time a fallback is added, and a fixed count slides off the newest one
 * while staying green.
 */
function statementAt(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`statementAt: "${anchor}" not found`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

describe('the bomb breakdown travels with the hand', () => {
  it('the award units are written by the same call that writes the row', () => {
    expect(hist).toContain("supabase.rpc('fn_ca_commit_hand_settlement'");
    const fn = hist.slice(
      hist.indexOf('async function insertHandHistoryRow'),
      hist.indexOf('// Bible V8 §2.18')
    );
    expect(fn).toContain('p_hand_row:');
    expect(fn).toContain('p_units: bombAwardUnits');
    expect(fn).not.toContain(".from('hand_history')");
    expect(fn).not.toContain('fn_ca_insert_hand_with_awards');
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

  it('a bomb hand with winners but no per-pot awards still carries a breakdown the guard accepts', () => {
    // 20260906143315 attached a DEFERRED constraint trigger: a bomb hand that
    // distributed chips cannot commit without award units summing to the pot.
    // An empty per-pot award array would therefore refuse the authoritative
    // transaction. The winners list is the same
    // money (966 of 966 bomb hands over six hours: sum(winners) == distributable
    // to the cent), so it is the fallback source of units.
    // Bounded by the statement, never by a byte count: the ternary chain
    // grows every time a fallback is added, and a fixed window would slide
    // off the newest one while staying green (tests/helpers/sourceWindow.ts).
    const build = statementAt(settle, 'const bombAwardUnits =');
    expect(build).toContain('snap.bombPot && (snap.winners?.length ?? 0) > 0');
    expect(build).toContain('snap.winners.map((w) => ({');
    expect(build).toContain('pot_index: w.potIndex ?? 0');
    expect(build).toContain('amount: w.amount');
    // and the defect is still reported, not hidden by the fallback
    expect(settle).toContain("'ServerTableEngine.bomb_award_units_empty'");
  });

  it('settlement has no second award-unit writer after the atomic commit', () => {
    expect(settle).not.toContain('writeAwardUnits');
    expect(settle).not.toContain("from('bomb_pot_award_units').upsert");
  });

  it('there is no process-local retry owner that can split the breakdown from the hand', () => {
    expect(hist).not.toMatch(
      /enqueueHandHistory|pendingHands|drainHandHistoryQueue|startHandHistoryRetry|retry-queue/
    );
  });

  it('no repair cron is the answer here', () => {
    // the fix is the transaction, not a sweep that follows it around
    expect(settle).not.toMatch(/cron\.schedule\(\s*'bomb/);
    expect(hist).not.toMatch(/cron\.schedule\(\s*'bomb/);
  });
});
