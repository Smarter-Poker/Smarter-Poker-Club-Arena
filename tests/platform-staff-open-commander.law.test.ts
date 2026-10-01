/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - PLATFORM STAFF OPEN COMMANDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A follow-up to Ruling 22 (the Diamond Arena belongs to the system, decided by
 * Claude on Dan's delegation of 2026-09-30). daniel@smarter.poker had Club
 * Commander access only because it owned the arena. When the arena passed to
 * the system account, that access went with it. Commander already has a staff
 * rule, the platform's fn_is_platform_admin() (admin, superadmin, god), which
 * gates its activity log, leads, rate limits and tournament points. Migration
 * 20261001125101 lets both Commander access doors admit platform staff by that
 * rule, read for the user asked about. It makes up no venue row, invents no
 * subscription, and gives no club an owner back.
 *
 * Evidence: docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_platform_staff_open_commander.sql'))
  .at(-1);
if (!NAME) throw new Error('the platform-staff-open-commander migration is missing');
const MIG = migrationText(NAME);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const STAFF = "role in ('admin', 'superadmin', 'god')";

describe('LAW: platform staff open Commander', () => {
  it('changes both access doors only by pinned, asserted, reversible substitution, and grants nothing', () => {
    expect(MIG).toContain('$p$a6f1fc22c2733abeafacdde54fa9b863$p$');
    expect(MIG).toContain('$p$addade098de326d6207cfab11964a9d4$p$');
    expect(MIG).toContain('IF md5(v_def) <> r.pin THEN');
    expect(MIG).toContain("the clause to change occurs % times, expected 1'");
    expect(MIG).toContain('IF md5(v_back) <> r.pin THEN');
    expect(code(MIG)).not.toMatch(/\bGRANT\b|\bCREATE\s+(TABLE|FUNCTION|OR\s+REPLACE)\b/i);
    expect(code(MIG)).not.toMatch(
      /INSERT\s+INTO\s+(public\.)?(commander_staff|commander_subscriptions|clubs)\b/i
    );
    expect(code(MIG)).not.toMatch(/UPDATE\s+(public\.)?clubs\b/i);
  });

  it("uses fn_is_platform_admin()'s own role list, and refuses to apply if that list has moved", () => {
    expect(MIG).toContain("IF position('RETURN v_role IN (''admin'', ''superadmin'', ''god'');'");
    expect(MIG).toContain(
      'fn_is_platform_admin() no longer admits exactly admin, superadmin and god; rebuild this rule on its new list'
    );
    expect(MIG).toContain(`exists (select 1 from profiles where id = v_target and ${STAFF});`);
    expect(MIG).toContain(`ps  as (select 1 from profiles where id = v_target and ${STAFF})`);
  });

  it('admits platform staff for the user asked about, says so, and keeps every other way in', () => {
    expect(MIG).toContain('or exists(select 1 from hg) or exists(select 1 from ps)),');
    expect(MIG).toContain("'isPlatformStaff',      exists(select 1 from ps),");
    expect(MIG).toContain("'homeGroups', '[]'::jsonb, 'isPlatformStaff', false);");
    expect(MIG).toContain(
      '$o$    exists (select 1 from commander_home_groups where owner_id = v_target);\nend$o$'
    );
  });

  it('asserts at the end that callers still ask only about themselves and the arena keeps its owner', () => {
    expect(MIG).toContain(
      "IF position('v_target := v_uid;' IN pg_get_functiondef(r.oid)) = 0 THEN"
    );
    expect(MIG).toContain('no longer holds a caller to their own account');
    expect(MIG).toContain('is reachable without an account');
    expect(MIG).toContain("'00000000-0000-0000-0000-000000000001'::uuid");
    expect(MIG).toContain('the arena changed hands, or the god account owns a club again');
    expect(MIG).toContain('the Diamond identity is not whole');
  });

  it('declares its live proofs, one line each', () => {
    const proofs = [...MIG.matchAll(/^-- @live-proof: (.+)$/gm)].map((m) => m[1]);
    expect(proofs).toHaveLength(2);
    expect(proofs[0]).toContain('has_commander_access(uuid)');
    expect(proofs[1]).toContain('get_commander_access_details(uuid)');
  });

  it('keeps the rehearsal: the god account is admitted, a player is not, and nobody else changes', () => {
    const file = join(
      __dirname,
      '..',
      'docs',
      'evidence',
      'diamond-phase-11',
      'platform-staff-open-commander-rehearsal.sql'
    );
    expect(existsSync(file)).toBe(true);
    const fx = readFileSync(file, 'utf8');
    expect(fx).toContain("SET LOCAL lock_timeout = '2s';");
    expect(fx).toContain("'1 god account'");
    expect(fx).toContain("'2 player'");
    expect(fx).toContain('asking about the god account answers for the player');
    expect(fx).toContain("'3 every account'");
    expect(fx).toContain('the arena still belongs to the system account');
    expect(fx).toContain("RAISE EXCEPTION 'REHEARSAL OK [mode %]");
  });
});
