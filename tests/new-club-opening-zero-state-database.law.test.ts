import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002152207_new_clubs_open_complete_and_reset_to_zero.sql'
  ),
  'utf8'
);
const certificate = readFileSync(
  resolve(__dirname, '../scripts/ci/certify-club-create.mjs'),
  'utf8'
);
const indexedHandChecks = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261002165000_welcome_reset_indexed_hand_checks.sql'),
  'utf8'
);
const optionalBbjPromoHistory = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002172627_welcome_reset_optional_bbj_promo_history.sql'
  ),
  'utf8'
);
const completeResetGraph = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261003021809_welcome_reset_complete_package_graph.sql'
  ),
  'utf8'
);
const satelliteTargetTypeRepair = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261003040449_welcome_graph_compares_satellite_target_types_explicitly.sql'
  ),
  'utf8'
);
const nativeHarness = readFileSync(
  resolve(__dirname, '../scripts/ci/test-club-welcome-package.py'),
  'utf8'
);

describe('new club opening package and zero-state database law', () => {
  it('creates a canonical wallet prospectively without historical backfill', () => {
    expect(migration).toContain('CREATE TRIGGER trg_create_canonical_club_wallet');
    expect(migration).toContain('AFTER INSERT ON public.clubs FOR EACH ROW');
    expect(migration).toContain('INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)');
    expect(migration).not.toMatch(/INSERT INTO public\.club_wallets[\s\S]{0,120}SELECT/);
  });

  it('preconfigures every Diamond game but never forges owner acceptance', () => {
    for (const game of ['plinko', 'crash', 'crossing', 'mines']) {
      expect(migration).toContain(`'${game}'`);
    }
    expect(migration).toContain(
      "VALUES(NEW.club_id,'club',true,100,v_version,false,false,NEW.actor_id)"
    );
    expect(migration).toContain("VALUES(NEW.club_id,v_game,'club',true,25,5000");
    expect(migration).not.toMatch(/INSERT INTO public\.diamond_spins_owner_consents/i);
    expect(migration).toContain('fn_diamond_spins_owner_agreed');
  });

  it('serializes recurrence shutdown and conserves both seeded principals', () => {
    expect(migration).toContain("IN('SPIN','SNG')");
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('WELCOME_PACKAGE_SPIN_BOARD_RETIRED');
    expect(migration).toContain('fn_spin_deactivate(p_club_id,v_actor)');
    expect(migration).toContain("'treasury_transfer','bbj_pool'");
    expect(migration).toContain("'bbj_promo_sweep'");
    expect(migration).toContain("'opening_grant_unwound',false");
    expect(migration).toContain('WELCOME_UNWIND_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED');
    expect(migration).toContain("'fn_unwind_unused_first_club_welcome_package','approved'");
    expect(migration).not.toMatch(
      /DELETE FROM public\.(chip_|bbj_|spin_|diamond_spins_owner_consents)/
    );
  });

  it('fails closed after use or economic drift and preserves idempotency', () => {
    for (const table of [
      'table_seats',
      'table_sessions',
      'tournament_players',
      'hand_history',
      'bbj_contributions',
      'bbj_payouts',
      'bbj_promo_events',
      'wheel_pools',
      'diamond_game_pools',
    ]) {
      expect(migration).toContain(`public.${table}`);
    }
    expect(migration).toContain('WELCOME_PACKAGE_ECONOMICS_ARE_NOT_PRISTINE');
    expect(migration).toContain("result->>'ok'");
    expect(migration).toContain("'requested_operation_id',p_operation_id");
  });

  it('certifies create readback and a conserved true-zero reset without retrying writes', () => {
    for (const table of [
      'club_wallets',
      'cash_games',
      'tables',
      'tournament_schedules',
      'spin_bonus_pools',
      'diamond_game_configs',
      'diamond_spins_owner_consents',
    ]) {
      expect(certificate).toContain(`.from('${table}')`);
    }
    expect(certificate).toContain("'fn_get_club_welcome_package_reset_impact'");
    expect(certificate).toContain('public.fn_remove_first_club_welcome_games');
    expect(certificate).toContain('Number(resetClubRead?.chip_treasury) !== 100000');
    expect(certificate).toContain('connectionString: databaseUrl');
    expect(certificate).toContain('SET LOCAL ROLE authenticated');
    expect(certificate).toContain("set_config('request.jwt.claims',$1::text,true)");
    expect(certificate).toContain("set_config('request.jwt.claim.sub',$2::text,true)");
    expect(certificate).toContain('SELECT pg_advisory_xact_lock(530090,1)');
    expect(certificate).toContain('SELECT 1 FROM public.clubs WHERE id=$1::uuid FOR UPDATE');
    expect(certificate).toContain('ORDER BY slot_key FOR UPDATE');
    expect(certificate).toContain('SELECT 1 FROM public.tournament_schedules');
    expect(certificate).toContain('SELECT 1 FROM public.tournament_schedule_spawns');
    expect(certificate).toContain(') ORDER BY id FOR UPDATE');
    expect(certificate).toContain('SELECT 1 FROM public.tournaments t');
    expect(certificate).toContain(') ORDER BY t.id FOR UPDATE');
    expect(certificate).toContain("await client.query('ROLLBACK')");
    expect(certificate).not.toContain("await client.query('COMMIT')");
    expect(certificate).toContain('AS tables');
    expect(certificate).toContain('AS tournaments');
    expect(certificate).toContain('AS active_managed_commands');
    const authenticatedRole = certificate.indexOf('SET LOCAL ROLE authenticated');
    const mutation = certificate.indexOf('public.fn_remove_first_club_welcome_games');
    const preimageReadRole = certificate.indexOf('SET LOCAL ROLE service_role');
    const laneLock = certificate.indexOf('SELECT pg_advisory_xact_lock(530090,1)');
    const clubLock = certificate.indexOf('SELECT 1 FROM public.clubs WHERE id=$1::uuid FOR UPDATE');
    const packageItemLocks = certificate.indexOf('ORDER BY slot_key FOR UPDATE');
    const scheduleLocks = certificate.indexOf(
      'SELECT 1 FROM public.tournament_schedules',
      packageItemLocks
    );
    const scheduleLockOrder = certificate.indexOf(') ORDER BY id FOR UPDATE', scheduleLocks);
    const spawnLocks = certificate.indexOf(
      'SELECT 1 FROM public.tournament_schedule_spawns',
      scheduleLockOrder
    );
    const spawnLockOrder = certificate.indexOf(') ORDER BY id FOR UPDATE', spawnLocks);
    const tournamentLocks = certificate.indexOf(
      'SELECT 1 FROM public.tournaments t',
      spawnLockOrder
    );
    const tournamentLockOrder = certificate.indexOf(') ORDER BY t.id FOR UPDATE', tournamentLocks);
    const preimage = certificate.indexOf('AS cash_game_ids');
    const financialReadRole = certificate.indexOf('SET LOCAL ROLE service_role', mutation);
    const readback = certificate.indexOf('AS cash_games');
    const rollback = certificate.indexOf("await client.query('ROLLBACK')");
    expect(preimageReadRole).toBeLessThan(laneLock);
    expect(laneLock).toBeLessThan(clubLock);
    expect(clubLock).toBeLessThan(packageItemLocks);
    expect(packageItemLocks).toBeLessThan(scheduleLocks);
    expect(scheduleLocks).toBeLessThan(scheduleLockOrder);
    expect(scheduleLockOrder).toBeLessThan(spawnLocks);
    expect(spawnLocks).toBeLessThan(spawnLockOrder);
    expect(spawnLockOrder).toBeLessThan(tournamentLocks);
    expect(tournamentLocks).toBeLessThan(tournamentLockOrder);
    expect(tournamentLockOrder).toBeLessThan(preimage);
    expect(preimage).toBeLessThan(authenticatedRole);
    expect(preimageReadRole).toBeLessThan(authenticatedRole);
    expect(authenticatedRole).toBeLessThan(mutation);
    expect(mutation).toBeLessThan(financialReadRole);
    expect(financialReadRole).toBeLessThan(readback);
    expect(readback).toBeLessThan(rollback);
    expect(certificate).not.toMatch(
      /retryTransient\([\s\S]{0,300}fn_remove_first_club_welcome_games/
    );
  });

  it('keeps both pristine-history gates on the existing hand-history indexes', () => {
    expect(indexedHandChecks).toContain(
      "to_regprocedure('public.fn_get_club_welcome_package_reset_impact(uuid)')"
    );
    expect(indexedHandChecks).toContain(
      "to_regprocedure('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)')"
    );
    expect(indexedHandChecks).toContain('h.tournament_id=ANY(v_tournaments)');
    expect(indexedHandChecks).toContain('h.table_id=ANY(v_tables)');
    expect(indexedHandChecks).toContain('h.tournament_id<>ALL(v_tournaments)');
    expect(indexedHandChecks).toContain('IF v_after = v_before THEN');
    expect(indexedHandChecks.match(/v_after := replace\(v_before,v_old,v_new\);/g)).toHaveLength(2);
    expect(indexedHandChecks.match(/EXECUTE v_after;/g)).toHaveLength(3);
  });

  it('reviews retained club retirement as the cross-resource global-lane authority it is', () => {
    expect(indexedHandChecks).toContain("'fn_retire_settled_club'");
    expect(indexedHandChecks).toContain('v_answer:=public.fn_ca_settlement_lane_doctrine()');
    expect(indexedHandChecks).toContain(
      'CLUB_RETIREMENT_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED'
    );
    expect(indexedHandChecks).toContain('CLUB_RETIREMENT_SETTLEMENT_LANE_DOCTRINE_FAILED');
  });

  it('uses the current pool-scoped BBJ promo identity without binding the absent legacy table', () => {
    expect(optionalBbjPromoHistory).not.toContain('CREATE TABLE');
    expect(optionalBbjPromoHistory).toContain('public.wallet_credit_idempotency i');
    expect(optionalBbjPromoHistory).toContain("i.key LIKE 'bbjpromo:'||v_bbj.id::text||':%'");
    expect(optionalBbjPromoHistory).toContain("i.key LIKE 'bbjpromo:'||b.id::text||':%'");
    expect(optionalBbjPromoHistory.match(/public\.bbj_promo_events/g)).toHaveLength(3);
    expect(optionalBbjPromoHistory.match(/EXECUTE v_after;/g)).toHaveLength(2);
    expect(optionalBbjPromoHistory).toContain(
      'WELCOME_UNWIND_BBJ_PROMO_HISTORY_REVERSE_SUBSTITUTION_FAILED'
    );
    expect(optionalBbjPromoHistory).toContain(
      'WELCOME_RESET_IMPACT_BBJ_PROMO_HISTORY_REVERSE_SUBSTITUTION_FAILED'
    );
  });

  it('restores the complete owner-scoped schedule and opening-board graph', () => {
    for (const digest of [
      '9cf532743321cafc703634efb08c3911',
      'baf9d702c714d90a697f0a1850c44389',
      '9dedf8944a2b8ea83653d6e9329362d7',
      '74d99b51f3757c9f43d797eb6b7f95da',
    ]) {
      expect(completeResetGraph).toContain(digest);
    }
    const canonicalGraphStart = completeResetGraph.indexOf(
      'v_new text := $new$WITH package_schedule_tournaments AS ('
    );
    const canonicalGraphEnd = completeResetGraph.indexOf('  ) q;$new$;', canonicalGraphStart);
    expect(canonicalGraphStart).toBeGreaterThan(-1);
    expect(canonicalGraphEnd).toBeGreaterThan(canonicalGraphStart);
    const canonicalGraph = completeResetGraph.slice(canonicalGraphStart, canonicalGraphEnd);
    expect(canonicalGraph).toContain(
      'expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS ('
    );
    expect(canonicalGraph).toContain(
      "('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)"
    );
    expect(canonicalGraph).toContain('FROM public.tournament_schedule_spawns sp');
    expect(canonicalGraph).toContain('JOIN public.tournaments t ON t.id=sp.tournament_id');
    expect(canonicalGraph).toContain('sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id');
    expect(canonicalGraph).toContain('t.satellite_target_id IS NULL');
    expect(canonicalGraph).toContain('t.satellite_target IS NULL');
    expect(canonicalGraph).toContain("upper(COALESCE(t.tournament_type::text,''))='SATELLITE'");
    expect(canonicalGraph).toContain(
      'target.id=t.satellite_target_id OR target.id::text=t.satellite_target'
    );
    expect(canonicalGraph).not.toContain("IN('SPIN','SNG','SATELLITE')");
    expect(canonicalGraph).not.toContain("IN('SPIN','SNG')");
    expect(completeResetGraph).toContain('WELCOME_PACKAGE_BOARD_LINEAGE_AMBIGUOUS');
    expect(completeResetGraph).toContain('WELCOME_RESET_COMPLETE_GRAPH_ROUNDTRIP_REFUSED');
    expect(completeResetGraph).toContain('v_metadata_after IS DISTINCT FROM v_metadata_before');
    expect(completeResetGraph).toContain('WELCOME_UNWIND_COMPLETE_GRAPH_AUTHORITY_REFUSED');
    expect(completeResetGraph).toContain('WELCOME_RESET_IMPACT_COMPLETE_GRAPH_AUTHORITY_REFUSED');
    expect(satelliteTargetTypeRepair).toContain(
      "a.attname IN('satellite_target','satellite_target_id')"
    );
    expect(satelliteTargetTypeRepair).toContain(
      "count(*)=2 AND bool_and(a.atttypid='uuid'::regtype)"
    );
    expect(satelliteTargetTypeRepair).toContain(
      'target.id=t.satellite_target_id OR target.id=t.satellite_target'
    );
    expect(satelliteTargetTypeRepair).toContain(
      "v_old text := 'target.id=t.satellite_target_id OR target.id::text=t.satellite_target'"
    );
    expect(satelliteTargetTypeRepair).toContain(
      'WELCOME_GRAPH_SATELLITE_TARGET_TYPE_ROUNDTRIP_REFUSED'
    );
    expect(satelliteTargetTypeRepair).toContain(
      'WELCOME_RESET_IMPACT_SATELLITE_TARGET_TYPE_AUTHORITY_REFUSED'
    );
    expect(nativeHarness).toContain('satellite_target_id uuid,satellite_target uuid');
    expect(nativeHarness).not.toContain('satellite_target_id uuid,satellite_target text');
  });

  it('qualifies the actual installed reset chain and exact replay behavior natively', () => {
    const reset = nativeHarness.indexOf("run('install-current-reset'");
    const indexedHands = nativeHarness.indexOf("run('install-indexed-reset-hand-checks'");
    const bbjHistory = nativeHarness.indexOf("run('install-current-bbj-promo-history'");
    const completeGraph = nativeHarness.indexOf("run('install-complete-reset-graph'");
    const completeGraphReplay = nativeHarness.indexOf("run('reinstall-complete-reset-graph'");
    const targetTypeRepair = nativeHarness.indexOf("run('install-satellite-target-type-repair'");
    const targetTypeRepairReplay = nativeHarness.indexOf(
      "run('reinstall-satellite-target-type-repair'"
    );

    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThan(indexedHands);
    expect(indexedHands).toBeLessThan(bbjHistory);
    expect(bbjHistory).toBeLessThan(completeGraph);
    expect(completeGraph).toBeLessThan(completeGraphReplay);
    expect(completeGraphReplay).toBeLessThan(targetTypeRepair);
    expect(targetTypeRepair).toBeLessThan(targetTypeRepairReplay);
    for (const testCase of [
      'complete-reset-graph-fixture',
      'complete-reset-graph-identical-lookalike-refused',
      'complete-reset-graph-satellite-materialization-lock-race',
      'complete-reset-graph-selected-row-update-lock-race',
      'complete-reset-graph-first-reset',
      'complete-reset-graph-same-operation-replay',
      'complete-reset-graph-later-operation-replay',
      'complete-reset-graph-cross-club-operation-refused',
      'complete-reset-graph-cross-club-refusal-is-atomic',
    ]) {
      expect(nativeHarness).toContain(testCase);
    }
  });
});
