/**
 * Static guard for the database half of tournament launch completion.
 *
 * Launch setup is intentionally several PostgREST transactions, so the
 * database must serialize every proof-shaped child write and remember why a
 * table exists.  These assertions pin the catalog contract in the migration;
 * they do not pretend row serialization is manager-generation authorization.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = join(process.cwd(), '..', 'supabase', 'migrations');
const launchChildMatches = readdirSync(migrations).filter((name) =>
  name.endsWith('_tournament_launch_children_share_the_transition_lock.sql')
);
expect(launchChildMatches).toHaveLength(1);
const MIGRATION = readFileSync(join(migrations, launchChildMatches[0] ?? ''), 'utf8');

const CAPACITY = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260907204500_late_registration_can_build_its_first_table.sql'
  ),
  'utf8'
);

const sqlFunction = (source: string, name: string): string => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = source.indexOf('$function$;', start);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(start);
  return source.slice(start, end);
};

const lock = sqlFunction(MIGRATION, 'fn_lock_tournament_launch_proof_parents');
const player = sqlFunction(MIGRATION, 'trg_lock_tournament_player_launch_proof');
const seat = sqlFunction(MIGRATION, 'trg_lock_and_validate_tournament_live_seat');
const table = sqlFunction(MIGRATION, 'trg_lock_and_classify_tournament_table');
const origin = sqlFunction(MIGRATION, 'trg_validate_tournament_table_origin');
const roster = sqlFunction(MIGRATION, 'trg_assert_live_tournament_seat_has_roster');
const capacity = sqlFunction(CAPACITY, 'fn_ensure_late_registration_capacity');

describe('tournament launch children share the transition lock', () => {
  it('locks every launch receipt before any tournament parent', () => {
    const receiptLock = lock.indexOf('FROM public.tournament_launch_receipts r');
    const parentLock = lock.indexOf('FROM public.tournaments t');

    expect(receiptLock).toBeGreaterThan(-1);
    expect(parentLock).toBeGreaterThan(receiptLock);
    expect(lock.slice(receiptLock, parentLock)).toContain('FOR UPDATE');
    expect(lock.slice(receiptLock, parentLock)).toContain('FOR UPDATE NOWAIT');
    expect(lock).toContain("USING ERRCODE = '40001'");
    expect(lock.slice(parentLock)).toContain('FOR UPDATE');
    expect(lock).toContain('ORDER BY r.tournament_id');
    expect(lock).toContain('ORDER BY t.id');
    expect(lock).toContain('r.lease_generation');
    expect(lock).toContain('r.completed_at');
  });

  it('puts proof locks on every child relation and every proof-shaped column', () => {
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER aa_tournament_player_launch_proof_lock\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.tournament_players/
    );
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER aa_tournament_live_seat_proof_lock\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.table_seats/
    );
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER aa_tournament_table_launch_proof_lock\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.tables/
    );

    for (const field of [
      'tournament_id',
      'user_id',
      'status',
      'chips',
      'table_id',
      'seat_number',
    ]) {
      expect(player, `roster proof must notice ${field}`).toContain(field);
    }
    for (const field of ['table_id', 'user_id', 'seat_number', 'stack', 'left_at']) {
      expect(seat, `seat proof must notice ${field}`).toContain(field);
    }
    for (const field of [
      'tournament_id',
      'status',
      'current_players',
      'max_players',
      'is_deleted',
    ]) {
      expect(table, `table proof must notice ${field}`).toContain(field);
    }
  });

  it('serializes and roster-proves a live seat before the existing one-live-seat trigger', () => {
    expect('aa_tournament_live_seat_proof_lock' < 'trg_one_live_seat_per_tournament').toBe(true);
    expect(seat.indexOf('fn_lock_tournament_launch_proof_parents')).toBeLessThan(
      seat.indexOf("p.status IN ('registered', 'playing')")
    );
    expect(seat).toContain('NEW.left_at IS NULL');
    expect(seat).toContain('NEW.user_id IS NOT NULL');
    expect(MIGRATION).toContain("tg.tgname = 'trg_one_live_seat_per_tournament'");
    expect(MIGRATION).toContain("'aa_tournament_live_seat_proof_lock' >= v_one_live_name");
  });

  it('keeps the active-roster invariant true at transaction commit from both sides', () => {
    expect(MIGRATION).toMatch(
      /CREATE CONSTRAINT TRIGGER tournament_live_seat_has_active_roster[\s\S]*?AFTER INSERT ON public\.table_seats[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(MIGRATION).toMatch(
      /CREATE CONSTRAINT TRIGGER tournament_live_seat_update_has_active_roster[\s\S]*?AFTER UPDATE OF table_id, user_id, left_at ON public\.table_seats[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(MIGRATION).toMatch(
      /CREATE CONSTRAINT TRIGGER tournament_roster_cannot_orphan_live_seat[\s\S]*?AFTER DELETE ON public\.tournament_players[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(MIGRATION).toMatch(
      /CREATE CONSTRAINT TRIGGER tournament_roster_update_cannot_orphan_live_seat[\s\S]*?AFTER UPDATE OF tournament_id, user_id, status ON public\.tournament_players[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(roster).toContain("p.status IN ('registered', 'playing')");
    expect(roster).toContain('s.left_at IS NULL');
    expect(roster).toContain("IN ('REGISTERING', 'RUNNING')");
  });

  it('never lets a destructive roster mutation skip the live-seat parent lock', () => {
    const mustLock = player.indexOf('v_must_lock_live_seat_invariant :=');
    const completedFastPath = player.indexOf(
      "IF TG_OP <> 'INSERT' AND NOT v_must_lock_live_seat_invariant"
    );
    const parentLock = player.indexOf('fn_lock_tournament_launch_proof_parents');

    expect(mustLock).toBeGreaterThan(-1);
    expect(completedFastPath).toBeGreaterThan(mustLock);
    expect(parentLock).toBeGreaterThan(completedFastPath);
    expect(player.slice(mustLock, completedFastPath)).toContain("TG_OP = 'DELETE'");
    expect(player.slice(mustLock, completedFastPath)).toContain(
      'NEW.tournament_id IS DISTINCT FROM OLD.tournament_id'
    );
    expect(player.slice(mustLock, completedFastPath)).toContain(
      'NEW.user_id IS DISTINCT FROM OLD.user_id'
    );
    expect(player.slice(mustLock, completedFastPath)).toContain(
      "OLD.status IN ('registered', 'playing')"
    );
    expect(player.slice(mustLock, completedFastPath)).toContain(
      "NEW.status IN ('registered', 'playing')"
    );
  });

  it('durably classifies REGISTERING table births against the exact receipt generation', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.tournament_table_origins');
    expect(MIGRATION).toContain("origin_kind IN ('prelaunch', 'capacity', 'legacy')");
    expect(table).toContain("upper(v_parent_status) = 'REGISTERING'");
    expect(table).toContain("NEW.id, NEW.tournament_id, 'prelaunch'");
    expect(table).toContain("'launch',");
    expect(table).toContain('v_launch_id');
    expect(table).toContain('v_launch_generation');
    expect(origin).toContain('r.launch_id = NEW.launch_id');
    expect(origin).toContain('r.lease_generation = NEW.launch_lease_generation');
    expect(origin).toContain('r.completed_at IS NULL');
    expect(table).not.toContain("'legacy'");
    expect(MIGRATION).toContain("'legacy',\n       NULL,\n       NULL,");
    expect(origin).toContain("ELSIF NEW.origin_kind = 'legacy' THEN");
    expect(origin.slice(origin.indexOf("ELSIF NEW.origin_kind = 'legacy' THEN"))).toContain(
      'RETURN NEW;'
    );
  });

  it('makes a raw RUNNING table fail at commit without a same-transaction capacity receipt', () => {
    const running = table.indexOf("upper(v_parent_status) = 'RUNNING'");
    const capacityOrigin = table.indexOf("NEW.id, NEW.tournament_id, 'capacity'", running);

    expect(running).toBeGreaterThan(-1);
    expect(capacityOrigin).toBeGreaterThan(running);
    expect(MIGRATION).toMatch(
      /CREATE CONSTRAINT TRIGGER tournament_table_origin_is_proven[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    );
    expect(origin).toContain('FROM public.tournament_capacity_table_receipts c');
    expect(origin).toContain('c.table_id = NEW.table_id');
    expect(origin).toContain('c.tournament_id = NEW.tournament_id');
    expect(origin).toContain('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED');
  });

  it('preserves the canonical table-then-receipt capacity transaction', () => {
    const tableInsert = capacity.indexOf('INSERT INTO public.tables');
    const receiptInsert = capacity.indexOf('INSERT INTO public.tournament_capacity_table_receipts');

    expect(tableInsert).toBeGreaterThan(-1);
    expect(receiptInsert).toBeGreaterThan(tableInsert);
    expect(origin).toContain('tournament_capacity_table_receipts');
    expect(MIGRATION).toContain(
      'canonical capacity no longer creates table then same-transaction receipt'
    );
  });

  it('turns a stale post-completion launch insert into an unproved capacity insert', () => {
    const running = table.indexOf("upper(v_parent_status) = 'RUNNING'");
    const registering = table.indexOf("upper(v_parent_status) = 'REGISTERING'");

    expect(running).toBeGreaterThan(-1);
    expect(registering).toBeGreaterThan(running);
    expect(table.slice(running, registering)).toContain("'capacity'");
    expect(table.slice(running, registering)).not.toContain("'launch'");
    expect(origin).toContain('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED');
    expect(table).toContain('STALE_TOURNAMENT_LAUNCH_TABLE');
  });

  it('keeps provenance private, immutable, and free of watcher-based correctness', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON TABLE public\.tournament_table_origins\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(MIGRATION).toContain('CREATE TRIGGER tournament_table_origin_is_immutable');
    expect(MIGRATION).toContain(
      'ALTER TABLE public.tournament_table_origins ENABLE ROW LEVEL SECURITY'
    );
    expect(MIGRATION).not.toMatch(/cron\.schedule|pg_cron|watcher/i);
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('states the remaining ownership boundary honestly', () => {
    expect(MIGRATION).toContain('This is serialization, not stale-manager authorization.');
    expect(MIGRATION).toContain('transaction-local generation marker');
  });
});
