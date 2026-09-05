/**
 * THE JOURNAL IS NEVER REFUSED BY THE FREEZE (chip standard, 2026-09-05).
 * Pinned on the migration mirrored byte-exact from production.
 *
 * Why: 104 BBJ bank moves (9.69 chips) lost their chip_ledger legs at :55 and
 * :00. fn_ca_auto_reconcile_tick (pg_cron, no service_role claim) re-banked
 * drops during the platform freeze; bbj_pools is outside the freeze guard so
 * the bank write stood, chip_ledger is inside it so the leg was refused, and
 * the autoledger logged the refusal and let the write through, as it is
 * built to. A bank moved and the journal did not.
 *
 * LAW 1 - A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A WRITE. The freeze
 *   guard passes a chip_ledger row written from inside another trigger
 *   (pg_trigger_depth() > 1): the write it records was already permitted.
 *   A direct client INSERT on chip_ledger (depth 1) is refused as before.
 * LAW 2 - A SWEEP THAT MOVES MONEY CHECKS THE FREEZE (CLAUDE.md section 13
 *   rule 5). fn_bbj_repair_unbanked returns empty while the platform is
 *   frozen and re-banks at the next tick after play resumes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_the_journal_is_never_refused_by_the_freeze\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not mirrored');
const sql = readFileSync(resolve(MIG, file), 'utf8');

const body = (name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the journal is never refused by the freeze', () => {
  it('LAW 1: the freeze guard passes a chip_ledger row written from inside another trigger, after the bypass and before the role check', () => {
    const g = body('fn_refuse_while_frozen');
    const exemption = g.indexOf("IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN");
    expect(exemption).toBeGreaterThan(-1);
    expect(g.slice(exemption)).toMatch(
      /^IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth\(\) > 1 THEN\s+RETURN COALESCE\(NEW, OLD\);\s+END IF;/
    );
    expect(exemption).toBeGreaterThan(g.indexOf('fn_freeze_bypass_active()'));
    expect(exemption).toBeLessThan(g.indexOf('request.jwt.claims'));
    // nothing else about the guard changed: the refusal itself is still there
    expect(g).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s+RAISE EXCEPTION\s+'PLATFORM_FROZEN/
    );
    expect(g).toMatch(/USING ERRCODE = '55006'/);
  });

  it('LAW 2: fn_bbj_repair_unbanked returns empty while frozen, and the migration asserts both', () => {
    const r = body('fn_bbj_repair_unbanked');
    expect(r).toMatch(
      /BEGIN\s+(--[^\n]*\n\s*)*IF public\.fn_platform_frozen\(\) THEN\s+RETURN;\s+END IF;/
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'the freeze guard does not carry the journal exemption'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'fn_bbj_repair_unbanked does not check the freeze'/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_bbj_repair_unbanked\(integer, integer\) TO service_role;/
    );
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
  });
});
