import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');
const requestAuthorityMatches = readdirSync(migrations).filter((name) =>
  name.endsWith('_tournament_manager_requests_carry_lease_authority.sql')
);
expect(requestAuthorityMatches).toHaveLength(1);
const migration = readFileSync(join(migrations, requestAuthorityMatches[0] ?? ''), 'utf8');
const actorContext = readFileSync(
  join(process.cwd(), 'src', 'services', 'supabase', 'dataActorContext.ts'),
  'utf8'
);
const client = readFileSync(
  join(process.cwd(), 'src', 'services', 'supabase', 'client.ts'),
  'utf8'
);
const gameServer = readFileSync(join(process.cwd(), 'src', 'GameServer.ts'), 'utf8');
const managerBase = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManagerBase.ts'),
  'utf8'
);
const managerImplementations = ['TournamentManager.ts', 'TournamentManagerEliminations.ts']
  .map((name) => readFileSync(join(process.cwd(), 'src', 'tournament', name), 'utf8'))
  .join('\n');

const runtimeTypescriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeTypescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });

const sqlFunction = (name: string): string => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION smarter_private.${name}(`);
  const end = migration.indexOf('$function$;', start);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must be complete`).toBeGreaterThan(start);
  return migration.slice(start, end);
};

describe('Stage-A tournament-manager Data API request fence', () => {
  it('keeps the rolling DB-first boundary explicit and does not masquerade as activation', () => {
    const hook = sqlFunction('fn_smarter_data_api_pre_request');
    expect(hook).toContain("v_actor = ''");
    expect(hook).toContain("'legacy-unmarked'");
    expect(migration).toContain('Stage A strict mode is intentionally OFF');
    expect(migration).toMatch(/Stage B is a\s+\* later, database-only activation/);
    expect(migration).not.toMatch(/cron\.schedule|pg_cron|watch(?:er|list)/i);
  });

  it('does not confuse ordinary service traffic with tournament authority', () => {
    const hook = sqlFunction('fn_smarter_data_api_pre_request');
    expect(hook).toContain("v_actor = 'service'");
    expect(hook).toContain("set_config('app.smarter_data_actor', 'service', true)");
    expect(hook).toContain("v_actor <> 'tournament-manager'");
    expect(hook).toContain("v_request_role <> 'service_role'");
    expect(hook).toContain("v_protocol <> '2'");
    expect(hook).toContain("current_setting('request.jwt.claims', true)");
    expect(hook).toContain("v_request_role := btrim(COALESCE(auth.role(), ''))");
    expect(hook).toContain(
      "v_actor <> ''\n     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', ''))"
    );
    expect(hook).toContain('verified JWT role disagrees with request claims');
    expect(hook).not.toContain('v_request_role := current_user::text');
    expect(migration).toContain('DO $prove_request_claims_not_function_owner$');
    expect(migration).toContain("current_user = 'service_role'");
    expect(migration).toContain('\'{"role":"service_role"}\'');
    expect(migration).toContain('\'{"role":"authenticated"}\'');
    expect(migration).toContain('Non-service JWT claims could forge a marked server actor');
  });

  it('validates exact protocol-2 generation and locks it through every mutation request', () => {
    const hook = sqlFunction('fn_smarter_data_api_pre_request');
    const lease = hook.indexOf('FROM public.engine_tournament_leases l');
    const exact = hook.indexOf('l.lease_generation = v_lease_generation', lease);
    const lock = hook.lastIndexOf('FOR SHARE');
    const marker = hook.indexOf("set_config(\n    'app.smarter_tournament_lease_generation'", lock);

    expect(lease).toBeGreaterThan(-1);
    expect(exact).toBeGreaterThan(lease);
    expect(lock).toBeGreaterThan(exact);
    expect(marker).toBeGreaterThan(lock);
    expect(hook).toContain('l.protocol_version = 2');
    expect(hook).toContain('TOURNAMENT_MANAGER_FENCED');
    expect(hook).toContain("v_method IN ('GET', 'HEAD', 'OPTIONS')");
    expect(hook).toContain('v_stale_seconds constant integer := 30');
    expect(hook.match(/l\.heartbeat_at >=/g)).toHaveLength(2);
    expect(hook.match(/make_interval\(secs => v_stale_seconds\)/g)).toHaveLength(2);
  });

  it('installs the hook without silently replacing an existing PostgREST pre-request', () => {
    expect(migration).toContain("setting.value LIKE 'pgrst.db_pre_request=%'");
    expect(migration).toContain('Refusing to replace existing PostgREST hook');
    expect(migration).toContain(
      "SET pgrst.db_pre_request = 'smarter_private.fn_smarter_data_api_pre_request'"
    );
    expect(migration).toContain("NOTIFY pgrst, 'reload config'");
    expect(migration).toContain("v_path = 'rpc/fn_smarter_data_api_pre_request'");
    expect(migration).toContain('TO anon, authenticated, service_role');
    expect(migration).not.toContain('TO authenticator, anon, authenticated, service_role');
    expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS smarter_private');
    expect(migration).toContain(
      'REVOKE ALL ON SCHEMA smarter_private\n' +
        '  FROM PUBLIC, anon, authenticated, service_role, authenticator;'
    );
    expect(migration).toContain(
      'GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()\n' +
        '  FROM PUBLIC, anon, authenticated, service_role, authenticator;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()\n' +
        '  TO anon, authenticated, service_role;'
    );
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request()');
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_smarter_data_api_pre_request()'
    );
    expect(migration).toContain("setting.value LIKE 'pgrst.db_schemas=%'");
    expect(migration).toContain("exposed.schema_name = 'smarter_private'");
    expect(migration).toContain('smarter_private must not be a PostgREST exposed schema');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('stamps actor authority at the shared fetch attempt, including retries', () => {
    const attemptStart = client.indexOf('const attemptOnce = async () => {');
    const attempt = client.slice(attemptStart, client.indexOf('const RETRYABLE =', attemptStart));
    expect(attemptStart).toBeGreaterThan(-1);
    expect(client).toContain("import { dataActorHeaders } from './dataActorContext.js'");
    expect(attempt).toContain('const authoritativeHeaders = dataActorHeaders(headers)');
    expect(attempt).toContain('headers: authoritativeHeaders');
    expect(actorContext).toContain('new AsyncLocalStorage<TournamentManagerActorContext>()');
    expect(actorContext).toContain('Promise.resolve(result as unknown as PromiseLike<unknown>)');
    expect(actorContext).toContain('bindTournamentDataAuthorityMethods');

    const clientCreators = runtimeTypescriptFiles(join(process.cwd(), 'src'))
      .filter((path) => readFileSync(path, 'utf8').match(/\bcreateClient\s*\(/))
      .map((path) => path.slice(join(process.cwd(), 'src').length + 1));
    expect(clientCreators).toEqual(['services/supabase/client.ts']);
  });

  /* DELIBERATE EXCEPTION (2026-09-24). Lease heartbeats leave the Data API
     for a dedicated Postgres session so they cannot queue behind game traffic
     for a PostgREST pool connection (leaseHeartbeatSession.ts). They carry no
     actor headers there, which is safe only because neither heartbeat
     function reads a request setting or auth.role(): both take their
     authority from the instance id and exact lease generation in their
     arguments. So a raw session may exist in exactly two places, and the lease
     one may run exactly those two functions and nothing that writes. */
  it('lets only lease heartbeats and the outbox LISTEN bypass the Data API on a raw session', () => {
    const src = join(process.cwd(), 'src');
    const rawSessions = runtimeTypescriptFiles(src)
      .filter((path) => /\bnew pg\.(?:Client|Pool)\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(src.length + 1))
      .sort();
    expect(rawSessions).toEqual([
      'services/leaseHeartbeatSession.ts',
      'services/supabase/handOutboxListener.ts',
    ]);

    const leaseSession = readFileSync(join(src, 'services', 'leaseHeartbeatSession.ts'), 'utf8');
    const sqlLiterals = [
      ...leaseSession.matchAll(/'((?:SELECT|SET|INSERT|UPDATE|DELETE|CALL|DO)\b[^']*)'/g),
    ].map((match) => match[1]);
    expect(sqlLiterals.length).toBeGreaterThan(0);
    for (const sql of sqlLiterals) {
      expect(sql).toMatch(/^(?:SELECT|SET)\b/);
    }
    const functionsCalled = new Set(
      [...leaseSession.matchAll(/FROM public\.(\w+)\(/g)].map((match) => match[1])
    );
    expect([...functionsCalled].sort()).toEqual([
      'heartbeat_table_leases_v4',
      'heartbeat_tournament_leases_v4',
    ]);
    expect(leaseSession).toContain(
      'SET statement_timeout = ${LEASE_HEARTBEAT_STATEMENT_TIMEOUT_MS}'
    );
  });

  it('binds managers and every tournament child before either object is published', () => {
    const admissionStart = gameServer.indexOf('private async performTournamentManagerAdmission(');
    const managerConstruction = gameServer.indexOf(
      'const manager = new TournamentManager(',
      admissionStart
    );
    const managerBinding = gameServer.indexOf(
      'bindTournamentDataAuthorityMethods(',
      managerConstruction
    );
    const managerPublication = gameServer.indexOf(
      'this.tournamentEngines.set(tournamentId, manager)',
      managerConstruction
    );
    expect(managerConstruction).toBeGreaterThan(admissionStart);
    expect(managerBinding).toBeGreaterThan(managerConstruction);
    expect(managerPublication).toBeGreaterThan(managerBinding);
    expect(gameServer.slice(managerConstruction, managerPublication)).toContain(
      'leaseGeneration: lease.leaseGeneration'
    );

    const childFactoryStart = managerBase.indexOf(
      'protected createManagedTableEngine(tableId: string): ServerTableEngine'
    );
    const childFactoryEnd = managerBase.indexOf(
      'private tournamentLeaseAuthorityIsCurrent()',
      childFactoryStart
    );
    const childFactory = managerBase.slice(childFactoryStart, childFactoryEnd);
    const childConstruction = childFactory.indexOf('const engine = new ServerTableEngine(');
    const childBinding = childFactory.indexOf(
      'return bindTournamentDataAuthorityMethods(',
      childConstruction
    );
    expect(childConstruction).toBeGreaterThan(-1);
    expect(childBinding).toBeGreaterThan(childConstruction);
    expect(childFactory.slice(childConstruction, childBinding)).toContain(
      'tournamentId: this.tournamentId'
    );
    expect(childFactory.slice(childBinding)).toContain(
      'leaseGeneration: this.tournamentLeaseGeneration'
    );

    /* The factory proof is meaningful only if every manager-owned dealer is
       forced through it.  A future raw constructor would publish an engine
       whose external GameServer/WebSocket callbacks silently fall back to the
       ordinary service actor. */
    const managerCodeOutsideFactory = [
      managerBase.slice(0, childFactoryStart),
      managerBase.slice(childFactoryEnd),
      managerImplementations,
    ].join('\n');
    expect(managerCodeOutsideFactory).not.toMatch(/\bnew\s+ServerTableEngine\s*\(/);
  });
});
