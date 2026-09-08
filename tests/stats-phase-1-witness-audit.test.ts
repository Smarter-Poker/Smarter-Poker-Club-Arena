/**
 * Stats Page Programme, phase 1: the witness audit and the health readout.
 *
 * Pins the four pieces that have to agree for the pipeline to be watched:
 * the migration (functions, grants, the cron off the :55 minute, the facts
 * split and the trigger pointed at the single-hand form), the engine wiring
 * (/health `stats`, poker_stats_* on /metrics, start and stop), the
 * Prometheus rules (the break guard on the lag rule), and the schema-manifest
 * fragment that tells CI the new names exist.
 *
 * Everything asserted here was measured live on 2026-09-04 before it was
 * written; see docs/changelog/2026-09-04-stats-phase-1-witness-audit.md.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const migrationFile = readdirSync(MIGRATIONS).find((f) =>
  f.endsWith('_stats_phase_1_witness_audit_and_health.sql')
);
const indexFile = readdirSync(MIGRATIONS).find((f) =>
  f.endsWith('_stats_phase_1_hand_player_stat_hand_id_index.sql')
);
const seatsFile = readdirSync(MIGRATIONS).find((f) =>
  f.endsWith('_stats_phase_1_every_seat_is_indexed.sql')
);
const migration = migrationFile ? readFileSync(join(MIGRATIONS, migrationFile), 'utf8') : '';
const seats = seatsFile ? readFileSync(join(MIGRATIONS, seatsFile), 'utf8') : '';

const LOOSE_UUID =
  "'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'";
const STRICT_UUID = '[1-5][0-9a-f]{3}-[89ab]';
const index = indexFile ? readFileSync(join(MIGRATIONS, indexFile), 'utf8') : '';
const gameServer = readFileSync(join(ROOT, 'server', 'src', 'GameServer.ts'), 'utf8');
const monitor = readFileSync(
  join(ROOT, 'server', 'src', 'observability', 'StatsHealthMonitor.ts'),
  'utf8'
);
const rules = readFileSync(join(ROOT, 'infra', 'monitoring', 'engine-freeze-rules.yml'), 'utf8');

describe('phase 1 migration: the facts split', () => {
  it('exists and is one transaction', () => {
    expect(migrationFile).toBeTruthy();
    expect((migration.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((migration.match(/^COMMIT;/gm) ?? []).length).toBe(1);
  });

  it('instantiates ONE body twice: a range form and a single-hand form, and keeps the 4-arg dispatcher', () => {
    expect(migration).toMatch(/__HAND_FILTER__/);
    expect(migration).toMatch(/ca_hand_player_facts_range\(/);
    expect(migration).toMatch(/'h\.created_at >= p_from AND h\.created_at < p_to'/);
    expect(migration).toMatch(/ca_hand_player_facts_one\(/);
    expect(migration).toMatch(/'h\.id = p_hand_id'/);
    // The dispatcher: plpgsql, picks by access path, never an OR on a parameter.
    const dispatcher = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.ca_hand_player_facts(')
    );
    expect(dispatcher).toMatch(/IF p_hand_id IS NOT NULL THEN/);
    expect(dispatcher).toMatch(
      /RETURN QUERY SELECT \* FROM public\.ca_hand_player_facts_one\(p_hand_id, p_user\)/
    );
    expect(dispatcher).toMatch(
      /RETURN QUERY SELECT \* FROM public\.ca_hand_player_facts_range\(p_from, p_to, p_user\)/
    );
  });

  it('the body template carries no parameter inside an OR on the hand filter (the 15x regression)', () => {
    const tmpl = migration.slice(migration.indexOf('$tmpl$'), migration.indexOf('$tmpl$;'));
    expect(tmpl).not.toMatch(/p_hand_id IS NULL AND h\.created_at/);
    expect(tmpl).not.toMatch(/OR \(p_hand_id IS NOT NULL/);
  });

  it('the pot arbitration GROUPs once and joins instead of a correlated subquery per hand', () => {
    expect(migration).toMatch(
      /pot_live AS \(\s*SELECT hand_id, sum\(live_committed\) AS s FROM money_per_player GROUP BY hand_id/
    );
    expect(migration).not.toMatch(
      /\(SELECT sum\(live_committed\) FROM money_per_player mp WHERE mp\.hand_id = mh\.id\)/
    );
  });

  it('the live trigger calls the single-hand form directly', () => {
    const trg = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()')
    );
    expect(trg).toMatch(/FROM public\.ca_hand_player_facts_one\(NEW\.id, NULL\) f/);
    expect(trg).not.toMatch(/ca_hand_player_facts\(NULL, NULL, NULL, NEW\.id\)/);
    // The hand write must land whatever the stat write does.
    expect(trg).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(trg).toMatch(/RAISE WARNING 'trg_ca_stats_live_from_hand: % \(hand %\)'/);
  });

  it('every new definer function is service_role only, PUBLIC named in the revoke', () => {
    for (const sig of [
      'ca_hand_player_facts_range(timestamptz, timestamptz, uuid)',
      'ca_hand_player_facts_one(uuid, uuid)',
      'ca_hand_player_facts(timestamptz, timestamptz, uuid, uuid)',
      'ca_stats_witness_audit(integer, integer)',
      'ca_stats_health()',
    ]) {
      const esc = sig.replace(/[()]/g, '\\$&');
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc} FROM PUBLIC, anon, authenticated;`)
      );
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc} TO service_role;`)
      );
    }
  });
});

describe('phase 1 migration: the witness audit', () => {
  it('judges the button by the small-blind poster and the showdown flag by the engine roster', () => {
    expect(migration).toMatch(/a\.action IN \('sb', 'post_sb', 'small_blind'\)/);
    expect(migration).toMatch(/WHEN sm\.n = 2 THEN p\.sb_seat/);
    expect(migration).toMatch(
      /sm\.seats\[\(\(array_position\(sm\.seats, p\.sb_seat\) - 2 \+ sm\.n\) % sm\.n\) \+ 1\]/
    );
    expect(migration).toMatch(/f\.showdown IS DISTINCT FROM EXISTS \(/);
    expect(migration).toMatch(/jsonb_array_elements\(coalesce\(h\.showdown, '\[\]'::jsonb\)\) sd/);
  });

  it('counts both coverage gaps with a write grace, humans by profiles.is_horse, and logs every run', () => {
    expect(migration).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.ca_hand_player_stat s WHERE s\.hand_id = h\.id\)/
    );
    expect(migration).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM public\.ca_hand_facts x\s*WHERE x\.hand_id = hp\.hand_id AND x\.user_id = hp\.uid/
    );
    expect(migration).toMatch(
      /JOIN public\.profiles pr ON pr\.id = hp\.uid AND NOT coalesce\(pr\.is_horse, false\)/
    );
    expect(migration).toMatch(/make_interval\(secs => greatest\(p_grace_seconds, 0\)\)/);
    expect(migration).toMatch(/INSERT INTO public\.ca_stats_witness_audit_log/);
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('the hand_id index the anti-join needs ships CONCURRENTLY in its own file, outside a transaction', () => {
    expect(indexFile).toBeTruthy();
    expect(index).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_hand_player_stat_hand_id/
    );
    expect(index).not.toMatch(/^BEGIN;/m);
    expect(indexFile! < migrationFile!).toBe(true); // the index lands first
  });

  it('is scheduled every 15 minutes, off the :55 break minute, one copy at a time, time-boxed', () => {
    expect(migration).toMatch(
      /cron\.schedule\(\s*'ca-stats-witness-audit-15m',\s*'9,24,39,54 \* \* \* \*'/
    );
    expect(migration).toMatch(/pg_try_advisory_lock\(hashtext\('ca-stats-witness-audit'\)\)/);
    expect(migration).toMatch(/set_config\('statement_timeout', '120s', true\)/);
    expect(migration).toMatch(/public\.ca_stats_witness_audit\(10, 90\)/);
  });

  it('ca_stats_health() is a cheap read: index lag, recent trigger gaps, repair cursor, last audit', () => {
    const h = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.ca_stats_health()')
    );
    expect(h).toMatch(/'indexLagSeconds'/);
    expect(h).toMatch(/'recentHandsWithoutStat'/);
    expect(h).toMatch(/'repair', \(SELECT jsonb_build_object\(/);
    expect(h).toMatch(/'lastAudit', \(SELECT jsonb_build_object\(/);
    expect(h).toMatch(/interval '3 minutes 30 seconds'/);
    expect(h).toMatch(/LANGUAGE sql\s+STABLE/);
  });
});

describe('phase 1 verification: every seat is indexed (horses are players, CLAUDE.md 10.5)', () => {
  it('exists, lands after the audit migration, and is one transaction', () => {
    expect(seatsFile).toBeTruthy();
    expect(seatsFile! > migrationFile!).toBe(true);
    expect((seats.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((seats.match(/^COMMIT;/gm) ?? []).length).toBe(1);
  });

  it('both index writers accept the same uuid shape the stat writer accepts, never the RFC 4122 filter', () => {
    const trg = seats.slice(
      seats.indexOf('CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()'),
      seats.indexOf('CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(')
    );
    const refresh = seats.slice(
      seats.indexOf('CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index('),
      seats.indexOf('CREATE TABLE IF NOT EXISTS public.ca_idx_every_seat_state')
    );
    expect(trg).toContain(LOOSE_UUID);
    expect(trg).not.toContain(STRICT_UUID);
    expect(refresh).toContain(LOOSE_UUID);
    expect(refresh).not.toContain(STRICT_UUID);
    // The index writer and the stat writer agree on who is a player.
    expect(migration).toContain(LOOSE_UUID.replace(/'/g, "'")); // seated in the facts body
  });

  it('the backfill targets exactly the seats the old regex skipped, bounded, self-unscheduling', () => {
    const fn = seats.slice(seats.indexOf('CREATE OR REPLACE FUNCTION public.ca_index_every_seat('));
    expect(fn).toContain(LOOSE_UUID);
    expect(fn).toMatch(/AND NOT pl->>'userId' ~\* '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-5\]/);
    expect(fn).toMatch(/pg_try_advisory_xact_lock\(hashtext\('ca_index_every_seat'\)\)/);
    expect(fn).toMatch(/interval '50 seconds'/);
    expect(fn).toMatch(/PERFORM cron\.unschedule\('ca-stats-idx-every-seat-1m'\)/);
    expect(seats).toMatch(/cron\.schedule\(\s*'ca-stats-idx-every-seat-1m',\s*'\* \* \* \* \*'/);
  });

  it('the audit counts seats without an index row and health reports it', () => {
    expect(seats).toMatch(
      /ADD COLUMN IF NOT EXISTS player_hands_without_idx integer NOT NULL DEFAULT 0/
    );
    expect(seats).toMatch(
      /SELECT 1 FROM public\.ca_hand_player_idx i WHERE i\.hand_id = seat\.hand_id AND i\.user_id = seat\.uid/
    );
    expect(seats).toMatch(/'playerHandsWithoutIdx', player_hands_without_idx/);
    expect(seats).toMatch(
      /'seatBackfill', \(SELECT jsonb_build_object\('done', done, 'cursorAt', cursor_at, 'rowsAdded', rows_added\)/
    );
    // The audit calls the range form directly now.
    expect(seats).toMatch(/FROM public\.ca_hand_player_facts_range\(v_from, v_to, NULL\) f/);
  });

  it('the engine treats a missing index row as a witness disagreement and exposes the gauge', () => {
    expect(monitor).toContain("'poker_stats_player_hands_without_idx'");
    expect(monitor).toMatch(/\(a\.playerHandsWithoutIdx \?\? 0\) \+/);
    expect(rules).toMatch(/or poker_stats_player_hands_without_idx > 0/);
  });
});

describe('phase 1 engine wiring', () => {
  it('GameServer owns one StatsHealthMonitor reading ca_stats_health and paused by the maintenance break', () => {
    expect(gameServer).toMatch(
      /import \{ StatsHealthMonitor \} from '\.\/observability\/StatsHealthMonitor\.js';/
    );
    expect(gameServer).toMatch(/private readonly statsHealth = new StatsHealthMonitor\(\{/);
    expect(gameServer).toMatch(/supabase\.rpc\('ca_stats_health'\)/);
    expect(gameServer).toMatch(/paused: \(\) => this\.maintenanceBreak\.isActive\(\)/);
    // Declared after the break it asks (field initialisers run in order).
    expect(
      gameServer.indexOf('private readonly maintenanceBreak = new MaintenanceBreak(')
    ).toBeLessThan(gameServer.indexOf('private readonly statsHealth = new StatsHealthMonitor('));
  });

  it('starts with the clock-skew monitor, stops with the break, publishes on /health and /metrics', () => {
    expect(gameServer).toMatch(/this\.startClockSkewMonitor\(\);\s*this\.statsHealth\.start\(\);/);
    expect(gameServer).toMatch(/\['StatsHealthMonitor', \(\) => this\.statsHealth\.stop\(\)\]/);
    expect(gameServer).toMatch(
      /beginOwnedStop\('MaintenanceBreak', \(\) => this\.maintenanceBreak\.stop\(\)\)/
    );
    expect(gameServer).toMatch(/stats: this\.statsHealth\.publish\(\),/);
    expect(gameServer).toMatch(/freeze\.push\(\.\.\.this\.statsHealth\.prometheusLines\(\)\);/);
  });

  it('the monitor raises through the engine alert path, never throws, and pages at 30 minutes of lag', () => {
    expect(monitor).toMatch(/export const STATS_INDEX_LAG_THRESHOLD_S = 30 \* 60;/);
    expect(monitor).toMatch(/lag > STATS_INDEX_LAG_THRESHOLD_S && !this\.deps\.paused\(\)/);
    expect(monitor).toMatch(/catch \(err\) \{[\s\S]*this\.lastError =/);
    for (const g of [
      'poker_stats_index_lag_seconds',
      'poker_stats_recent_hands_without_stat',
      'poker_stats_witness_disagreements',
      'poker_stats_player_hands_without_idx',
      'poker_stats_human_hands_without_facts',
      'poker_stats_money_repair_done',
      'poker_stats_health_age_seconds',
    ]) {
      expect(monitor).toContain(`'${g}'`);
    }
  });
});

describe('phase 1 alert rules', () => {
  it('the stats-pipeline group watches every gauge the engine emits, with the break guard on the clock-driven ones', () => {
    expect(rules).toMatch(/- name: stats-pipeline/);
    for (const alert of [
      'StatsHandIndexLagging',
      'StatsLiveTriggerMissingHands',
      'StatsWitnessAuditDisagrees',
      'StatsHealthReadStale',
    ]) {
      expect(rules).toMatch(new RegExp(`- alert: ${alert}`));
    }
    const lag = rules.slice(
      rules.indexOf('- alert: StatsHandIndexLagging'),
      rules.indexOf('- alert: StatsLiveTriggerMissingHands')
    );
    expect(lag).toMatch(/poker_stats_index_lag_seconds > 1800/);
    expect(lag).toMatch(/unless max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/);
    const stale = rules.slice(rules.indexOf('- alert: StatsHealthReadStale'));
    expect(stale).toMatch(/unless max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/);
  });
});

describe('phase 1 schema manifest fragment', () => {
  it('declares every new name so the CI gates know it exists before the nightly snapshot', () => {
    const p = join(ROOT, 'scripts', 'ci', 'schema-manifest.d', 'stats-phase-1.json');
    expect(existsSync(p)).toBe(true);
    const frag = JSON.parse(readFileSync(p, 'utf8')) as { tables: string[]; functions: string[] };
    expect(frag.tables).toContain('ca_stats_witness_audit_log');
    expect(frag.tables).toContain('ca_idx_every_seat_state');
    for (const fn of [
      'ca_hand_player_facts_range',
      'ca_hand_player_facts_one',
      'ca_stats_witness_audit',
      'ca_stats_health',
      'ca_index_every_seat',
    ]) {
      expect(frag.functions).toContain(fn);
    }
  });
});
