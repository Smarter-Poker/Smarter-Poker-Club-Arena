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
import { join } from 'node:path';
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

describe('a trigger whose table is supplied at run time', () => {
  // The shape migration 20261005183028 used to put poker_arena_no_chip_rake on
  // four tables, one of them club_wallets. The gate read `ON public.%I` as a
  // trigger on a table called "public" and said OK; production paged a
  // critical UndeclaredTriggerOnAMoneyTable for five days.
  const LOOP = (tables: string[], name = 'my_loop_guard') =>
    'DO $$\nDECLARE t text;\nBEGIN\n' +
    `  FOREACH t IN ARRAY ARRAY[${tables.map((x) => `'${x}'`).join(',')}]\n  LOOP\n` +
    `    EXECUTE format('DROP TRIGGER IF EXISTS ${name} ON public.%I', t);\n` +
    `    EXECUTE format('CREATE TRIGGER ${name} '\n` +
    "                   'BEFORE INSERT OR UPDATE ON public.%I '\n" +
    "                   'FOR EACH ROW EXECUTE FUNCTION public.f()', t);\n" +
    '  END LOOP;\nEND $$;';

  it('is refused for every money table the loop walks', () => {
    const hits = offenders(LOOP(['rake_records', 'club_wallets', 'wallets']));
    expect(hits.map((h: { table: string }) => h.table).sort()).toEqual(['club_wallets', 'wallets']);
    expect(
      hits.every(
        (h: { trigger: string; dynamic: boolean }) => h.trigger === 'my_loop_guard' && h.dynamic
      )
    ).toBe(true);
  });

  it('passes when the same migration declares it', () => {
    const sql = `${LOOP(['rake_records', 'club_wallets'])}\n${DECLARE('club_wallets', 'my_loop_guard')}`;
    expect(offenders(sql)).toHaveLength(0);
  });

  it('reads a target built with || the same way', () => {
    const sql =
      "DO $$\nDECLARE t text;\nBEGIN\n  FOREACH t IN ARRAY ARRAY['tournaments'] LOOP\n" +
      "    EXECUTE 'CREATE TRIGGER g BEFORE INSERT ON public.' || quote_ident(t) || ' FOR EACH ROW EXECUTE FUNCTION f()';\n" +
      '  END LOOP;\nEND $$;';
    const hits = offenders(sql);
    expect(hits).toHaveLength(1);
    expect(hits[0].table).toBe('tournaments');
  });

  it('leaves a loop over tables that are not money alone', () => {
    expect(offenders(LOOP(['rake_records', 'rake_attributions']))).toHaveLength(0);
  });

  it('reads the loop the statement is in, not every money table the file mentions', () => {
    // Measured 2026-10-10: "any money table literal in the file" was wrong for
    // 15 of 25 historical pairs. A proof query naming 'tournaments' elsewhere in
    // the migration does not put this loop's trigger on tournaments.
    const sql =
      "SELECT 1 FROM pg_class WHERE relname = 'tournaments';\n" +
      LOOP(['rake_records', 'rake_attributions']);
    expect(offenders(sql)).toHaveLength(0);
  });

  it('follows a loop over an array variable to the ARRAY it was given', () => {
    const sql =
      "DO $$\nDECLARE v_tables text[] := ARRAY['rake_records','chip_ledger']; t text;\nBEGIN\n" +
      '  FOREACH t IN ARRAY v_tables LOOP\n' +
      "    EXECUTE format('CREATE TRIGGER g BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION f()', t);\n" +
      '  END LOOP;\nEND $$;';
    expect(offenders(sql).map((h: { table: string }) => h.table)).toEqual(['chip_ledger']);
  });

  it('is not misled by the word loop, or a semicolon, inside a message', () => {
    const sql =
      "DO $$\nDECLARE t text;\nBEGIN\n  FOREACH t IN ARRAY ARRAY['wallets'] LOOP\n" +
      "    RAISE NOTICE 'installing the loop guard; table %', t;\n" +
      "    EXECUTE format('CREATE TRIGGER g BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION f()', t);\n" +
      '  END LOOP;\nEND $$;';
    expect(offenders(sql).map((h: { table: string }) => h.table)).toEqual(['wallets']);
  });

  it('reads a single statement outside any loop from its own arguments', () => {
    const sql =
      "DO $$ BEGIN EXECUTE format('CREATE TRIGGER g BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION f()', 'club_members'); END $$;";
    expect(offenders(sql).map((h: { table: string }) => h.table)).toEqual(['club_members']);
  });

  it('does not read a definition being COMPARED as a trigger being created', () => {
    // The proof-block shape: pin what pg_get_triggerdef says, create nothing.
    const sql =
      "DO $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM (VALUES ('table_seats')) v(name) LOOP\n" +
      "  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE pg_get_triggerdef(t.oid) = 'CREATE TRIGGER g BEFORE INSERT ON public.' || r.name || ' FOR EACH ROW EXECUTE FUNCTION f()') THEN\n" +
      "    RAISE EXCEPTION 'missing';\n  END IF;\nEND LOOP; END $$;";
    expect(offenders(sql)).toHaveLength(0);
    // ...while the same text ASSIGNED to be run is still a creation.
    const run = sql.replace(
      'IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE pg_get_triggerdef(t.oid) = ',
      'v_sql := '
    );
    expect(offenders(run).map((h: { table: string }) => h.table)).toEqual(['table_seats']);
  });

  it('would have refused the migration that put poker_arena_no_chip_rake on club_wallets', () => {
    const real = readFileSync(
      join(
        process.cwd(),
        'supabase/migrations/20261005183028_diamond_cash_rake_reads_the_owner_settings.sql'
      ),
      'utf8'
    );
    const keys = offenders(real).map(
      (h: { table: string; trigger: string }) => `${h.table}.${h.trigger}`
    );
    expect(keys).toContain('club_wallets.poker_arena_no_chip_rake');
  });
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
