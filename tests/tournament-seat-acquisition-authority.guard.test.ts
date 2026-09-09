import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const sql = readFileSync(
  root(
    'supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const manager = readFileSync(root('server/src/tournament/TournamentManager.ts'), 'utf8');
const base = readFileSync(root('server/src/tournament/TournamentManagerBase.ts'), 'utf8');
const recurring = readFileSync(root('server/src/services/TournamentRecurringService.ts'), 'utf8');
const transport = readFileSync(
  root('server/src/tournament/tournamentSeatAssignmentRpc.ts'),
  'utf8'
);

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = sql.indexOf(delimiter);
  const second = sql.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return sql.slice(first + delimiter.length, second);
}

function method(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const next = source.indexOf('\n  protected ', start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}

const rootLock = taggedBody('seat_acquisition_lock');
const assignment = taggedBody('atomic_tournament_seat_assignment');
const guard = taggedBody('tournament_seat_acquisition_guard');
const sync = taggedBody('seat_count');

describe('tournament seats are acquired below one hard root authority', () => {
  it('takes the complete parent lock prefix before child state without retrying', () => {
    const global = rootLock.indexOf('ca:tournament-terminal-settlement:v1');
    const maintenance = rootLock.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const mission = rootLock.indexOf('public.fn_lock_daily_mission_user(p_user_id)');
    const launch = rootLock.indexOf('FROM public.tournament_launch_receipts r');
    const tournament = rootLock.indexOf('FROM public.tournaments t');

    expect(global).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(global);
    expect(mission).toBeGreaterThan(maintenance);
    expect(launch).toBeGreaterThan(mission);
    expect(tournament).toBeGreaterThan(launch);
    expect(rootLock).not.toMatch(/NOWAIT|pg_try_advisory|deadlock_detected|pg_sleep|retry/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_lock_tournament_seat_acquisition\([\s\S]*?service_role;/
    );
  });

  it('puts every public create or registration door behind that root', () => {
    for (const tag of [
      'take_seat_terminal_gate',
      'horse_seat_terminal_gate',
      'late_seat_terminal_gate',
      'registration_terminal_gate',
      'ticket_registration_terminal_gate',
      'horse_registration_terminal_gate',
    ]) {
      expect(taggedBody(tag), tag).toContain('fn_ca_lock_tournament_seat_acquisition');
    }
    expect(sql).toContain('fn_take_seat_and_buy_in_before_terminal_seat_gate');
    expect(sql).toContain('fn_register_for_tournament_with_ticket_before_terminal_gate');
    expect(sql).toContain('fn_register_horse_for_tournament_before_terminal_gate');
    expect(taggedBody('registration_terminal_gate_compat')).toContain(
      'public.fn_register_for_tournament(p_tournament_id,false)'
    );
    expect(taggedBody('horse_registration_terminal_gate_compat')).toContain(
      'p_tournament_id,p_user_id,true'
    );
  });

  it('commits seat, roster, and exact table count in one service-only RPC', () => {
    const roster = assignment.indexOf('FROM public.tournament_players tp');
    const table = assignment.indexOf('FROM public.tables tb');
    const seat = assignment.indexOf('FROM public.table_seats s');
    expect(assignment.indexOf('fn_ca_lock_tournament_seat_acquisition')).toBeLessThan(roster);
    expect(table).toBeGreaterThan(roster);
    expect(seat).toBeGreaterThan(table);
    expect(assignment).toContain('INSERT INTO public.table_seats');
    expect(assignment).toContain('UPDATE public.tournament_players tp');
    expect(assignment).toContain('UPDATE public.tables tb');
    expect(assignment).toContain("'replayed',true");
    expect(assignment).toContain("'replayed',false");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?TO service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?authenticated;/
    );
  });

  it('rejects raw service seat creates, revives, and coordinate changes before row work', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF table_id,user_id,seat_number,left_at');
    expect(guard).toContain('FROM pg_catalog.pg_locks l');
    expect(guard).toContain('l.pid=pg_backend_pid()');
    expect(guard).toContain('l.objsubid=1');
    expect(guard).toContain('TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY');
    expect(guard).not.toMatch(/pg_(?:try_)?advisory/);
  });

  it('keeps the AFTER-seat sync private and removes its late global lock', () => {
    expect(sync).not.toContain('ca:tournament-terminal-settlement:v1');
    expect(sync).toContain('v_book := public.fn_spin_book_entry');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_sync_seat_first_player_count\(uuid\)[\s\S]*?service_role;/
    );
    expect(recurring.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain(
      "supabase.rpc('fn_sync_seat_first_player_count'"
    );
  });

  it('leaves launch and late registration with no raw seat/count fallback', () => {
    const launch = method(base, 'createTablesAndSeatPlayers(tournament: any)');
    const late = method(manager, 'ensureLateRegSeated()');
    for (const source of [launch, late]) {
      expect(source).toContain('assignTournamentPlayerSeatAtomically({');
      expect(source).not.toMatch(/from\('table_seats'\)[\s\S]{0,100}\.(?:insert|update|delete)\(/);
      expect(source).not.toMatch(/\.update\(\{\s*current_players:/);
    }
    expect(transport).toContain("supabase.rpc('fn_assign_tournament_player_seat_atomic'");
    expect(transport).not.toMatch(/for\s*\([^)]*attempt|\.from\(/);
  });
});
