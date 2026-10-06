/**
 * GUARD: the Diamond settings contract keeps its shape, and a superseded
 * migration cannot be applied.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG, AND WHAT WOULD HAVE CAUGHT IT. On 2026-10-05 between 21:55
 * and 22:40 UTC, 20261005151712_diamond_cash_rake_economics_and_accrual ran in
 * production - the file whose own first line says SUPERSEDED BY and whose
 * header says THIS FILE MUST NEVER RUN. It rebuilt the shared settings table
 * public.ca_diamond_economics in its own vocabulary, and in doing so it:
 *
 *   * redefined fn_ca_diamond_economic and fn_ca_diamond_economic_text WITHOUT
 *     the p_scope DEFAULT, which broke six live functions at RUNTIME. PL/pgSQL
 *     resolves a call at execution time, so every one of them compiled clean
 *     and then raised 42883 when it ran - including the trigger on
 *     ca_diamond_house_earmarks, so every guarantee earmark and every
 *     promotional entry failed while Diamond tournaments were open;
 *   * dropped seven of the A-lane's CHECK constraints, the closed name list
 *     among them, so no A-lane setting could be recorded at all.
 *
 * Nothing in the repository noticed either one. A test cannot reach production
 * from CI, so this guard holds the MIGRATION THAT RESTORES THE CONTRACT to the
 * shape production must have, and holds the applier to refusing a file that is
 * marked never-run. Those are the two things whose absence let this happen.
 *
 * WHY THE DEFAULT IS THE WHOLE POINT. A parameter default cannot be added by
 * CREATE OR REPLACE - PostgreSQL answers 42P13 - so a migration that means to
 * give a reader its default back MUST drop it first. A migration that only
 * replaces it will appear to succeed and quietly leave the one-argument form
 * unresolvable. This guard therefore checks the DROP and the DEFAULT together,
 * because either alone is the bug.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceSqlStatement } from './helpers/sourceWindow';
import { supersededBy } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** SQL with its line comments removed, for the checks that say "never".
 *  A rule written in a comment is a rule the comment itself would break:
 *  this migration's header DISCUSSES schema_migrations at length, and the
 *  rule is that it never writes to it. */
const sqlCode = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const REPAIR = 'supabase/migrations/20261006004756_the_diamond_settings_contract_is_restored.sql';
const repair = read(REPAIR);

/** The A-lane migration that is the contract this one restores. */
const ALANE = 'supabase/migrations/20261005151918_diamond_economics_records_the_owner_answers.sql';

/** The file that ran when it must not have. */
const SUPERSEDED = 'supabase/migrations/20261005151712_diamond_cash_rake_economics_and_accrual.sql';

/** The two readers whose lost DEFAULT broke six money-path functions. */
const READERS = ['fn_ca_diamond_economic', 'fn_ca_diamond_economic_text'] as const;

/** Every name on the closed list, in order.
 *
 *  The A-lane declares the constraint INSIDE its CREATE TABLE and the repair
 *  declares it with ALTER TABLE ... ADD, so the anchor is the constraint name
 *  itself. The window is the `name IN ( ... )` list, bounded by the `))` that
 *  closes it - by the structure it is about, never by a byte count. */
