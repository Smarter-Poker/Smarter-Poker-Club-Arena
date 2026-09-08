/**
 * Static contract for table-lease generations and the atomic-hand DB fence.
 *
 * The application rolls after the database, so both generations of lease and
 * settlement RPCs deliberately coexist.  These checks pin which generation
 * may mutate which protocol and the lease -> locked-table order that keeps a
 * takeover from crossing an accepted hand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908043100_table_leases_and_hand_commits_have_generations.sql'
  ),
  'utf8'
);

const ORIGINAL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
  ),
  'utf8'
);

const functionBody = (source: string, name: string, marker = ''): string => {
  const markerAt = marker ? source.indexOf(marker) : source.indexOf(`public.${name}(`);
  expect(markerAt, `${name} marker must exist`).toBeGreaterThan(-1);
  const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, markerAt);
  const end = source.indexOf('$function$;', markerAt);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(markerAt);
  return source.slice(start, end);
};

const claim = functionBody(MIGRATION, 'claim_table_lease_v2', 'p_requested_generation uuid');
const heartbeat = functionBody(MIGRATION, 'heartbeat_table_leases_v3');
const release = functionBody(MIGRATION, 'release_table_leases_v2');
const legacyClaim = functionBody(MIGRATION, 'claim_table_lease', 'p_table_id uuid');
const legacyHeartbeat = functionBody(MIGRATION, 'heartbeat_table_leases_v2');
const legacyRelease = functionBody(MIGRATION, 'release_table_leases');
const legacyHand = functionBody(
  MIGRATION,
  'fn_ca_commit_hand_settlement',
  "p_units jsonb DEFAULT '[]'::jsonb"
);
const exactHand = functionBody(
  MIGRATION,
  'fn_ca_commit_hand_settlement',
  'p_lease_generation uuid'
);
const originalHand = functionBody(ORIGINAL, 'fn_ca_commit_hand_settlement');
const dailyMissionTrigger = functionBody(ORIGINAL, 'fn_enqueue_hand_daily_missions');
const handProjector = functionBody(ORIGINAL, 'fn_project_hand_side_effects');

const lockedTableRead = 'FROM public.tables t\n   WHERE t.id = p_table_id\n   FOR UPDATE';

describe('table leases and accepted hands carry exact generations', () => {
  it('adds non-null generation and protocol columns without rewriting old authority as v2', () => {
    expect(MIGRATION).toContain(
      '20260908043100 requires the tournament lease generation migration first'
    );
    expect(MIGRATION).toContain(
      'ADD COLUMN IF NOT EXISTS lease_generation uuid DEFAULT gen_random_uuid()'
    );
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS protocol_version integer DEFAULT 1');
    expect(MIGRATION).toContain('ALTER COLUMN lease_generation SET NOT NULL');
    expect(MIGRATION).toContain('ALTER COLUMN protocol_version SET NOT NULL');
    expect(MIGRATION).toContain('SET protocol_version = 1\n WHERE protocol_version IS NULL');
    expect(MIGRATION).toContain('CHECK (protocol_version IN (1, 2))');
    expect(MIGRATION).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()'
    );
    expect(MIGRATION).toContain('SELECT 30;');
  });

  it('keeps exact claim retries stable and upgrades only same-instance protocol-1 rows', () => {
    expect(claim).toContain('p_requested_generation');
    expect(claim).toContain('l.protocol_version = 2');
    expect(claim).toContain('l.instance_id = EXCLUDED.instance_id');
    expect(claim).toContain('l.lease_generation = EXCLUDED.lease_generation');
    expect(claim).toContain('l.protocol_version < 2');
    expect(claim).toContain('lease_generation = EXCLUDED.lease_generation');
    expect(claim).toContain('protocol_version = 2');
  });

  it('cannot rotate a live v2 row to another UUID even from the same instance', () => {
    const admission = claim.slice(claim.indexOf('WHERE ('), claim.indexOf('RETURNING'));

    expect(admission).toMatch(
      /l\.protocol_version = 2[\s\S]*?l\.instance_id = EXCLUDED\.instance_id[\s\S]*?l\.lease_generation = EXCLUDED\.lease_generation/
    );
    expect(admission).toMatch(
      /l\.protocol_version < 2[\s\S]*?l\.instance_id = EXCLUDED\.instance_id/
    );
    expect(admission).not.toMatch(/OR l\.instance_id = EXCLUDED\.instance_id\s+OR/);
    expect(admission).toContain('l.heartbeat_at < clock_timestamp() - make_interval(');
    expect(admission).toContain('secs => public.fn_engine_lease_stale_seconds()');
    expect(admission).toContain('l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation');
  });

  it('allows stale foreign takeover but denies a live foreign holder', () => {
    expect(claim).toContain('l.heartbeat_at < clock_timestamp() - make_interval(');
    expect(claim).toContain('secs => public.fn_engine_lease_stale_seconds()');
    expect(claim).toContain(
      'p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds()'
    );
    expect(claim).toContain('RETURN QUERY\n    SELECT false,');
    expect(claim).toContain('v_holder');
    expect(claim).toContain('v_generation');
    expect(claim).toContain('v_protocol');
  });

  it('leaves every legacy table lease RPC callable but unable to touch protocol 2', () => {
    expect(legacyClaim).toContain('l.protocol_version < 2');
    expect(legacyClaim).toContain(
      'p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds()'
    );
    expect(legacyHeartbeat).toContain('l.protocol_version < 2');
    expect(legacyHeartbeat).toContain(
      'p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds()'
    );
    expect(legacyHeartbeat).toContain("WHEN l.protocol_version >= 2 THEN 'taken'");
    expect(legacyRelease).toContain('l.protocol_version < 2');
    expect(MIGRATION).not.toMatch(/DROP FUNCTION public\.(claim|heartbeat|release)_table_lease/);
  });

  it('heartbeats only exact claims and rejects malformed or duplicate batches before update', () => {
    const duplicate = heartbeat.indexOf('refuses duplicate tables');
    const update = heartbeat.indexOf('UPDATE public.engine_table_leases');

    expect(heartbeat).toContain("jsonb_typeof(p_claims) <> 'array'");
    expect(heartbeat).toContain(
      'p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds()'
    );
    expect(heartbeat).toContain("(item ->> 'table_id')::uuid");
    expect(heartbeat).toContain("(item ->> 'lease_generation')::uuid");
    expect(duplicate).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(duplicate);
    expect(heartbeat).toContain('l.instance_id = p_instance_id');
    expect(heartbeat).toContain('l.protocol_version = 2');
    expect(heartbeat).toContain('l.lease_generation = a.requested_generation');
    expect(heartbeat).toContain('l.heartbeat_at >= clock_timestamp() - make_interval(');
    expect(heartbeat).toContain("THEN 'stale'");
  });

  it('releases only exact claims and fails closed on malformed or duplicate batches', () => {
    const duplicate = release.indexOf('refuses duplicate tables');
    const deletion = release.indexOf('DELETE FROM public.engine_table_leases');

    expect(release).toContain("jsonb_typeof(p_claims) <> 'array'");
    expect(release).toContain("(item ->> 'table_id')::uuid");
    expect(release).toContain("(item ->> 'lease_generation')::uuid");
    expect(duplicate).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(duplicate);
    expect(release).toContain('l.instance_id = p_instance_id');
    expect(release).toContain('l.protocol_version = 2');
    expect(release).toContain('l.lease_generation = a.lease_generation');
  });

  it('keeps the audited nine-argument implementation as an owner-private core', () => {
    expect(MIGRATION).toContain('RENAME TO fn_ca_commit_hand_settlement_before_lease_generation');
    expect(MIGRATION).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation('
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_commit_hand_settlement_before_lease_generation\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(originalHand.indexOf("'replay',true")).toBeLessThan(
      originalHand.indexOf('SELECT t.tournament_id INTO v_tournament_id')
    );
  });

  it('never restores synchronous Daily Missions booking to the accepted-hand path', () => {
    expect(dailyMissionTrigger).toContain('INSERT INTO public.daily_challenge_event_outbox');
    expect(dailyMissionTrigger).toContain('ON CONFLICT (user_id,event_key) DO NOTHING');
    expect(dailyMissionTrigger).not.toContain('PERFORM public.enqueue_daily_challenge_event');
    expect(dailyMissionTrigger).not.toContain('fn_lock_daily_mission_user');
    expect(handProjector).not.toContain('PERFORM public.enqueue_daily_challenge_event');
  });

  it('lets the legacy hand door run only while its relevant lease is protocol 1', () => {
    const tournamentLease = legacyHand.indexOf('FROM public.engine_tournament_leases l');
    const tournamentParent = legacyHand.indexOf('FROM public.tournaments t', tournamentLease);
    const tableLock = legacyHand.indexOf(lockedTableRead);

    expect(legacyHand).toContain('FROM public.engine_table_leases l');
    expect(tournamentLease).toBeGreaterThan(-1);
    expect(tournamentParent).toBeGreaterThan(tournamentLease);
    expect(tableLock).toBeGreaterThan(tournamentParent);
    expect(legacyHand).toContain('v_protocol_version >= 2');
    expect(legacyHand).toContain("'reason', 'legacy_hand_protocol_closed'");
    expect(legacyHand).toContain('WHERE l.table_id = p_table_id\n     FOR SHARE');
    expect(legacyHand).toContain('WHERE l.tournament_id = v_tournament_id\n     FOR SHARE');
    expect(legacyHand).toContain(
      'RETURN public.fn_ca_commit_hand_settlement_before_lease_generation('
    );
  });

  it('derives authority and keeps the lease -> tournament parent -> table lock order', () => {
    const cashLease = exactHand.indexOf('FROM public.engine_table_leases l');
    const tournamentLease = exactHand.indexOf('FROM public.engine_tournament_leases l');
    const tournamentParent = exactHand.indexOf('FROM public.tournaments t', tournamentLease);
    const tableLock = exactHand.indexOf(lockedTableRead);

    expect(cashLease).toBeGreaterThan(-1);
    expect(tournamentLease).toBeGreaterThan(-1);
    expect(tournamentParent).toBeGreaterThan(tournamentLease);
    expect(tableLock).toBeGreaterThan(tournamentParent);
    expect(tableLock).toBeGreaterThan(cashLease);
    expect(exactHand).toContain('WHERE l.table_id = p_table_id\n     FOR SHARE');
    expect(exactHand).toContain('WHERE l.tournament_id = v_tournament_id\n     FOR SHARE');
    expect(exactHand).toContain('v_holder IS DISTINCT FROM p_instance_id');
    expect(exactHand).toContain('v_generation IS DISTINCT FROM p_lease_generation');
    expect(exactHand).toContain('v_protocol_version IS DISTINCT FROM 2');
    expect(exactHand).toContain('v_heartbeat_at < clock_timestamp() - make_interval(');
    expect(exactHand).toContain('secs => public.fn_engine_lease_stale_seconds()');
    expect(exactHand).toContain("'reason', 'hand_lease_stale'");
    expect(exactHand).toContain("v_scope := 'table'");
    expect(exactHand).toContain("v_scope := 'tournament'");
    expect(exactHand).toContain("'reason', 'hand_lease_scope_changed'");
  });

  it('delegates current-generation retries to the unchanged receipt-aware core', () => {
    expect(exactHand).toContain(
      'RETURN public.fn_ca_commit_hand_settlement_before_lease_generation('
    );
    expect(exactHand).not.toContain('INSERT INTO public.hand_atomic_commits');
    expect(legacyHand).not.toContain('INSERT INTO public.hand_atomic_commits');
    expect(MIGRATION).toContain(
      'Holding the lease row through the core preserves its atomic receipt/replay'
    );
  });

  it('publishes both rollout doors, keeps browser roles out, and uses no watcher', () => {
    for (const signature of [
      'claim_table_lease(uuid, text, text, integer)',
      'heartbeat_table_leases(text, uuid[])',
      'heartbeat_table_leases_v2(text, uuid[], integer)',
      'release_table_leases(text, uuid[])',
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${signature}\n  FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION).toContain(
        `GRANT EXECUTE ON FUNCTION public.${signature}\n  TO service_role;`
      );
    }
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(\n  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb\n) TO service_role;'
    );
    expect(MIGRATION).toContain(
      'uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid'
    );
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2');
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v3');
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.release_table_leases_v2');
    expect(MIGRATION).not.toMatch(/cron\.schedule|pg_cron|watcher/i);
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
