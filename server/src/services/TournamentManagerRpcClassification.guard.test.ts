import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');
const strictNames = readdirSync(migrations).filter((name) =>
  name.endsWith('_tournament_manager_request_fencing_is_strict.sql')
);
expect(strictNames, 'expected one strict tournament-manager migration').toHaveLength(1);
const strict = readFileSync(join(migrations, strictNames[0] ?? ''), 'utf8');
const supplyNames = readdirSync(migrations).filter(
  (name) =>
    name.endsWith('_tournament_chip_supply_is_an_immutable_conserved_ledger.sql') ||
    name.endsWith('_tournament_chip_supply_is_an_immutable_conserved_ledger.sql.pending')
);
expect(supplyNames, 'expected one tournament chip-supply migration').toHaveLength(1);
const supply = readFileSync(join(migrations, supplyNames[0] ?? ''), 'utf8');
const supplyPatch = supply.slice(
  supply.indexOf('DO $patch_strict_manager_supply_routes$'),
  supply.indexOf('$patch_strict_manager_supply_routes$;')
);
const hookStart = strict.indexOf(
  'CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()'
);
const hookEnd = strict.indexOf('$function$;', hookStart);
expect(hookStart, 'strict request hook exists').toBeGreaterThan(-1);
expect(hookEnd, 'strict request hook closes').toBeGreaterThan(hookStart);
const hook = strict.slice(hookStart, hookEnd);

function routeArray(name: string): Set<string> {
  const body = hook.match(
    new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`)
  )?.[1];
  expect(body, `${name} exists`).toBeTruthy();
  const routes = new Set([...(body ?? '').matchAll(/'rpc\/([^']+)'/g)].map((match) => match[1]));
  if (name === 'v_manager_exclusive_paths') {
    for (const match of supplyPatch.matchAll(/'rpc\/([^']+)'/g)) routes.add(match[1]);
  }
  return routes;
}

function rpcNames(path: string): string[] {
  const source = readFileSync(join(process.cwd(), 'src', path), 'utf8');
  return [
    ...source.matchAll(/\.rpc\(\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\/rpc\/([a-z0-9_]+)/g),
  ].map((match) => match[1]);
}

const managerRuntime = [
  'tournament/TournamentManagerBase.ts',
  'tournament/TournamentManager.ts',
  'tournament/TournamentManagerEliminations.ts',
  'tournament/tournamentSeatAssignmentRpc.ts',
  'tournament/tournamentSeatMoveRpc.ts',
  'tournament/satelliteSettlementRpc.ts',
  'tournament/terminalSettlementRpc.ts',
];

describe('Stage-B classifies every current tournament-manager RPC', () => {
  const managerOnly = routeArray('v_manager_exclusive_paths');
  const playerOrManager = routeArray('v_player_or_manager_paths');
  const engineService = routeArray('v_engine_service_paths');

  it('has no overlap and leaves no current manager call unclassified', () => {
    expect([...managerOnly].filter((name) => engineService.has(name))).toEqual([]);
    expect([...managerOnly].filter((name) => playerOrManager.has(name))).toEqual([]);
    expect([...playerOrManager].filter((name) => engineService.has(name))).toEqual([]);
    const calls = [...new Set(managerRuntime.flatMap(rpcNames))];
    expect(
      calls
        .filter(
          (name) => !managerOnly.has(name) && !playerOrManager.has(name) && !engineService.has(name)
        )
        .sort()
    ).toEqual([]);
  });

  it('keeps manager-only launch and seat authorities out of service recovery', () => {
    for (const name of [
      'fn_assign_tournament_player_seat_atomic',
      'fn_apply_prize_guarantee',
      'fn_ca_paid_spin_launch_entitlements',
      'fn_ca_tournament_launch_supply_version',
      'fn_move_tournament_player',
      'fn_prove_played_spin_launch_recovery',
    ]) {
      expect(managerOnly.has(name), `${name} is manager-only`).toBe(true);
      expect(engineService.has(name), `${name} is not a service route`).toBe(false);
    }
  });

  it('permits only the shared receipt helpers used by live play and recovery', () => {
    for (const name of [
      'fn_complete_tournament_terminal',
      'fn_resolve_committed_tournament_seat_move',
      'fn_resolve_tournament_terminal_outcome',
      'fn_settle_satellite_tournament',
      'fn_resolve_satellite_settlement_outcome',
    ]) {
      expect(engineService.has(name), `${name} is an identified engine route`).toBe(true);
      expect(managerOnly.has(name), `${name} remains callable by recovery`).toBe(false);
    }
  });

  it('keeps authenticated player actions disjoint from generic service authority', () => {
    expect([...playerOrManager].sort()).toEqual([
      'fn_decline_tournament_rebuy',
      'fn_mystery_bounty_reveal',
      'process_tournament_rebuy',
    ]);
    for (const name of playerOrManager) {
      expect(managerOnly.has(name), `${name} is not manager-only`).toBe(false);
      expect(engineService.has(name), `${name} rejects generic service`).toBe(false);
    }
    expect(hook).toContain('PLAYER_OR_MANAGER_AUTHORITY_REQUIRED');
    expect(hook).toMatch(
      /v_request_role = 'authenticated' AND v_actor = ''[\s\S]*v_actor = 'tournament-manager'/
    );
  });
});
