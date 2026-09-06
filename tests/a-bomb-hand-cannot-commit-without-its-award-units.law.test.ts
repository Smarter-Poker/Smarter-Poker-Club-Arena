/**
 * A BOMB POT HAND CANNOT COMMIT WITHOUT ITS AWARD UNITS.
 *
 * Phase 1 of the chip-accounting programme (PR #3272) made the engine write
 * hand_history and bomb_pot_award_units in ONE transaction through
 * fn_ca_insert_hand_with_awards. Before that, 3 of ~125 bomb pots an hour
 * committed the hand and lost the breakdown - a drift the detector under-
 * reported (18 in 7 days claimed, ~3/hour measured).
 *
 * Phase 2 attaches the rule the database can now enforce: constraint trigger
 * zz_ca_bomb_hand_keeps_its_award_units, DEFERRED to commit, refuses a bomb
 * hand that distributes chips and has no units, or units that do not sum to
 * the distributable pot. Dan, 2026-09-06: "I WANT NOTHING BUT CODE BASE FIXES
 * FOR ANY AND ALL CHIP DRIFT ISSUES." This is the write that cannot lose, not
 * a sweep that finds what it lost.
 *
 * The pins, each one a way this was or nearly was broken:
 *
 *  - 20260906101230 detached the guard because it had been attached BEFORE
 *    the engine could satisfy it. The attach migration must therefore exist,
 *    be later than the detach, and say why the engine can satisfy it now.
 *  - The trigger must be DEFERRABLE INITIALLY DEFERRED. The first draft of the
 *    attach migration set IMMEDIATE before calling the RPC and the trigger
 *    fired after the hand INSERT and before the units INSERT - the atomic
 *    write itself was refused. The rule only holds at commit.
 *  - For the same reason nothing in the engine may SET CONSTRAINTS ... IMMEDIATE
 *    around a hand write, and no migration after the attach may drop the
 *    trigger without saying so in a file of its own (a follow-up "rollback"
 *    migration is the sanctioned shape and is named in the attach header).
 *  - The attach migration proves itself against the real table, three ways,
 *    and rolls every probe back. A migration that defines a rule and does not
 *    exercise it is how a function that failed on every call shipped green
 *    (docs/changelog/2026-09-06-the-deep-dive-that-found-two-of-my-own.md).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const detach = files.find((f) =>
  f.includes('the_bomb_guard_waits_for_the_engine_that_can_satisfy_it')
);
const attach = files.find((f) =>
  f.includes('the_bomb_guard_is_attached_now_the_engine_can_satisfy_it')
);
const sql = attach ? readFileSync(join(MIGRATIONS, attach), 'utf8') : '';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|sql)$/.test(name)) out.push(p);
  }
  return out;
}

describe('a bomb pot hand cannot commit without its award units', () => {
  it('the attach migration exists and comes after the detach', () => {
    expect(detach, 'the detach migration is history and must stay').toBeTruthy();
    expect(attach, 'the attach migration must not be deleted').toBeTruthy();
    expect(attach! > detach!).toBe(true);
  });

  it('the trigger is a DEFERRED constraint trigger on hand_history for bomb rows only', () => {
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units');
    expect(sql).toMatch(/AFTER INSERT ON public\.hand_history\s+DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toContain('WHEN (NEW.bomb_pot IS NOT NULL)');
    expect(sql).toContain('EXECUTE FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units()');
  });

  it('the DDL is guarded: existence check plus lock_timeout, never a bare CREATE on a hot table', () => {
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_trigger[\s\S]*?zz_ca_bomb_hand_keeps_its_award_units/
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '10s'");
    expect(sql.indexOf('lock_timeout')).toBeLessThan(sql.indexOf('CREATE CONSTRAINT TRIGGER'));
  });

  it('the migration proves the rule against the real table, both ways, and rolls back', () => {
    // refused: a distributing bomb hand with no units
    expect(sql).toMatch(/v_state = '23000' AND v_msg LIKE 'bomb pot hand%no award units%'/);
    // accepted: units that sum, and a folded-around bomb with nothing to distribute
    expect(sql).toContain('v_accepted_with_units := true');
    expect(sql).toContain('v_accepted_nondist := true');
    // the probes fire the deferred events AFTER the atomic call, the way COMMIT would
    const calls = [...sql.matchAll(/fn_ca_insert_hand_with_awards\(/g)].map((m) => m.index!);
    const immediates = [
      ...sql.matchAll(/SET CONSTRAINTS public\.zz_ca_bomb_hand_keeps_its_award_units IMMEDIATE/g),
    ].map((m) => m.index!);
    expect(calls.length).toBe(3);
    expect(immediates.length).toBe(3);
    calls.forEach((c, i) => expect(immediates[i]).toBeGreaterThan(c));
    // and nothing survives
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = -1)');
    expect(sql).toContain(
      'IF EXISTS (SELECT 1 FROM public.bomb_pot_award_units WHERE hand_number = -1)'
    );
    expect(sql).toContain('BOMB_GUARD_ATTACHED_AND_PROVED');
  });

  it('the guard stays attached: no later migration drops it without being the named rollback', () => {
    const later = files.filter((f) => attach && f > attach);
    for (const f of later) {
      const body = readFileSync(join(MIGRATIONS, f), 'utf8');
      if (/DROP TRIGGER[^;]*zz_ca_bomb_hand_keeps_its_award_units/i.test(body)) {
        expect(
          body,
          `${f} drops the bomb guard; it must say it is the rollback the attach header names and why bomb hands stopped committing`
        ).toMatch(/rollback/i);
      }
    }
  });

  it('nothing in the engine forces constraints IMMEDIATE around a hand write', () => {
    const offenders = walk(join(ROOT, 'server', 'src')).filter((p) =>
      /SET CONSTRAINTS[^;]*IMMEDIATE/i.test(readFileSync(p, 'utf8'))
    );
    expect(offenders, 'IMMEDIATE would refuse every bomb hand the atomic RPC writes').toEqual([]);
  });
});
