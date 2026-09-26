/**
 * Create A Club, Phase 2 (2026-09-23): the opening checklist's skips and its
 * completion latch live on the server.
 *
 * Source pins for the migration that creates the store, and the one rule that
 * binds three places together: the ten optional step ids the lobby draws, the
 * ids the client sends, and the ids the server's CHECK and skip function
 * accept are the same ten, and the one required step is refused everywhere.
 *
 * The behaviour itself was proved on an isolated PostgreSQL 17 fixture
 * (owner-only reads and writes, refusals by SQLSTATE, idempotent skips,
 * racing latches leaving one latch, racing skips both landing, and the whole
 * file rolling back on any failed postcondition).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLUB_LAUNCH_OPTIONAL_TASK_IDS,
  CLUB_LAUNCH_REQUIRED_TASK_ID,
} from '../../src/utils/clubOpeningEligibility';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const SQL = read(
  'supabase/migrations/20260923143542_the_opening_checklist_latch_and_its_skips_live_on_the_server.sql'
);
const PAGE = read('src/pages/ClubHomePage.tsx');

/** The body of one function in the migration, header to closing tag. */
const fn = (name: string): string => {
  const at = SQL.indexOf(`CREATE FUNCTION public.${name}(`);
  expect(at, `${name} is not created by the migration`).toBeGreaterThan(-1);
  const open = SQL.indexOf('$function$', at);
  return SQL.slice(at, SQL.indexOf('$function$', open + 1) + '$function$'.length);
};
const idList = (text: string): string[] =>
  [...text.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();

describe('the checklist store', () => {
  const table = SQL.slice(
    SQL.indexOf('CREATE TABLE public.club_opening_checklists ('),
    SQL.indexOf(');', SQL.indexOf('CREATE TABLE public.club_opening_checklists ('))
  );

  it('is one new table with no foreign key to clubs (CLAUDE.md DDL rule 7)', () => {
    expect(table).toContain('club_id          uuid PRIMARY KEY');
    expect(table).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/FOREIGN KEY \(/);
    expect(SQL).toContain('OPENING_CHECKLIST_POSTCONDITION: the store must carry no foreign key');
  });

  it('has RLS on, no policy, and no privilege for a browser role', () => {
    expect(SQL).toContain('ALTER TABLE public.club_opening_checklists ENABLE ROW LEVEL SECURITY;');
    expect(SQL).toContain(
      'REVOKE ALL ON TABLE public.club_opening_checklists FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).not.toMatch(/CREATE POLICY/i);
    expect(SQL).not.toMatch(
      /GRANT [A-Z, ]+ ON TABLE public\.club_opening_checklists TO [a-z_, ]*(anon|authenticated)/
    );
  });

  it('can only ever hold the ten optional steps, and a latch always names who set it', () => {
    const check = table.slice(
      table.indexOf('skipped_task_ids <@ ARRAY['),
      table.indexOf(']::text[]')
    );
    expect(idList(check)).toEqual([...CLUB_LAUNCH_OPTIONAL_TASK_IDS].sort());
    expect(idList(check)).not.toContain(CLUB_LAUNCH_REQUIRED_TASK_ID);
    expect(table).toContain('(completed_at IS NULL) = (completed_by IS NULL)');
  });

  it('is one transaction, starts empty and moves no chip', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain('OPENING_CHECKLIST_POSTCONDITION: the store must start empty');
    expect(SQL).not.toMatch(/chip_treasury|chip_ledger|fn_ca_declare_ledger/);
    expect(SQL).toMatch(/--\s*@live-proof:/);
  });
});

describe('the three owner-only functions', () => {
  const state = fn('fn_club_opening_checklist_state');
  const skip = fn('fn_club_opening_checklist_skip');
  const complete = fn('fn_club_opening_checklist_complete');

  it('are definers that ask auth.uid() and answer the club owner alone', () => {
    for (const [name, body] of [
      ['fn_club_opening_checklist_state', state],
      ['fn_club_opening_checklist_skip', skip],
      ['fn_club_opening_checklist_complete', complete],
    ] as const) {
      expect(body, name).toContain('SECURITY DEFINER');
      expect(body, name).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(body, name).toContain('v_uid uuid := auth.uid();');
      expect(body, name).toContain("USING ERRCODE = '42501'");
      expect(body, name).toMatch(/owner_id IS DISTINCT FROM v_uid|v_owner IS DISTINCT FROM v_uid/);
      expect(body, name).not.toMatch(/COALESCE\(\s*auth\.uid\(\)\s*,/i);
    }
    for (const sig of [
      'fn_club_opening_checklist_state(uuid)',
      'fn_club_opening_checklist_skip(uuid, text, boolean)',
      'fn_club_opening_checklist_complete(uuid)',
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(SQL).toContain(
        `GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`
      );
    }
  });

  it('reads without writing', () => {
    expect(state).toContain('STABLE');
    expect(state).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM/);
    expect(state).toContain(
      "'skippedTaskIds', to_jsonb(COALESCE(v_row.skipped_task_ids, '{}'::text[]))"
    );
  });

  it('refuses the required step and every id that is not an optional step', () => {
    expect(skip).toContain(`IF v_task = '${CLUB_LAUNCH_REQUIRED_TASK_ID}' THEN`);
    const allowed = skip.slice(
      skip.indexOf('IF NOT (v_task = ANY (ARRAY['),
      skip.indexOf(']::text[])) THEN')
    );
    expect(idList(allowed)).toEqual([...CLUB_LAUNCH_OPTIONAL_TASK_IDS].sort());
    expect(skip).toContain("USING ERRCODE = '22023'");
    // Idempotent both ways.
    expect(skip).toContain('WHERE NOT (v_task = ANY (k.skipped_task_ids));');
    expect(skip).toContain('AND v_task = ANY (k.skipped_task_ids);');
  });

  it('latches only a finished wizard on a new standalone club, once', () => {
    expect(complete).toContain('FROM public.club_opening_setups s WHERE s.club_id = p_club_id');
    expect(complete).toContain('IF v_club.opening_checklist_started_at IS NULL THEN');
    expect(complete).toContain('COALESCE(v_club.is_union, false)');
    expect(complete).toContain('OR v_club.union_id IS NOT NULL');
    expect(complete).toContain('FROM public.union_clubs uc WHERE uc.club_id = p_club_id');
    expect(complete).toContain("USING ERRCODE = '55000'");
    expect(complete).toContain('IF FOUND AND v_row.completed_at IS NOT NULL THEN');
    expect(complete).toContain('WHERE k.completed_at IS NULL;');
  });
});

describe('one list of steps, three places', () => {
  it('the lobby marks exactly the ten optional ids optional, and the wizard required', () => {
    const list = PAGE.slice(
      PAGE.indexOf('const launchTaskList: ClubLaunchTask[] = ['),
      PAGE.indexOf('const launchTasks = resolveClubLaunchTasks(')
    );
    const steps = list.split(/\n {4}\{\n/).slice(1);
    const ids = steps.map((step) => step.match(/id: '([a-z-]+)'/)?.[1]);
    const optional = steps
      .filter((step) => step.includes('optional: true,'))
      .map((step) => step.match(/id: '([a-z-]+)'/)?.[1]);
    expect(ids[0]).toBe(CLUB_LAUNCH_REQUIRED_TASK_ID);
    expect([...optional].sort()).toEqual([...CLUB_LAUNCH_OPTIONAL_TASK_IDS].sort());
  });
});
