import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260910055955_stage_b_current_postimage_contraction.sql'
  ),
  'utf8'
);
const reseatingStart = SQL.indexOf('-- FORWARD-COMPOSED BOUNDARY: DATABASE-CHOSEN RESEAT');
const reseatingEnd = SQL.indexOf(
  '-- FORWARD-COMPOSED BOUNDARY: ATOMIC SCHEDULER CAPTURE AND DISABLE',
  reseatingStart
);
expect(reseatingStart, 'database-chosen reseat boundary').toBeGreaterThan(-1);
expect(reseatingEnd, 'next composed boundary').toBeGreaterThan(reseatingStart);
const reseating = SQL.slice(reseatingStart, reseatingEnd);

function body(name: string, tag: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} declaration is missing`).toBeGreaterThan(-1);
  const end = SQL.indexOf(`${tag};`, start);
  expect(end, `${name} body terminator is missing`).toBeGreaterThan(start);
  return SQL.slice(start, end + tag.length + 1);
}

describe('tournament reseating has one database authority', () => {
  it('keeps the complete DDL and proof in one bounded transaction', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(SQL).toContain("SET LOCAL lock_timeout = '10s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '300s';");
    expect(SQL).toContain("SET LOCAL transaction_timeout = '600s';");
    expect(reseating).not.toMatch(/^BEGIN;|^COMMIT;$/m);
    expect(reseating).toContain('DO $prove_database_owned_tournament_reseating$');
  });

  it('locks the tournament root and lets the locked database chooser own the chair', () => {
    const assign = body(
      'fn_assign_tournament_player_seat_atomic(',
      '$atomic_tournament_seat_assignment$'
    );
    const compact = assign.replace(/\s+/g, '');
    const root = assign.indexOf('fn_ca_lock_tournament_seat_acquisition(');
    const choose = assign.indexOf('fn_ca_choose_tournament_seat_locked(');
    const commit = assign.indexOf('fn_ca_assign_tournament_player_seat_locked(', choose);

    expect(compact).toContain('p_tournament_id,NULL,p_user_id');
    expect(root).toBeGreaterThan(-1);
    expect(choose).toBeGreaterThan(root);
    expect(commit).toBeGreaterThan(choose);
    expect(assign).toContain("(v_choice->>'table_id')::uuid");
    expect(assign).toContain("(v_choice->>'seat_number')::integer");
    expect(assign).not.toContain('p_tournament_id,p_table_id,p_user_id');
  });

  it('replays the one live database chair before asking for a new free chair', () => {
    const assign = body(
      'fn_assign_tournament_player_seat_atomic(',
      '$atomic_tournament_seat_assignment$'
    );
    const rosterLock = assign.indexOf('FROM public.tournament_players tp');
    const liveSeatLock = assign.indexOf('FOR UPDATE OF existing');
    const replay = assign.indexOf('IF v_existing_live_count=1 THEN');
    const choose = assign.indexOf('fn_ca_choose_tournament_seat_locked(');

    expect(rosterLock).toBeGreaterThan(-1);
    expect(liveSeatLock).toBeGreaterThan(rosterLock);
    expect(replay).toBeGreaterThan(liveSeatLock);
    expect(choose).toBeGreaterThan(replay);
    expect(assign).toContain('v_existing_table_id');
    expect(assign).toContain('v_existing_seat_number');
    expect(assign).toContain('v_existing_live_count>1');
  });

  it('keeps the public door service-only and both implementation helpers owner-only', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?FROM PUBLIC,anon,authenticated;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?TO service_role;/
    );
    expect(SQL).toContain(
      "has_function_privilege(\n          'service_role',\n          'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',\n          'EXECUTE')"
    );
    expect(SQL).toContain(
      "has_function_privilege(\n          'service_role',\n          'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',\n          'EXECUTE')"
    );
  });
});

describe('played Spin and heads-up reseats preserve accepted stack truth', () => {
  const guard = body('fn_ca_guard_seat_creation()', '$seat_guard$');

  it('retains the positive and initial seat-first funding invariants', () => {
    const positive = guard.indexOf('TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK');
    const seatFirst = guard.indexOf('SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS');
    const engine = guard.indexOf('public.fn_caller_is_engine()');
    expect(positive).toBeGreaterThan(-1);
    expect(seatFirst).toBeGreaterThan(positive);
    expect(engine).toBeGreaterThan(seatFirst);
    expect(guard).toMatch(
      /lower\(COALESCE\(v_variant,''\)\)='spin'[\s\S]*?upper\(COALESCE\(v_tournament_type,''\)\)='SPIN'[\s\S]*?COALESCE\(v_max_players,0\)<=2/
    );
    expect(guard).toContain('NEW.stack IS DISTINCT FROM v_starting_chips');
  });

  it('allows a changed lifecycle stack only from the exact RUNNING roster and latest dual journal', () => {
    expect(guard).toContain("v_path='fn_assign_tournament_player_seat_atomic'");
    expect(guard).toContain("v_tournament_status='RUNNING'");
    expect(guard).toContain('FROM public.tournament_players tp');
    expect(guard).toContain("tp.status::text='playing'");
    expect(guard).toContain('tp.chips::numeric IS NOT DISTINCT FROM NEW.stack');
    expect(guard).toContain('FROM public.hand_atomic_commits h');
    expect(guard).toContain('JOIN public.settlement_idempotency_keys settled');
    expect(guard).toContain('settled.hand_id=latest.hand_id');
    expect(guard).toContain("latest.stack_result->>'hand_id'=latest.hand_id::text");
    expect(guard).toContain("settled.status='succeeded'");
    expect(guard).toContain('settled.result IS NOT DISTINCT FROM latest.stack_result');
    expect(guard).toMatch(
      /\(latest\.stack_result->'written'->>NEW\.user_id::text\)::numeric\s+IS NOT DISTINCT FROM NEW\.stack/
    );
    expect(guard).toMatch(/ORDER BY h\.hand_number DESC,h\.table_id,h\.hand_id\s+LIMIT 1/);
  });

  it('adds no polling, watcher, reconciler, cron, or fallback writer', () => {
    expect(reseating).not.toMatch(/setInterval|setTimeout|watcher|reconcil|cron\.schedule/i);
    expect(reseating).not.toContain('UPDATE public.tournament_players');
    expect(reseating).not.toContain('INSERT INTO public.table_seats');
    expect(reseating).not.toContain('UPDATE public.table_seats');
  });
});
