/**
 * ===========================================================================
 *  LAW: A HORSE SPINS THROUGH THE PERSON'S OWN WHEEL
 * ===========================================================================
 *
 * Dan, 2026-10-18: every horse plays both arenas, and a horse with no chips
 * left grinds the Diamond Arena and spins its Diamonds into chips on Diamond
 * Spins. Every Diamond Spins door names its player with auth.uid(), and a
 * horse has no session, so the wheel sat behind a door only a browser could
 * open.
 *
 * public.fn_horse_diamond_spins (migration 20261019020459) is the horse's
 * input device (CLAUDE.md 10.5). This law pins the four things that make it
 * an input device and not a second wheel:
 *
 *   1. ENGINE ONLY. fn_caller_is_engine() in its own body, and EXECUTE held by
 *      service_role alone. A browser can never reach it.
 *   2. HORSE ONLY. profiles.is_horse IS TRUE for the player it names, so it
 *      can never be used to play as a person.
 *   3. THE PERSON'S OWN FUNCTIONS. Every action calls the exact public
 *      Diamond Spins function the page calls, from a closed allow-list. No
 *      prize table, no balance write, no copy of any rule - so a horse cannot
 *      get a different deal by construction.
 *   4. THE ENGINE'S IDENTITY COMES BACK. The horse is named as the caller with
 *      transaction-local claims, and the prior claims are restored before the
 *      door returns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const FILE =
  'supabase/migrations/20261019020459_horses_spin_diamond_spins_through_the_engine_door.sql';
const SQL = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
/** Comments out, so a sentence in the header can never satisfy an assertion. */
const CODE = SQL.replace(/--[^\n]*/g, '');
const DOOR = (() => {
  const m = /CREATE FUNCTION public\.fn_horse_diamond_spins\([\s\S]*?END \$fn\$;/.exec(CODE);
  if (!m) throw new Error('fn_horse_diamond_spins is not created by ' + FILE);
  return m[0];
})();

/** Every action and the exact person function it must run. */
const ACTIONS: Record<string, string> = {
  wheel_state: 'public.fn_wheel_state_v2(',
  wheel_commit: 'public.fn_wheel_commit()',
  wheel_spin: 'public.fn_wheel_spin_v2(',
  game_commit: 'public.fn_diamond_game_commit(',
  bonus_state: 'public.fn_wheel_bonus_state(',
  bonus_start: 'public.fn_wheel_bonus_start(',
  choice_state: 'public.fn_choice_state(',
  choice_act: 'public.fn_choice_act(',
  crash_cashout: 'public.fn_crash_cashout(',
  crash_settle: 'public.fn_crash_settle(',
  cards_pick: 'public.fn_wheel_diamond_cards_pick(',
};

describe("a horse spins through the person's own wheel", () => {
  it('is one transaction with the DDL timeouts', () => {
    expect((SQL.match(/^BEGIN;/gm) || []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) || []).length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout\s*=/);
  });

  it('opens only for the engine, and no browser holds EXECUTE', () => {
    expect(DOOR).toMatch(/SECURITY DEFINER/);
    expect(DOOR).toMatch(/SET search_path = public, pg_temp/);
    expect(DOOR).toMatch(
      /IF NOT public\.fn_caller_is_engine\(\) THEN\s+RAISE EXCEPTION [^;]+ERRCODE = '42501'/
    );
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_horse_diamond_spins\(uuid, text, jsonb\) FROM PUBLIC, anon, authenticated;/
    );
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_horse_diamond_spins\(uuid, text, jsonb\) TO service_role;/
    );
    expect(CODE).not.toMatch(
      /GRANT[^;]*fn_horse_diamond_spins[^;]*TO[^;]*\b(authenticated|anon)\b/
    );
  });

  it('acts only for a horse', () => {
    expect(DOOR).toContain(
      'SELECT 1 FROM public.profiles p WHERE p.id = p_horse_id AND p.is_horse IS TRUE'
    );
    // the horse check comes before any identity is assumed
    expect(DOOR.indexOf('p.is_horse IS TRUE')).toBeLessThan(
      DOOR.indexOf("set_config('request.jwt.claim.sub', p_horse_id")
    );
  });

  it('runs the exact person function for every action, from a closed list', () => {
    const allowList = /p_action NOT IN \(([^)]*)\)/.exec(DOOR);
    expect(allowList).not.toBeNull();
    const listed = [...allowList![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(Object.keys(ACTIONS).sort());
    for (const [action, fn] of Object.entries(ACTIONS)) {
      const branch = new RegExp(`WHEN '${action}' THEN\\s+v_result := ([^;]+);`).exec(DOOR);
      expect(branch, action).not.toBeNull();
      expect(branch![1].trim().startsWith(fn), action).toBe(true);
    }
  });

  it('is an input device, not a second wheel: it moves nothing itself', () => {
    expect(DOOR).not.toMatch(/\bUPDATE\b/i);
    expect(DOOR).not.toMatch(/\bINSERT\b/i);
    expect(DOOR).not.toMatch(/\bDELETE\b/i);
    expect(DOOR).not.toMatch(/chip_balance|diamonds\s*=|deduct_diamonds|fn_credit_and_log/i);
  });

  it('names the horse for one call, then gives the engine its identity back', () => {
    for (const key of ['request.jwt.claims', 'request.jwt.claim.sub', 'request.jwt.claim.role']) {
      expect(DOOR).toContain(`current_setting('${key}', true)`);
      const sets = [
        ...DOOR.matchAll(new RegExp(`set_config\\('${key.replace(/\./g, '\\.')}',`, 'g')),
      ];
      expect(sets.length, key).toBe(2);
    }
    const restore = DOOR.indexOf(
      "set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true)"
    );
    expect(restore).toBeGreaterThan(DOOR.indexOf('END CASE;'));
    expect(restore).toBeLessThan(DOOR.indexOf('RETURN v_result;'));
    // transaction-local only: every set_config passes is_local = true
    for (const m of DOOR.matchAll(/set_config\(([^;]*?)\);/g)) expect(m[1]).toMatch(/true\)?\s*$/);
  });

  it('refuses to install when a door it delegates to is missing', () => {
    for (const fn of Object.values(ACTIONS)) {
      const name = fn.replace(/^public\./, '').replace(/\(.*$/, '');
      expect(CODE).toMatch(new RegExp(`'public\\.${name}\\(`));
    }
    expect(CODE).toMatch(/IF to_regprocedure\(v_sig\) IS NULL THEN/);
  });
});
