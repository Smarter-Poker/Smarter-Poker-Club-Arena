import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrationPath = (suffix: string): string => {
  const migrations = join(repo, 'supabase', 'migrations');
  const matches = readdirSync(migrations)
    .filter((name) => name.endsWith(`_${suffix}`))
    .map((name) => join(migrations, name));
  expect(matches, `expected one migration ending in ${suffix}`).toHaveLength(1);
  return matches[0] ?? '';
};

const stageAPath = migrationPath('tournament_manager_requests_carry_lease_authority.sql');
const launchChildPath = migrationPath('tournament_launch_children_share_the_transition_lock.sql');
const postCommitPath = migrationPath('post_commit_obligations_are_atomic_and_resumable.sql');
const stageBPath = migrationPath('tournament_manager_request_fencing_is_strict.sql');
const launchChild = readFileSync(launchChildPath, 'utf8');
const postCommit = readFileSync(postCommitPath, 'utf8');
const stageB = readFileSync(stageBPath, 'utf8');
const designDoc = readFileSync(
  join(repo, 'docs', 'security', '2026-09-08-tournament-manager-request-fencing.md'),
  'utf8'
);
const actorContext = readFileSync(
  join(process.cwd(), 'src', 'services', 'supabase', 'dataActorContext.ts'),
  'utf8'
);
const gameServer = readFileSync(join(process.cwd(), 'src', 'GameServer.ts'), 'utf8');
const managerBase = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManagerBase.ts'),
  'utf8'
);
const managerSources = [
  managerBase,
  readFileSync(join(process.cwd(), 'src', 'tournament', 'TournamentManager.ts'), 'utf8'),
  readFileSync(
    join(process.cwd(), 'src', 'tournament', 'TournamentManagerEliminations.ts'),
    'utf8'
  ),
  readFileSync(join(process.cwd(), 'src', 'tournament', 'atomicFinalTableDeal.ts'), 'utf8'),
  readFileSync(join(process.cwd(), 'src', 'tournament', 'atomicPlaceSettlement.ts'), 'utf8'),
  readFileSync(join(process.cwd(), 'src', 'tournament', 'settleObligation.ts'), 'utf8'),
  readFileSync(join(process.cwd(), 'src', 'tournament', 'tournamentFinishContract.ts'), 'utf8'),
  readFileSync(join(process.cwd(), 'src', 'tournament', 'tournamentRecovery.ts'), 'utf8'),
];
const recoverySource = managerSources.at(-1) ?? '';

const sqlFunction = (source: string, name: string, schema = 'public'): string => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${schema}.${name}(`);
  const end = source.indexOf('$function$;', start);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  expect(end, `${name} body is incomplete`).toBeGreaterThan(start);
  return source.slice(start, end);
};

const hook = sqlFunction(stageB, 'fn_smarter_data_api_pre_request', 'smarter_private');
const scope = sqlFunction(stageB, 'fn_assert_tournament_manager_write_scope');
const rowGuard = sqlFunction(stageB, 'trg_tournament_manager_write_scope');
const strictOrigin = sqlFunction(stageB, 'trg_validate_tournament_table_origin');

const routeArray = (name: string): Set<string> => {
  const body = hook.match(
    new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`)
  )?.[1];
  expect(body, `${name} is missing`).toBeTruthy();
  return new Set([...(body ?? '').matchAll(/'rpc\/([^']+)'/g)].map((match) => match[1]));
};

const runtimeTypescriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeTypescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });

const operationalUtilityFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return operationalUtilityFiles(path);
    return entry.isFile() && /\.(?:js|mjs|sh|ts)$/.test(entry.name) ? [path] : [];
  });

