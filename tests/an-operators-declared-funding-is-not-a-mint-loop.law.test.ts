/**
 * LAW: AN OPERATOR'S DECLARED FUNDING IS NOT A MINT LOOP (2026-10-03).
 *
 * fn_ca_mint_velocity_watch filed "a mint loop is running" twice on
 * 2026-10-03 (607,265.09 at 03:15 and 560,017.06 at 10:30). Both were one-off,
 * reviewed club fundings through fn_ca_fund_club, each with a mint register
 * row the funding door wrote itself: origin 'operator', op_id equal to the
 * leg's idempotency key, linked to the leg, the same amount, and a reason.
 * The watch already left out a new club's declared opening grant on that kind
 * of evidence; it now leaves out such an operator mint too, but only while at
 * most three land in the ten-minute window. A fourth means a loop through the
 * declaring door, and then every one of them counts.
 *
 * What this pins: the newest fn_ca_mint_velocity_watch on disk is this
 * migration, leaves out an operator mint only in its exact declared shape
 * (never on a key prefix, never an auto-registered 'journal' row), counts
 * them all again past three, keeps both raises and every threshold, and is
 * declared as a watched-guard redefinition in its own transaction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const FILE = '20261003131810_an_operators_declared_funding_is_not_a_mint_loop.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_mint_velocity_watch(');
  expect(start, 'the velocity watch is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?fn_ca_mint_velocity_watch\s*\(/i;
  let hit = '';
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m.name;
  return hit;
}

const FN = declaration(MIG);
const code = FN.replace(/\/\*[\s\S]*?\*\//g, ' ');

describe("an operator's declared funding is not a mint loop", () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('c22bbee2e281142c032212d4220a0a17');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM '0d9601f47ad215035eaa01b7284c1cf4'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('MINT_WATCH_' + c);
  });

  it('leaves out an operator mint only in its exact declared shape', () => {
    expect(code).toContain('AND NOT o.declared_operator_mint');
    for (const clause of [
      "l.category = 'mint'",
      "l.from_type IN ('issuance_reserve', 'system_mint')",
      "l.status = 'posted'",
      'l.idempotency_key IS NOT NULL',
      'SELECT 1 FROM public.ca_mint_ledger m',
      'm.op_id = l.idempotency_key',
      'm.chip_ledger_id = l.id',
      "m.origin = 'operator'",
      "m.performed_by_label = 'fn_ca_fund_club'",
      "m.action = 'mint' AND m.asset = 'chips'",
      'm.amount = l.amount',
      "COALESCE(btrim(m.reason), '') <> ''",
      ')) IS TRUE AS declared_operator_mint',
    ]) {
      expect(code, clause).toContain(clause);
    }
    // A key prefix declares nothing, and an auto-registered row is still counted.
    expect(code).not.toMatch(/idempotency_key\s+LIKE/i);
    expect(code).not.toContain("m.origin = 'journal'");
  });

  it('counts every operator mint again once more than three land in the window', () => {
    expect(code).toMatch(/IF v_ops > 3 THEN\s+v_mint := v_mint \+ v_op_chips;\s+END IF;/);
    expect(code).toContain("'operator_mints_10m', v_ops");
    expect(code).toContain("'operator_mint_chips_10m', round(v_op_chips,2)");
    expect(code).toContain("'operator_mints_counted', v_ops > 3");
  });

  it('keeps the opening-grant exclusion, both raises and every threshold', () => {
    expect(code).toContain('AND NOT g.declared_opening_grant');
    expect(code).toContain("l.idempotency_key = 'club-opening-grant:' || l.to_entity_id::text");
    expect(code.split('fn_ca_raise_drift_incident(').length - 1).toBe(2);
    expect(code).toContain('IF v_mint > 250000 THEN');
    expect(code).toContain("CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END");
    expect(code).toContain('IF v_burn > 1000000 THEN');
    expect(code).toContain("WHERE l.created_at > now() - interval '10 minutes'");
  });

  it('is a declared watched-guard redefinition, closed to browsers, and the newest on disk', () => {
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_mint_velocity_watch', 'migration an_operators_declared_funding_is_not_a_mint_loop');"
    );
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_mint_velocity_watch() FROM PUBLIC, anon, authenticated;'
    );
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.fn_ca_mint_velocity_watch() TO service_role;');
    expect(newestFile()).toBe(FILE);
  });
});
