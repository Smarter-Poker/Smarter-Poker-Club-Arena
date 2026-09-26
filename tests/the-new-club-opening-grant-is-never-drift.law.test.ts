/**
 * LAW: THE NEW-CLUB OPENING GRANT IS NEVER DRIFT (2026-09-23)
 * ===========================================================================
 *
 * The requirement, verbatim: "Never classify the normal, declared new-club
 * opening grant as ledger drift." And: "The drift flow lock discussed by the
 * owner is specific to Midway Union. Do not globally force unrelated new-club
 * mint flows into Midway's drift classification."
 *
 * Creating a standalone chip club mints its declared 100,000-chip opening
 * bank: fn_seed_new_club_opening_bank declares it (category mint, counterparty
 * issuance_reserve since 2026-09-03, key 'club-opening-grant:<club>') and
 * fn_record_new_club_opening_bank registers it in ca_mint_ledger, linked to
 * the journal leg. Two detectors had to be taught that:
 *
 *   fn_ca_mint_velocity_watch summed every issuance leg over ten minutes and
 *   raised with no entity dimension, which fn_ca_is_midway_scope files into
 *   Midway's flow: three new clubs a warning, eleven a critical.
 *
 *   fn_ca_quick_reconcile (3f) and fn_chip_integrity_report forgave a refused
 *   grant key only when the grant journalled from system_mint, so the
 *   exemption was dead for every club created after 2026-09-03.
 *
 * This law reads the NEWEST definition of each function in the migrations,
 * because that is what a rebuild installs, and pins the exclusion to the
 * grant's exact declared shape. It also ties the two sides together: whatever
 * counterparty the newest seeder declares must be one the three detectors
 * accept, so a future change to the grant cannot silently re-arm the alarm.
 *
 * Proved on an isolated PostgreSQL 17 fixture built from the live definitions
 * (md5-verified) with the real seeder, auto-ledger, enrichment and register
 * triggers: before the migration three clubs filed a warning and eleven a
 * critical; after it twenty-three filed nothing, a non-grant mint and six
 * one-fact-short look-alikes still raised, and the burn side was unchanged.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const MIGRATION = '20260923143450_the_new_club_opening_grant_is_never_drift.sql';

/** The body of the newest migration that restates `fn`, and its file. */
function newestDefinition(fn: string): { file: string; body: string } {
  const create = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`,
    'i'
  );
  let found = { file: '', body: '' };
  for (const m of migrationCorpus()) {
    const at = m.sql.search(create);
    if (at === -1) continue;
    const rest = m.sql.slice(at);
    // The body ends at the closing twin of whatever dollar tag opened it
    // ($function$ in a pg_get_functiondef copy, $$ in a hand-written one).
    const open = /\bAS\s+(\$\w*\$)/i.exec(rest);
    const end = open ? rest.indexOf(open[1], open.index + open[0].length) : -1;
    found = { file: m.name, body: end === -1 ? rest : rest.slice(0, end) };
  }
  return found;
}

const velocity = newestDefinition('fn_ca_mint_velocity_watch');
const reconcile = newestDefinition('fn_ca_quick_reconcile');
const integrity = newestDefinition('fn_chip_integrity_report');
const seeder = newestDefinition('fn_seed_new_club_opening_bank');
const register = newestDefinition('fn_record_new_club_opening_bank');
const midway = newestDefinition('fn_ca_is_midway_scope');
const migration = migrationCorpus().find((m) => m.name === MIGRATION)?.sql ?? '';

/** The from_type literals a detector accepts for the declared grant. */
function acceptedCounterparties(body: string): string[] {
  const list = body.match(/l\.from_type IN \(([^)]*)\)/);
  return list ? [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort() : [];
}

describe('the new-club opening grant is never drift', () => {
  it('reads the newest definitions, and they are this migration', () => {
    expect(migration, `${MIGRATION} must exist`).not.toBe('');
    expect(velocity.file).toBe(MIGRATION);
    expect(reconcile.file).toBe(MIGRATION);
    expect(integrity.file).toBe(MIGRATION);
  });

  it('the velocity watch leaves out the declared grant in its exact shape, never on a key prefix', () => {
    const b = velocity.body;
    expect(b).toContain('AND NOT g.declared_opening_grant');
    for (const clause of [
      "l.category = 'mint'",
      "l.from_type IN ('issuance_reserve', 'system_mint')",
      "l.to_type = 'club_treasury'",
      "l.status = 'posted'",
      'l.amount = 100000',
      'l.to_entity_id = l.club_id',
      "l.idempotency_key = 'club-opening-grant:' || l.to_entity_id::text",
      'SELECT 1 FROM public.ca_mint_ledger m',
      'm.op_id = l.idempotency_key',
      'm.chip_ledger_id = l.id',
      "m.action = 'mint' AND m.asset = 'chips'",
      "m.holder_type = 'club' AND m.holder_id = l.to_entity_id",
      'm.amount = 100000',
      ')) IS TRUE AS declared_opening_grant',
    ]) {
      expect(b, clause).toContain(clause);
    }
    // A key prefix is not a declaration: anything can carry one.
    expect(b).not.toMatch(/LIKE\s+'club-opening-grant:%'/);
  });

  it('the grants ride along as metadata and never make a raise of their own', () => {
    const b = velocity.body;
    expect(b).toContain("'opening_grants_10m', v_grants");
    expect(b).toContain("'opening_grant_chips_10m', round(v_grant_chips,2)");
    // Exactly the two raises the watch always had: mint velocity and burn velocity.
    expect(b.split('fn_ca_raise_drift_incident(').length - 1).toBe(2);
    expect(b).toContain("'mint-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24')");
    expect(b).toContain("'burn-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24')");
    // Every other mint is still counted, with the thresholds unchanged.
    expect(b).toContain("l.from_type IN ('system_mint','issuance_reserve')");
    expect(b).toContain('IF v_mint > 250000 THEN');
    expect(b).toContain("CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END");
    expect(b).toContain('IF v_burn > 1000000 THEN');
  });

  it('both duplicate-grant exemptions accept the grant in either declared shape', () => {
    for (const { file, body } of [reconcile, integrity]) {
      expect(body, file).toContain("l.from_type IN ('system_mint', 'issuance_reserve')");
      expect(body, file).not.toContain("l.from_type = 'system_mint'");
      expect(body, file).toContain("l.idempotency_key = 'club-opening-grant:' || f.club_id::text");
      expect(body, file).toContain("f.sqlstate = '23505'");
      expect(body, file).toContain('ux_chip_ledger_idempotency_key');
    }
    // 3f keeps Midway's scope exactly where it was.
    expect(reconcile.body).toContain(
      "AND public.fn_ca_is_midway_scope(NULL, f.club_id, NULL, NULL, '{}'::jsonb)"
    );
  });

  it('whatever counterparty the grant declares, all three detectors accept it', () => {
    const declared = seeder.body.match(/fn_ca_declare_ledger\(\s*'mint',\s*'([a-z_]+)'/);
    expect(declared, `no declared counterparty in ${seeder.file}`).not.toBeNull();
    const counterparty = declared![1];
    expect(seeder.body).toContain("'club-opening-grant:' || NEW.id::text");
    expect(register.body).toContain("v_op text := 'club-opening-grant:' || NEW.id::text;");
    expect(register.body).toContain('performed_by, performed_by_label, chip_ledger_id)');
    for (const { file, body } of [velocity, reconcile, integrity]) {
      expect(acceptedCounterparties(body), file).toContain(counterparty);
      expect(acceptedCounterparties(body), file).toContain('system_mint');
    }
  });

  it('keeps Midway drift lock exactly as it is', () => {
    // Not redefined here, and neither is the incident door it guards.
    expect(migration).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_is_midway_scope/
    );
    expect(migration).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_raise_drift_incident/
    );
    expect(midway.file).not.toBe(MIGRATION);
    expect(midway.body).toContain("p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid");
    // And the file proves, inside its own transaction, that both are untouched.
    expect(migration).toContain('OPENING_GRANT_MIDWAY_TOUCHED');
  });

  it('is written against the live text and declares both watched guards', () => {
    for (const md5 of [
      '925cb8e643ecf6fae94aefbd7c266e62',
      '99634ed56c884f968ec7d43de6f16f14',
      '9876f92ff02e9eef2b660660cc7d0ce1',
    ]) {
      expect(migration).toContain(`md5(pg_get_functiondef(p.oid)) = '${md5}'`);
    }
    expect(migration).toContain(
      "public.fn_ca_declare_guard_redefinition(\n    'fn_ca_mint_velocity_watch'"
    );
    expect(migration).toContain(
      "public.fn_ca_declare_guard_redefinition(\n    'fn_ca_quick_reconcile'"
    );
    // fn_chip_integrity_report is not on the watchlist; declaring it would raise.
    expect(migration).not.toMatch(
      /fn_ca_declare_guard_redefinition\(\s*'fn_chip_integrity_report'/
    );
    expect(migration.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length).toBe(1);
  });
});
