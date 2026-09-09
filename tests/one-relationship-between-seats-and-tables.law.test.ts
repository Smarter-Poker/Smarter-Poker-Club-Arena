/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE RELATIONSHIP BETWEEN SEATS AND TABLES (2026-09-09)
 *  CLAUDE.md 10.11 - fix it at the root; 10.86 - a signal that answers when it
 *  does not know
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * At 17:24:47 and 17:25:29 on 2026-09-09 two migrations added two COMPOSITE
 * foreign keys from table_seats to tables. Both enforced real rules. But
 * PostgREST discovers relationships from pg_constraint and nothing else, and
 * with three foreign keys between the same two tables every hint-less embed
 * (`tables!inner(...)` from table_seats, `table_seats(...)` from tables) began
 * failing with PGRST201 "more than one relationship was found". The tournament
 * launch reads its live-seat inventory through exactly that embed, so from
 * 17:25 every launch claimed its receipt, threw before building a table, and
 * left the event in REGISTERING. Measured at 20:5x: 21 launches claimed, none
 * completed, 379 events past their start, buy-ins sitting in escrow, the last
 * tournament hand dealt at 18:11.
 *
 * The fix, applied inside the 20:55 break, keeps both invariants and removes
 * the ambiguity: the composite keys became triggers with the same error class
 * (23503) and the same constraint names, and PostgREST is back to the one
 * relationship it had at 17:23. Tournaments launched again at 21:04.
 *
 * This law is here because the next agent with a rule to enforce between a
 * seat and its table will reach for `ADD CONSTRAINT ... FOREIGN KEY ...
 * REFERENCES public.tables` again, and nothing in a schema check would say
 * why that is an outage. The three shapes below were each found by a
 * rolled-back probe before they could bite, and are pinned for the same
 * reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const migrationsDir = path.join(root, 'supabase', 'migrations');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const FIX = [
  '20260909205508_one_relationship_between_seats_and_tables_the_invariants_become_triggers.sql',
  '20260909205646_the_scope_cascade_runs_after_the_parent_row_is_written.sql',
  '20260909205854_the_seat_parent_guards_fire_on_values_not_on_column_lists.sql',
] as const;
const LAST_FIX_VERSION = '20260909205854';

const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.+\.sql$/.test(f))
  .sort();

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

describe('the fix is on disk exactly as production ran it', () => {
  it('all three migrations exist', () => {
    for (const f of FIX) {
      expect(fs.existsSync(path.join(migrationsDir, f)), f).toBe(true);
    }
  });

  it('the first drops both composite keys and asserts exactly ONE foreign key remains', () => {
    const sql = read(`supabase/migrations/${FIX[0]}`);
    expect(sql).toContain(
      'ALTER TABLE public.table_seats DROP CONSTRAINT IF EXISTS active_seat_game_scope_parent;'
    );
    expect(sql).toContain(
      'ALTER TABLE public.table_seats DROP CONSTRAINT IF EXISTS live_seat_parent_cannot_close;'
    );
    expect(sql).toMatch(
      /IF v_fk <> 1 THEN RAISE EXCEPTION 'expected exactly ONE foreign key table_seats -> tables, found %', v_fk; END IF;/
    );
  });

  it('the seat-side guard reproduces FK semantics: MATCH SIMPLE, FOR KEY SHARE, 23503 with the original constraint names', () => {
    const sql = read(`supabase/migrations/${FIX[2]}`);
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()'),
      sql.indexOf('DROP TRIGGER IF EXISTS zz_seat_parent_keys_match')
    );
    // an FK re-checks only when a referencing column changes
    expect(fn).toMatch(
      /IF TG_OP = 'UPDATE'\s+AND OLD\.table_id IS NOT DISTINCT FROM NEW\.table_id\s+AND OLD\.active_game_scope IS NOT DISTINCT FROM NEW\.active_game_scope\s+AND OLD\.active_parent_key IS NOT DISTINCT FROM NEW\.active_parent_key THEN\s+RETURN NEW;/
    );
    // MATCH SIMPLE
    expect(fn).toMatch(
      /IF NEW\.table_id IS NULL OR \(NEW\.active_game_scope IS NULL AND NEW\.active_parent_key IS NULL\) THEN\s+RETURN NEW;/
    );
    // the parent row is locked as an FK locks it
    expect(fn).toMatch(/FROM public\.tables t WHERE t\.id = NEW\.table_id FOR KEY SHARE;/);
    // same error class and the same names the other programme's tests match on
    for (const name of ['active_seat_game_scope_parent', 'live_seat_parent_cannot_close']) {
      expect(fn).toContain(`USING ERRCODE = 'foreign_key_violation', CONSTRAINT = '${name}'`);
    }
  });

  it('the cascade runs AFTER the parent write, the refusal BEFORE it, and both fire on values not column lists', () => {
    const sql = read(`supabase/migrations/${FIX[2]}`);
    expect(sql).toMatch(
      /CREATE TRIGGER zzzzz_table_parent_keys_guard\s+BEFORE UPDATE ON public\.tables\s+FOR EACH ROW\s+WHEN \(OLD\.seat_admission_key IS DISTINCT FROM NEW\.seat_admission_key\)\s+EXECUTE FUNCTION public\.trg_table_parent_keys_guard\(\);/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER zzzzz_table_scope_cascade\s+AFTER UPDATE ON public\.tables\s+FOR EACH ROW\s+WHEN \(OLD\.seat_game_scope IS DISTINCT FROM NEW\.seat_game_scope\)\s+EXECUTE FUNCTION public\.trg_table_scope_cascade\(\);/
    );
    // `UPDATE OF <column>` fires on the statement's column list; the keys are
    // DERIVED by stamp triggers from cluster_id and status, so a column list
    // never sees the write that changes them. No survivor of that shape.
    expect(sql).not.toMatch(/CREATE TRIGGER zzzzz_[a-z_]+\s+(BEFORE|AFTER) UPDATE OF /);
    // the second migration's AFTER cascade returns NULL - an AFTER trigger's
    // return value is ignored, and RETURN NEW there would be a lie
    const cascade = read(`supabase/migrations/${FIX[1]}`);
    expect(cascade).toMatch(
      /CREATE OR REPLACE FUNCTION public\.trg_table_scope_cascade\(\)[\s\S]*?RETURN NULL;\s+END \$\$;/
    );
  });

  it('the seat guard sorts AFTER the seat stamp so it judges the final row', () => {
    const sql = read(`supabase/migrations/${FIX[2]}`);
    expect(sql).toMatch(
      /CREATE TRIGGER zzzzz_seat_parent_keys_match\s+BEFORE INSERT OR UPDATE ON public\.table_seats\s+FOR EACH ROW EXECUTE FUNCTION public\.trg_seat_parent_keys_match\(\);/
    );
    expect('zzzzz_seat_parent_keys_match' > 'zzzz_stamp_active_seat_game_scope').toBe(true);
    expect(sql).toContain(
      "IF 'zzzzz_seat_parent_keys_match' <= 'zzzz_stamp_active_seat_game_scope' THEN"
    );
  });
});