describe('Stage-B tournament-manager request fencing is a strict cutover', () => {
  it('is ordered after Stage A and installs transactionally without a runtime switch', () => {
    expect(stageAPath < postCommitPath).toBe(true);
    expect(postCommitPath < stageBPath).toBe(true);
    expect(postCommit).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(');
    expect(postCommit).toContain('p_post_commit_obligations jsonb');
    expect(postCommit).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations('
    );
    expect(postCommit).toContain(
      ') RENAME TO fn_ca_commit_hand_settlement_exact_before_obligations;'
    );
    expect(postCommit).toContain(
      'v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations('
    );
    expect(stageB.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(stageB.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(stageB).toContain("SET LOCAL lock_timeout = '1s';");
    expect(stageB).toContain("SET LOCAL statement_timeout = '30s';");
    expect(stageB).toContain('DO $require_stage_a_request_authority$');
    expect(stageB).toContain(
      'Refusing Stage-B activation over an unknown or incomplete request hook'
    );
    expect(stageB).toContain(
      'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
    );
    expect(stageB).toContain("NOTIFY pgrst, 'reload config'");
    expect(stageB).toContain("NOTIFY pgrst, 'reload schema'");
    expect(stageB).toContain(
      'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
    );
    expect(stageB).toContain(
      'REVOKE ALL ON SCHEMA smarter_private\n' +
        '  FROM PUBLIC, anon, authenticated, service_role, authenticator;'
    );
    expect(stageB).toContain(
      'GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;'
    );
    expect(stageB).toContain('DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request()');
    expect(stageB).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_smarter_data_api_pre_request()'
    );
    expect(stageB).toContain("setting.value LIKE 'pgrst.db_schemas=%'");
    expect(stageB).toContain("exposed.schema_name = 'smarter_private'");
    expect(stageB).toContain('smarter_private must not be a PostgREST exposed schema');
    expect(stageB).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+(?:MATERIALIZED\s+)?VIEW/i);
  });

  it('preserves the shared estate and fences only exact engine-private routes', () => {
    const privateRoutes = hook.indexOf('IF v_path = ANY(v_manager_exclusive_paths)');
    const unmarked = hook.indexOf("IF v_actor = '' THEN");
    const markedRole = hook.indexOf("IF v_request_role <> 'service_role'", unmarked);
    expect(privateRoutes).toBeGreaterThan(-1);
    expect(unmarked).toBeGreaterThan(-1);
    expect(privateRoutes).toBeLessThan(unmarked);
    expect(markedRole).toBeGreaterThan(unmarked);
    expect(hook.slice(unmarked, markedRole)).toContain("v_request_role = 'service_role'");
    expect(hook.slice(unmarked, markedRole)).toContain(
      "set_config('app.smarter_data_actor', 'shared-estate-service', true)"
    );
    expect(hook.slice(unmarked, markedRole)).toContain(
      "set_config('app.smarter_data_actor', 'browser', true)"
    );
    expect(hook).not.toContain('DATA_ACTOR_REQUIRED');
    expect(hook).toContain('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED');
    expect(hook).toContain('ENGINE_DATA_AUTHORITY_REQUIRED');
    expect(hook).toContain("IF left(v_path, 8) = 'rest/v1/' THEN");
    for (const managerOnly of [
      'rpc/fn_begin_tournament_launch_atomic',
      'rpc/fn_close_empty_tournament_table',
      'rpc/fn_decline_tournament_rebuy',
      'rpc/fn_settle_final_table_deal_atomic',
      'rpc/process_tournament_rebuy',
    ]) {
      expect(hook).toContain(`'${managerOnly}'`);
    }
    for (const identifiedEngine of [
      'rpc/claim_table_lease_v2',
      'rpc/claim_tournament_lease_v2',
      'rpc/fn_ack_tournament_manager_wakes',
      'rpc/fn_apply_prize_guarantee',
      'rpc/fn_ca_commit_hand_settlement',
      'rpc/fn_ca_process_hand_post_commit_obligations',
      'rpc/fn_claim_tournament_finish',
      'rpc/fn_sweep_pending_tournament_bounties',
      'rpc/fn_sync_seat_first_player_count',
    ]) {
      expect(hook).toContain(`'${identifiedEngine}'`);
    }
    expect(hook).toContain("IF v_actor = 'service' THEN");
    expect(hook).toContain("v_request_role := btrim(COALESCE(auth.role(), ''))");
    expect(hook).toContain(
      "v_actor <> ''\n     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', ''))"
    );
    expect(hook).toContain('verified JWT role disagrees with request claims');
    expect(hook).toContain("v_protocol <> '1'");
    expect(hook).toContain("v_actor <> 'tournament-manager'");
    expect(hook).toContain("v_protocol <> '2'");
    expect(hook).not.toContain('legacy-unmarked');
  });

  it('retires the Stage-A raw-table bridge behind one refusing writer boundary', () => {
    expect(launchChild).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_stage_a_bridge_legacy_capacity_receipt('
    );

    const tablesLock = stageB.indexOf(
      'LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;'
    );
    const originsLock = stageB.indexOf(
      'LOCK TABLE public.tournament_table_origins IN SHARE ROW EXCLUSIVE MODE NOWAIT;'
    );
    const receiptsLock = stageB.indexOf(
      'LOCK TABLE public.tournament_capacity_table_receipts\n' +
        '  IN SHARE ROW EXCLUSIVE MODE NOWAIT;'
    );
    const wakesLock = stageB.indexOf(
      'LOCK TABLE public.tournament_manager_wakes IN SHARE ROW EXCLUSIVE MODE NOWAIT;'
    );
    const leasesLock = stageB.indexOf(
      'LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;'
    );
    const retire = stageB.indexOf(
      'DROP FUNCTION IF EXISTS public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
    );

    expect(tablesLock).toBeGreaterThan(-1);
    expect(originsLock).toBeGreaterThan(tablesLock);
    expect(receiptsLock).toBeGreaterThan(originsLock);
    expect(wakesLock).toBeGreaterThan(receiptsLock);
    expect(leasesLock).toBeGreaterThan(wakesLock);
    expect(retire).toBeGreaterThan(leasesLock);
    expect(stageB.slice(leasesLock, retire)).toContain('l.protocol_version = 1');
    expect(stageB.slice(leasesLock, retire)).toContain("interval '30 seconds'");
    expect(stageB.slice(leasesLock, retire)).toContain(
      'a fresh protocol-1 tournament manager still owns a lease'
    );
    expect(stageB.slice(retire, retire + 140)).toContain('RESTRICT;');
    expect(strictOrigin).toContain('tournament_capacity_table_receipts');
    expect(strictOrigin).toContain('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED');
    expect(strictOrigin).not.toContain('fn_stage_a_bridge_legacy_capacity_receipt');
    expect(stageB).toContain('Stage-B found a capacity origin without durable receipt provenance');
  });

  it('holds one exact fresh manager generation for every mutation transaction', () => {
    const lease = hook.indexOf('FROM public.engine_tournament_leases l');
    const exact = hook.indexOf('l.lease_generation = v_lease_generation', lease);
    const fresh = hook.indexOf('l.heartbeat_at >=', exact);
    const lock = hook.indexOf('FOR SHARE;', fresh);
    const actor = hook.indexOf(
      "set_config('app.smarter_data_actor', 'tournament-manager', true)",
      lock
    );
    expect(lease).toBeGreaterThan(-1);
    expect(exact).toBeGreaterThan(lease);
    expect(fresh).toBeGreaterThan(exact);
    expect(lock).toBeGreaterThan(fresh);
    expect(actor).toBeGreaterThan(lock);
    expect(hook).toContain("v_method IN ('GET', 'HEAD', 'OPTIONS')");
    expect(hook).toContain('v_stale_seconds constant integer := 30');
    const proof = hook.indexOf(
      "set_config('app.smarter_manager_request_fenced', 'protocol-2', true)"
    );
    expect(proof).toBeGreaterThan(actor);
  });

  it('classifies every manager RPC and only shares audited recovery routes', () => {
    const managerOnly = routeArray('v_manager_exclusive_paths');
    const engineService = routeArray('v_engine_service_paths');
    const overlap = [...managerOnly].filter((name) => engineService.has(name));
    expect(overlap).toEqual([]);

    const managerRpcs = new Set(
      managerSources.flatMap((source) => [
        ...[...source.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
        ...[...source.matchAll(/=\s*['"](fn_[^'"]+)['"]\s+as const/g)].map((match) => match[1]),
      ])
    );
    const unclassified = [...managerRpcs]
      .filter((name) => !managerOnly.has(name) && !engineService.has(name))
      .sort();
    expect(unclassified).toEqual([]);
    for (const name of managerRpcs) expect(designDoc).toContain(`\`${name}\``);
    expect(designDoc).toContain('`fn_decline_tournament_rebuy`');
    expect(designDoc).toContain('`fn_ca_process_hand_post_commit_obligations(uuid)`');

    const managerCallsAllowedAsService = [...managerRpcs]
      .filter((name) => engineService.has(name))
      .sort();
    expect(managerCallsAllowedAsService).toEqual([
      'fn_apply_prize_guarantee',
      'fn_certify_tournament_finish',
      'fn_claim_tournament_finish',
      'fn_finalize_bounty_pool',
      'fn_mystery_bounty_settle',
      'fn_normalize_tournament_final_standings',
      'fn_prepare_tournament_place_obligations',
      'fn_settle_satellite_finish_atomic',
      'fn_settle_tournament_obligation',
      'fn_settle_tournament_places_atomic',
      'fn_settle_tournament_rake',
      'fn_sweep_pending_tournament_bounties',
      'fn_sync_seat_first_player_count',
    ]);
    expect(managerOnly.has('fn_decline_tournament_rebuy')).toBe(true);
    expect(managerOnly.has('fn_close_empty_tournament_table')).toBe(true);
    expect(managerOnly.has('fn_settle_final_table_deal_atomic')).toBe(true);

    const recoveryRpcs = new Set([
      ...[...recoverySource.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
      ...[...recoverySource.matchAll(/=\s*['"](fn_[^'"]+)['"]\s+as const/g)].map(
        (match) => match[1]
      ),
      'fn_claim_tournament_finish',
      'fn_prepare_tournament_place_obligations',
      'fn_settle_tournament_obligation',
      'fn_settle_tournament_places_atomic',
    ]);
    expect([...recoveryRpcs].filter((name) => !engineService.has(name)).sort()).toEqual([]);
  });

  it('scopes marked manager rows using the transaction proof from the request hook', () => {
    expect(scope).toContain(
      "current_setting('app.smarter_data_actor', true)\n       IS DISTINCT FROM 'tournament-manager'"
    );
    expect(scope).toContain("current_setting('app.smarter_tournament_id', true)");
    expect(scope).toContain("current_setting('app.smarter_tournament_lease_generation', true)");
    expect(scope).toContain("current_setting('app.smarter_manager_request_fenced', true)");
    expect(scope).toContain("IS DISTINCT FROM 'protocol-2'");
    expect(scope).toContain('p_tournament_id IS DISTINCT FROM v_tournament_id');
    expect(scope).not.toContain('FROM public.engine_tournament_leases');
    expect(scope).not.toContain('FOR SHARE');

    for (const relation of ['tournaments', 'tournament_players', 'tables', 'table_seats']) {
      expect(stageB).toMatch(
        new RegExp(
          `CREATE TRIGGER a0_tournament_manager_write_scope\\s+BEFORE INSERT OR UPDATE OR DELETE ON public\\.${relation}`
        )
      );
    }
    expect(rowGuard).toContain("TG_TABLE_NAME = 'tournaments'");
    expect(rowGuard).toContain("TG_TABLE_NAME = 'tournament_players'");
    expect(rowGuard).toContain("TG_TABLE_NAME = 'tables'");
    expect(rowGuard).toContain("TG_TABLE_NAME = 'table_seats'");
    expect(rowGuard).toContain('FROM public.tables t');
    expect(rowGuard).toContain('fn_assert_tournament_manager_write_scope');
    expect(rowGuard).toContain('pg_trigger_depth() > 1');
    expect(rowGuard).toContain('app.smarter_manager_deleted_table_ids');
    expect(rowGuard).toContain('OLD.table_id = ANY(v_deleted_table_ids)');
    expect(rowGuard).toContain('array_append(v_deleted_table_ids, OLD.id)');
    expect(stageB).toContain('manager authority must lock the lease before the existing `aa_`');
  });

  it('removes every generation-blind tournament, table, launch and hand door', () => {
    for (const signature of [
      'claim_tournament_lease(uuid, text, text, integer)',
      'heartbeat_tournament_leases_v2(text, uuid[], integer)',
      'heartbeat_tournament_leases(text, uuid[])',
      'release_tournament_leases(text, uuid[])',
      'fn_begin_tournament_launch_atomic(\n  uuid, uuid, timestamptz\n)',
      'fn_complete_tournament_launch_atomic(uuid, uuid)',
      'claim_table_lease(uuid, text, text, integer)',
      'heartbeat_table_leases_v2(text, uuid[], integer)',
      'heartbeat_table_leases(text, uuid[])',
      'release_table_leases(text, uuid[])',
      'fn_ca_commit_hand_settlement(\n  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb\n)',
      'fn_ca_commit_hand_settlement(\n  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid\n)',
    ]) {
      expect(stageB).toContain(`DROP FUNCTION IF EXISTS public.${signature}`);
    }
    expect(stageB).not.toMatch(/DROP FUNCTION[^;]+CASCADE/i);
    expect(stageB).toMatch(
      /REVOKE ALL ON TABLE public\.engine_tournament_leases\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(stageB).toMatch(
      /REVOKE ALL ON TABLE public\.engine_table_leases\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    for (const exact of [
      'claim_tournament_lease_v2',
      'heartbeat_tournament_leases_v3',
      'release_tournament_leases_v2',
      'claim_table_lease_v2',
      'heartbeat_table_leases_v3',
      'release_table_leases_v2',
      'fn_ca_commit_hand_settlement',
      'fn_ca_process_hand_post_commit_obligations',
    ]) {
      expect(stageB).toContain(`GRANT EXECUTE ON FUNCTION public.${exact}`);
    }
    expect(stageB).toContain(
      'fn_ca_commit_hand_settlement(\n  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,\n  jsonb\n) TO service_role;'
    );
    expect(stageB).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)\n  TO service_role;'
    );
    expect(stageB).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations('
    );
    expect(stageB).not.toMatch(
      /DROP FUNCTION[^;]+fn_ca_commit_hand_settlement_exact_before_obligations/i
    );
  });

  it('keeps the sole runtime client factory stamped and every manager owner-bound', () => {
    expect(actorContext).toContain('new AsyncLocalStorage<TournamentManagerActorContext>()');
    expect(actorContext).toContain('headers.set(DATA_ACTOR_HEADER, SERVICE_DATA_ACTOR)');
    expect(actorContext).toContain('headers.set(DATA_ACTOR_HEADER, TOURNAMENT_MANAGER_DATA_ACTOR)');
    expect(actorContext).toContain('bindTournamentDataAuthorityMethods');
    expect(gameServer).toContain('bindTournamentDataAuthorityMethods(');
    expect(managerBase).toContain('return bindTournamentDataAuthorityMethods(');

    const creators = runtimeTypescriptFiles(join(process.cwd(), 'src'))
      .filter((path) => readFileSync(path, 'utf8').match(/\bcreateClient\s*\(/))
      .map((path) => path.slice(join(process.cwd(), 'src').length + 1));
    expect(creators).toEqual(['services/supabase/client.ts']);
  });

  it('keeps in-repo service-role Data API utilities explicitly classified', () => {
    const utilityRoots = [
      join(repo, '.github', 'scripts'),
      join(repo, 'e2e-live'),
      join(repo, 'scripts'),
      join(repo, 'server', 'scripts'),
      join(repo, 'services'),
      join(repo, 'supabase'),
    ];
    const utilityFiles = utilityRoots.flatMap(operationalUtilityFiles);
    utilityFiles.push(join(repo, 'check_messages_schema.ts'));

    const candidates = [...new Set(utilityFiles)]
      .filter((path) => !path.endsWith('.test.ts'))
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return (
          /(?:VITE_)?SUPABASE_SERVICE_ROLE_KEY/.test(source) &&
          /(?:\/rest\/v1|\bcreateClient\s*\()/.test(source)
        );
      });
    const storageOnly = candidates.filter((path) =>
      path.endsWith('scripts/upload_buttons/upload.js')
    );
    expect(storageOnly).toHaveLength(1);

    const unstamped = candidates
      .filter((path) => !storageOnly.includes(path))
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return !(
          source.includes('supabaseServerHeaders') ||
          source.includes('dataActorHeaders') ||
          (source.includes("'x-smarter-data-actor': 'service'") &&
            source.includes("'x-smarter-data-protocol': '1'")) ||
          (source.includes("'x-smarter-data-actor: service'") &&
            source.includes("'x-smarter-data-protocol: 1'"))
        );
      })
      .map((path) => path.slice(repo.length + 1));
    expect(unstamped).toEqual([]);

    const customizationE2e = readFileSync(
      join(repo, 'tests', 'e2e', 'support', 'temporaryCustomizationAccount.ts'),
      'utf8'
    );
    expect(customizationE2e).toContain("'x-smarter-data-actor': 'service'");
    expect(customizationE2e).toContain("'x-smarter-data-protocol': '1'");
  });

  it('documents the only safe activation and rollback order', () => {
    expect(stageB).toContain('exact Stage-A engine build is the sole running build');
    expect(stageB).toContain('unrelated shared-estate service traffic stays valid');
    expect(stageB).toContain('ROLLBACK ORDER');
    expect(stageB).toContain('restore the Stage-A hook first');
    expect(stageB).toContain('Normal rollback is a new');
    expect(stageB).toContain('audited migration.');
  });
});
