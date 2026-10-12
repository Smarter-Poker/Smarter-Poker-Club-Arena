/**
 * LAW: A TOURNAMENT TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03).
 *
 * Every per-table F06 hand call opened with smarter_private.f06_prefix, which
 * takes the tournament lane T(id) EXCLUSIVELY and the tournament row FOR
 * UPDATE, so the tables of one tournament dealt one at a time: a 40-table MTT
 * logged 4,800+ waits of 1 s or more on that one key in two hours and dealt
 * 126 hands in 10 minutes. The per-table calls now take
 * public.fn_ca_f06_share_table_lane: lease fence, G and T(id) SHARED, this
 * table and its seats FOR UPDATE, and no lock on the tournament row.
 *
 * What this pins: the helper's lock shape and order (and that it never takes
 * T or G exclusively); exactly which calls move (number state, begin, an
 * accepted finish) and that a never_started finish keeps f06_prefix; that
 * f06_prefix itself is untouched; the substitution's pins, reverse check and
 * privileges; and that the disposable-cluster proof ships with the exact live
 * pre-images.
 * scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');
const PRE = JSON.parse(
  readFileSync(resolve(process.cwd(), 'scripts/ci/fixtures/f06-share-table-lane/preimages.json'), 'utf8')
) as { pins: Record<string, string>; definitions: Record<string, string> };

function helperBody(): string {
  const start = MIG.indexOf('CREATE FUNCTION public.fn_ca_f06_share_table_lane(');
  expect(start).toBeGreaterThan(-1);
  const open = MIG.indexOf('$function$', start);
  return MIG.slice(open, MIG.indexOf('$function$;', open));
}

function decoded(fragment: string): string {
  return [...fragment.matchAll(/E'((?:[^'\\]|\\.)*)'/g)]
    .map((p) => p[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

function substitution(name: string): { oldText: string; newText: string; pin: string } {
  const at = MIG.indexOf(`  -- ${name}\n`);
  expect(at, `${name} is substituted`).toBeGreaterThan(-1);
  const seg = MIG.slice(at, MIG.indexOf('RAISE NOTICE', at));
  const pin = seg.match(/v_pin := '([0-9a-f]{32})';/)![1];
  const oldText = decoded(seg.slice(seg.indexOf('v_old :='), seg.indexOf('v_new :=')));
  const newText = decoded(seg.slice(seg.indexOf('v_new :='), seg.indexOf('v_n :=')));
  return { oldText, newText, pin };
}

describe("a tournament table's hand does not wait for its sibling tables", () => {
  it('the table lane is shared on the tournament and exclusive only on its own table', () => {
    const b = helperBody();
    const order = [
      'smarter_private.f06_authority(p_tournament_id, p_lease_generation);',
      "pg_advisory_xact_lock_shared(\n    hashtextextended('ca:tournament-terminal-settlement:v1', 0));",
      "pg_advisory_xact_lock_shared(\n    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));",
      'smarter_private.f06_authority(p_tournament_id, p_lease_generation, false);',
      'FROM public.tables WHERE id = p_table_id FOR UPDATE;',
      'ORDER BY s.id FOR UPDATE OF s;',
    ].map((s) => b.indexOf(s));
    for (let i = 0; i < order.length; i++) expect(order[i], `step ${i}`).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(b).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(b).not.toMatch(/fn_ca_lock_settlement_lane/);
    // The tournament row is read, never locked: a shared row lock from every
    // table at once only feeds MultiXact churn, and status writers already
    // hold T(id) exclusive.
    expect(b).not.toMatch(/public\.tournaments/);
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_f06_share_table_lane(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('moves exactly the per-table calls, from the exact live text', () => {
    for (const name of ['fn_f06_hand_number_state', 'fn_f06_begin_hand', 'fn_f06_finish_hand']) {
      const { oldText, newText, pin } = substitution(name);
      const def = PRE.definitions[name];
      expect(createHash('md5').update(def).digest('hex')).toBe(pin);
      expect(PRE.pins[name]).toBe(pin);
      expect(def.split(oldText)).toHaveLength(2);
      expect(oldText).toMatch(/^ PERFORM smarter_private\.f06_prefix\(p_tournament_id,p_lease_generation,'\{\}',ARRAY\[(p|h)\.?_?table_id\]\);\n$/);
      expect(newText).toContain('public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,');
    }
  });

  it('a finish that is not accepted keeps the exclusive lane', () => {
    const { newText } = substitution('fn_f06_finish_hand');
    const accepted = newText.indexOf("IF p_outcome='accepted' THEN");
    const shared = newText.indexOf('public.fn_ca_f06_share_table_lane(');
    const otherwise = newText.indexOf(' ELSE\n');
    const exclusive = newText.indexOf("smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[h.table_id]);");
    expect(accepted).toBeGreaterThan(-1);
    expect(shared).toBeGreaterThan(accepted);
    expect(otherwise).toBeGreaterThan(shared);
    expect(exclusive).toBeGreaterThan(otherwise);
    expect(MIG).toContain('F06_FINISH_NO_START_LOST_ITS_EXCLUSIVE_LANE');
  });

  it('is one transaction that leaves f06_prefix alone and checks every substitution', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).not.toMatch(/FUNCTION\s+smarter_private\.f06_prefix/);
    expect(MIG.match(/IF v_n <> 1 THEN/g)).toHaveLength(3);
    expect(MIG.match(/md5\(replace\(v_after, v_new, v_old\)\) <> v_pin/g)).toHaveLength(3);
    expect(MIG.match(/has_function_privilege\('anon', v_sig, 'EXECUTE'\)/g)).toHaveLength(3);
    expect(MIG).toContain("'fb338521b04173262828517e71741d73'");
  });

  it('ships the disposable-cluster proof', () => {
    expect(
      existsSync(
        resolve(process.cwd(), 'scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py')
      )
    ).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'scripts/ci/fixtures/f06-share-table-lane/lane-authorities.sql'))).toBe(true);
  });
});
