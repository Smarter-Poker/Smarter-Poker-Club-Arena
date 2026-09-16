/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TRIGGER ON A MONEY TABLE DECLARES ITSELF IN THE MIGRATION THAT MAKES IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `UndeclaredTriggerOnAMoneyTable` is critical severity and pages by SMS. It
 * says why it matters itself: "the last unreviewed one broke a third of all
 * hand settlements."
 *
 * It read 76 during the 2026-09-12 audit, and 74 ninety minutes earlier in the
 * same session. The register holds 115 declarations, so it is genuinely in use
 * and genuinely drifting. A critical page that has been on for weeks is not a
 * signal: the seventy-seventh undeclared trigger looks exactly like the
 * seventy-sixth, which is to say invisible.
 *
 * So the declaration is enforced where the trigger is WRITTEN rather than
 * counted after it is live, and the register was brought level once so the gate
 * measures from a fixed baseline.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  offenders,
  MONEY_TABLES,
  stripComments,
} from '../scripts/ci/check-money-trigger-declared.mjs';

const TRIGGER = (table: string, name = 'my_new_guard') =>
  `CREATE TRIGGER ${name} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION f();`;

const DECLARE = (table: string, name = 'my_new_guard') =>
  `INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)\n` +
  `VALUES ('${table}', '${name}', 'what it guards and why it is safe');`;

describe('a new trigger on a money table', () => {
  it('is refused when the migration does not declare it', () => {
    const hits = offenders(TRIGGER('table_seats'));
    expect(hits).toHaveLength(1);
    expect(hits[0].table).toBe('table_seats');
    expect(hits[0].trigger).toBe('my_new_guard');
  });

  it('passes when the same migration declares it', () => {
    expect(offenders(`${TRIGGER('chip_ledger')}\n${DECLARE('chip_ledger')}`)).toHaveLength(0);
  });

  it('is still refused when the migration declares some OTHER trigger', () => {
    // Writing to the register is not the same as declaring THIS one. Without
    // this case the gate would pass any migration that touched the table at all.
    const sql = `${TRIGGER('wallets', 'guard_a')}\n${DECLARE('wallets', 'guard_b')}`;
    const hits = offenders(sql);
    expect(hits).toHaveLength(1);
    expect(hits[0].trigger).toBe('guard_a');
    expect(hits[0].sawRegister).toBe(true);
    expect(hits[0].sawName).toBe(false);
  });

  it('is refused for CREATE OR REPLACE and CONSTRAINT forms too', () => {
    expect(
      offenders(
        'CREATE OR REPLACE TRIGGER g BEFORE INSERT ON public.wallets FOR EACH ROW EXECUTE FUNCTION f();'
      )
    ).toHaveLength(1);
    expect(
      offenders(
        'CREATE CONSTRAINT TRIGGER g AFTER INSERT ON public.ca_settlements FOR EACH ROW EXECUTE FUNCTION f();'
      )
    ).toHaveLength(1);
  });
});

describe('unlimited MTT admission declares its financial-table guards', () => {
  const migration = readFileSync(
    new URL('../supabase/migrations/20260915150000_mtts_have_no_entry_cap.sql', import.meta.url),
    'utf8'
  );
  const triggers = [
    'a0_tournaments_unlimited_entry_capacity',
    'a1_tournaments_restart_source',
    'a2_tournaments_new_satellite_target',
  ];

  it('satisfies the maintained declaration gate in the migration that creates the guards', () => {
    expect(offenders(migration)).toEqual([]);
    // Removing the register reference reproduces the actual push refusal;
    // these guards cannot silently disappear from the watched surface.
    const withoutRegister = migration.replace(/\bca_declared_money_triggers\b/g, 'unrelated_registry');
    expect(offenders(withoutRegister).map(({ table, trigger }) => `${table}.${trigger}`).sort()).toEqual(
      triggers.map((trigger) => `tournaments.${trigger}`)
    );
  });

  for (const trigger of triggers) {
    it(`requires the explicit declaration for ${trigger}`, () => {
      // Keep CREATE TRIGGER intact and substitute only its quoted registry
      // identity. A declaration for another guard must not cover this one.
      const wrongDeclaration = migration.replaceAll(`'${trigger}'`, "'unrelated_declared_trigger'");
      expect(offenders(wrongDeclaration)).toEqual([
        { table: 'tournaments', trigger, sawRegister: true, sawName: false },
      ]);
    });
  }
});

describe('what it deliberately leaves alone', () => {
  it('ignores a trigger on a table that is not money', () => {
    expect(offenders(TRIGGER('some_other_table'))).toHaveLength(0);
  });

  it('ignores a CREATE TRIGGER that is only being talked about in a comment', () => {
    // Every header in this directory quotes the thing it refuses.
    expect(offenders('-- CREATE TRIGGER x BEFORE INSERT ON public.wallets ...')).toHaveLength(0);
    expect(offenders('/* CREATE TRIGGER x BEFORE INSERT ON public.wallets */')).toHaveLength(0);
  });

  it('accepts the baseline form, which declares whatever is live by construction', () => {
    const sql =
      `${TRIGGER('tournaments')}\n` +
      `INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)\n` +
      `SELECT u.table_name, u.trigger_name, 'baseline' FROM public.fn_undeclared_money_triggers() u;`;
    expect(offenders(sql)).toHaveLength(0);
  });
});

describe('the escape hatch costs a real reason', () => {
  it('exempts a trigger when the reason is a real one', () => {
    const sql =
      `${TRIGGER('club_members')}\n` +
      '-- money-trigger-ok: club_members.my_new_guard because it is a temporary shadow\n' +
      '--   used only inside this migration and dropped again before it commits';
    expect(offenders(sql)).toHaveLength(0);
  });

  it('does not exempt on a reason too short to be one', () => {
    const sql = `${TRIGGER('club_members')}\n-- money-trigger-ok: club_members.my_new_guard because reasons`;
    expect(offenders(sql)).toHaveLength(1);
  });
});

describe('the watched surface cannot drift quietly', () => {
  it('watches exactly the nine tables fn_undeclared_money_triggers watches', () => {
    // If a table is added to the database function and not here, the gate stops
    // covering it and says OK, which is the failure this whole file is about.
    expect([...MONEY_TABLES].sort()).toEqual(
      [
        'ca_settlements',
        'chip_ledger',
        'club_members',
        'club_wallets',
        'table_seats',
        'tournament_players',
        'tournaments',
        'union_wallets',
        'wallets',
      ].sort()
    );
  });

  it('keeps string literals when stripping comments, because the declaration lives in one', () => {
    expect(stripComments("-- gone\nVALUES ('kept')")).toContain("'kept'");
  });
});