function closedList(sql: string): string[] {
  const anchor = 'CONSTRAINT ca_diamond_economics_name_is_a_question CHECK (name IN (';
  const start = sql.indexOf(anchor);
  expect(start, 'the closed name list is not declared here').toBeGreaterThan(-1);
  const from = start + anchor.length;
  const end = sql.indexOf('))', from);
  expect(end, 'the closed name list is never closed').toBeGreaterThan(from);
  return [...sql.slice(from, end).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
}

describe('the Diamond settings contract keeps its shape', () => {
  it('gives both readers their p_scope DEFAULT back, and drops before it creates', () => {
    for (const fn of READERS) {
      /* The DROP has to be there: CREATE OR REPLACE cannot add a default. */
      expect(repair, `${fn} must be dropped before it is recreated`).toContain(
        `DROP FUNCTION IF EXISTS public.${fn}(text,text);`
      );
      const created = sliceSqlStatement(repair, `CREATE FUNCTION public.${fn}(`);
      expect(created, `${fn} must be recreated with its p_scope default`).toContain(
        "p_scope text DEFAULT 'all'"
      );
      /* A plain replace is exactly the mistake that cannot be made here. */
      expect(repair).not.toContain(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    }
  });

  it('proves the one-argument form resolves, inside the migration itself', () => {
    /* The six broken callers all used a one-argument call. The migration's own
       assertion block has to exercise one of each reader, or it is only
       claiming the signature is right rather than showing it. */
    expect(repair).toMatch(/fn_ca_diamond_economic_text\('horse_entry_funding'\)/);
    expect(repair).toMatch(/fn_ca_diamond_economic\('guarantee_max_per_event'\)/);
  });

  it('restores the A-lane closed list whole - all 55 names, and the same 55', () => {
    const restored = closedList(repair);
    expect(restored).toHaveLength(55);
    /* The A-lane file is the contract; the repair may not quietly shorten it. */
    expect(restored).toEqual(closedList(read(ALANE)));
  });

  it('keeps the name inventory and the closed list in step', () => {
    const inventory = sliceSqlStatement(
      repair,
      'CREATE FUNCTION public.fn_ca_diamond_economic_names()'
    );
    const listed = [...inventory.matchAll(/\('([a-z_0-9]+)'\)/g)].map((m) => m[1]);
    expect(listed).toEqual(closedList(repair));
    /* Units come from the map rather than being restated, so they cannot
       drift from it. This is what 151712 got wrong: its own nine-name list
       called cash_rake_enabled a "switch" where the map says "boolean". */
    expect(inventory).toContain('public.fn_ca_diamond_economics_units_of(t.n)');
  });

  it('puts all seven dropped constraints back', () => {
    for (const c of [
      'name_is_a_question',
      'units_match_name',
      'one_value',
      'value_is_sane',
      'scope_shape',
      'account_exists',
      'choice_is_an_option',
    ]) {
      expect(repair, `ca_diamond_economics_${c} must be restored`).toContain(
        `ADD CONSTRAINT ca_diamond_economics_${c}`
      );
    }
  });

  it('leaves the append-only triggers alone and takes 151712 guard off', () => {
    expect(repair).toContain(
      'DROP TRIGGER IF EXISTS zz_ca_diamond_economics_guard ON public.ca_diamond_economics;'
    );
    /* These two ARE the A-lane contract. Dropping either would make the
       settings table rewritable, which is the opposite of the repair. */
    for (const t of [
      'trg_ca_diamond_economics_append_only',
      'trg_ca_diamond_economics_no_truncate',
    ]) {
      expect(repair, `${t} must not be dropped`).not.toContain(`DROP TRIGGER IF EXISTS ${t}`);
      expect(repair, `${t} must not be dropped`).not.toContain(`DROP TRIGGER ${t}`);
    }
  });

  it('writes no row to the settings table and moves neither arena switch', () => {
    /* The repair is structural. A row here would be a new owner answer, and
       that is not this migration's business. */
    const code = sqlCode(repair);
    expect(code).not.toMatch(/INSERT\s+INTO\s+public\.ca_diamond_economics/i);
    expect(code).not.toMatch(/UPDATE\s+public\.ca_arena_settings/i);
    /* And it never edits the ledger of what has been applied. The header may
       discuss schema_migrations - it has to, to explain what happened - but no
       statement may touch it. */
    expect(code).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\S*schema_migrations/i);
  });

  it('never deletes or rewrites a settled row to make a constraint pass', () => {
    /* The five NOT VALID constraints exist precisely so that history does not
       have to be edited. Deleting or rewriting a settled row instead would be
       the shortcut that loses the record of what was approved when. */
    const code = sqlCode(repair);
    expect(code).not.toMatch(/DELETE\s+FROM\s+public\.ca_diamond_economics/i);
    expect(code).not.toMatch(/UPDATE\s+public\.ca_diamond_economics/i);
    /* And no constraint is weakened to let an old row through. */
    expect(code).not.toMatch(/DROP\s+CONSTRAINT\s+ca_diamond_economics_/i);
  });
});

describe('a superseded migration can no longer be applied', () => {
  const applier = read('scripts/ci/apply-recorded-migration.mjs');

  it('the applier asks the one shared parser whether a file is superseded', () => {
    /* One definition of what the marker means, not two. */
    expect(applier).toContain("import { supersededBy } from './check-migrations-are-live.mjs'");
    expect(applier).toContain('supersededBy(sql, readdirSync(DIR))');
  });

  it('and refuses, sending nothing, when it is', () => {
    /* The refusal has to be on the REFUSED path - refused() exits 1 and sends
       nothing - and it has to happen before anything is dispatched. The window
       is the `if (superseded) { ... }` block, bounded by its own closing brace
       at column 0 and never by a byte count. */
    const at = applier.indexOf('if (superseded) {');
    expect(at).toBeGreaterThan(-1);
    const end = applier.indexOf('\n}\n', at);
    expect(end).toBeGreaterThan(at);
    const refusal = applier.slice(at, end);
    expect(refusal).toContain('refused(');
    expect(refusal).toContain('must never run');
    expect(refusal).toContain('Nothing was sent');
    /* Before the database is even asked whether it would accept DDL, which is
       the first thing that happens on the way to sending anything. */
    expect(at).toBeLessThan(applier.indexOf('async function refusalNow'));
  });

  it('would refuse the file that actually ran, 20261005151712', () => {
    const dir = readdirSync(MIGRATIONS);
    expect(supersededBy(read(SUPERSEDED), dir)).toBe('20261005183028');
  });

  it('refuses nothing that is not marked - the successor and the repair apply', () => {
    const dir = readdirSync(MIGRATIONS);
    for (const f of [
      REPAIR,
      'supabase/migrations/20261005183028_diamond_cash_rake_reads_the_owner_settings.sql',
      ALANE,
    ]) {
      expect(supersededBy(read(f), dir), `${f} must not read as superseded`).toBeNull();
    }
  });

  it('keeps 20261005151712 marked, and keeps it honest about having run', () => {
    const lines = read(SUPERSEDED).split('\n');
    /* The marker is the first line and the version on it is bare: the shared
       parser reads /^--\s*SUPERSEDED BY\s+(\d{14})\b/m and \b never matches
       between a digit and an underscore, so a marker naming the successor FILE
       would look right and be invisible. */
    expect(lines[0]).toMatch(/^--\s*SUPERSEDED BY\s+20261005183028\b/);
    const firstStatement = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(firstStatement).toBeGreaterThan(0);
    const header = lines.slice(0, firstStatement).join('\n');
    expect(header).toContain('THIS FILE MUST NEVER RUN');
    /* It DID run, and the header has to say so rather than repeating the claim
       that nothing of it reached production. */
    expect(header).toContain('20261005151712');
    expect(header).toMatch(/BY WHAT ROUTE IS NOT KNOWN/);
    expect(header).toContain('20261006004756');
    expect(header).not.toContain('NOTHING HERE WAS APPLIED: no row');
  });
});
