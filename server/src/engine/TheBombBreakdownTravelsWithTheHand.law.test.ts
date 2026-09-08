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

  it('a bomb hand with winners but no per-pot awards still carries a breakdown the guard accepts', () => {
    // 20260906143315 attached a DEFERRED constraint trigger: a bomb hand that
    // distributed chips cannot commit without award units summing to the pot.
    // An empty per-pot award array would therefore be refused twenty times by
    // the retry queue and the hand lost outright. The winners list is the same
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
    // narrowed 2026-09-06: the old form (handId !== null && bombUnits.length)
    // was TRUE on the duplicate-recovery path, where the RPC had rolled back
    // and this call wrote nothing - which skipped the fallback and lost them.
    expect(hist).toContain('wroteAwardUnits: wroteUnitsAtomically');
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

  /* THE RETRY QUEUE WAS A SECOND WAY TO LOSE THE SAME THING (2026-09-06).
     The hot path got the atomic insert and the queue did not: a bomb hand that
     missed its first attempt was replayed with no units, written with no units,
     and the settlement-side fallback had returned long before. Found in the
     deep dive, by following the paths rather than the happy one. */
  it('the retry queue carries the breakdown with the row it holds', () => {
    expect(hist).toContain('units: Record<string, unknown>[];');
    expect(hist).toContain('enqueueHandHistory(row, bombUnits);');
    expect(hist).toMatch(/pendingHands\.push\(\{[^}]*units: structuredClone\(units\)/);
    expect(hist).toContain("insertHandHistoryRow(entry.row, 'retry-queue', entry.units ?? [])");
  });

  it('wroteAwardUnits means WE wrote them, not that a row exists', () => {
    // the duplicate-recovery path returns an existing hand id after its RPC
    // rolled back; reporting true there skips the fallback and loses the units
    //
    // 2026-09-07: the id expression gained `?? minted` when settlement started
    // minting the hand's uuid before any write (see
    // aHandNamesItselfBeforeItBanksItsRake.law.test.ts - a null hand id cost
    // 173 cash hands a day their entire per-player attribution). What THIS law
    // pins is untouched and is the second half of the line: `wroteUnits: false`
    // on the recovery path, so the caller's award-unit fallback still runs.
    expect(hist).toContain(
      'return { id: existing ?? minted, wroteUnits: false, settlementCommitted: true };'
    );
    expect(hist).toContain('wroteAwardUnits: wroteUnitsAtomically');
    expect(hist).toContain('wroteUnits: true');
  });

  it('no repair cron is the answer here', () => {
    // the fix is the transaction, not a sweep that follows it around
    expect(settle).not.toMatch(/cron\.schedule\(\s*'bomb/);
    expect(hist).not.toMatch(/cron\.schedule\(\s*'bomb/);
  });
});