describe('nothing after the fix puts a second relationship back', () => {
  const later = migrationFiles.filter((f) => f.slice(0, 14) > LAST_FIX_VERSION);

  it('no later migration adds a foreign key from table_seats to tables', () => {
    const offenders: string[] = [];
    for (const f of later) {
      const sql = stripSqlComments(read(`supabase/migrations/${f}`));
      // ALTER TABLE [public.]table_seats ... FOREIGN KEY ... REFERENCES [public.]tables(
      const re =
        /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?table_seats\b[\s\S]*?FOREIGN\s+KEY[\s\S]*?REFERENCES\s+(?:public\.)?tables\s*\(/i;
      if (re.test(sql)) offenders.push(f);
    }
    expect(
      offenders,
      'a second foreign key table_seats -> tables is PGRST201 on every hint-less embed between them: enforce the rule with a trigger (see 20260909205508) or hint every embed in the engine AND the client in the same PR'
    ).toEqual([]);
  });

  it('no later migration drops the three triggers or their functions', () => {
    const offenders: string[] = [];
    for (const f of later) {
      const sql = stripSqlComments(read(`supabase/migrations/${f}`));
      for (const t of [
        'zzzzz_seat_parent_keys_match',
        'zzzzz_table_parent_keys_guard',
        'zzzzz_table_scope_cascade',
      ]) {
        const dropped = new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${t}\\b`, 'i').test(
          sql
        );
        const recreated = new RegExp(`CREATE\\s+TRIGGER\\s+${t}\\b`, 'i').test(sql);
        if (dropped && !recreated) offenders.push(`${f}: ${t}`);
      }
      for (const fn of [
        'trg_seat_parent_keys_match',
        'trg_table_parent_keys_guard',
        'trg_table_scope_cascade',
      ]) {
        if (
          new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${fn}\\b`, 'i').test(
            sql
          )
        ) {
          offenders.push(`${f}: ${fn}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the engine still depends on the hint-less embed the fix protects', () => {
  it('the launch reads its live-seat inventory through tables!inner(tournament_id)', () => {
    const base = read('server/src/tournament/TournamentManagerBase.ts');
    const launch = base.slice(base.indexOf('protected async createTablesAndSeatPlayers('));
    expect(launch).toContain(
      "select('user_id, table_id, seat_number, tables!inner(tournament_id)')"
    );
  });
});
