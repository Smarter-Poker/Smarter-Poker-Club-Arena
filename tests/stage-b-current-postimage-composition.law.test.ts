import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migrationsDirectory = resolve(root, 'supabase/migrations');

function stagedMigration(suffix: string): string {
  const matches = readdirSync(migrationsDirectory).filter((file) =>
    file.endsWith(`_${suffix}.sql`)
  );
  expect(matches, `${suffix} migration`).toHaveLength(1);
  return readFileSync(resolve(migrationsDirectory, matches[0]), 'utf8');
}

const lanePostimage = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql'
  ),
  'utf8'
);
const contraction = readFileSync(
  resolve(root, 'supabase/migrations/20260910055955_stage_b_current_postimage_contraction.sql'),
  'utf8'
);
const oneSeatWritePostimage = readFileSync(
  resolve(root, 'supabase/migrations/20260910054712_a_hand_settles_each_seat_once.sql'),
  'utf8'
);
const cashoutPostimage = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql'
  ),
  'utf8'
);
const contractionCode = contraction.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
const stageBOneThroughFive = [
  'stage_b_forward_authority_expansion',
  'stage_b_exact_precondition_repairs',
  'stage_b_terminal_break_invariant',
  'stage_b_atomic_finish_precertification',
  'stage_b_current_postimage_contraction',
]
  .map(stagedMigration)
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*--.*$/gm, '');

const planStart = lanePostimage.indexOf('v_plan CONSTANT jsonb := jsonb_build_object(');
const planEnd = lanePostimage.indexOf('\n  );', planStart);
if (planStart < 0 || planEnd <= planStart) {
  throw new Error('the 035435 settlement-lane rewrite plan is missing');
}
const plan = [
  ...lanePostimage.slice(planStart, planEnd).matchAll(/'([a-z0-9_]+)'\s*,\s*'([^']+)'/g),
].map(([, name, replacement]) => ({ name, replacement }));

function operationIndexes(name: string): {
  creates: number[];
  removals: number[];
} {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const creates = [
    ...contractionCode.matchAll(
      new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+public\\.${escaped}\\s*\\(`, 'g')
    ),
  ].map((match) => match.index ?? -1);
  const drops = [
    ...contractionCode.matchAll(
      new RegExp(`DROP FUNCTION(?: IF EXISTS)?\\s+public\\.${escaped}\\s*\\(`, 'g')
    ),
  ].map((match) => match.index ?? -1);
  const renames = [
    ...contractionCode.matchAll(
      new RegExp(`ALTER FUNCTION\\s+public\\.${escaped}\\s*\\([^;]*?\\)\\s+RENAME TO`, 'gs')
    ),
  ].map((match) => match.index ?? -1);
  return { creates, removals: [...drops, ...renames].sort((left, right) => left - right) };
}

function functionDefinitionAt(start: number): string {
  const header = contractionCode.slice(start);
  const delimiterMatch = /\bAS\s+(\$[a-zA-Z0-9_]*\$)/.exec(header);
  if (!delimiterMatch || delimiterMatch.index === undefined) return '';
  const delimiter = delimiterMatch[1];
  const bodyStart = start + delimiterMatch.index + delimiterMatch[0].length;
  const bodyEnd = contractionCode.indexOf(`${delimiter};`, bodyStart);
  return bodyEnd < 0 ? '' : contractionCode.slice(start, bodyEnd + delimiter.length + 1);
}

const compact = (source: string): string => source.replace(/\s+/g, ' ').trim();

function survivingFunctionDefinition(name: string): string {
  const { creates, removals } = operationIndexes(name);
  const finalCreate = creates.at(-1) ?? -1;
  const finalRemoval = removals.at(-1) ?? -1;
  if (finalCreate < 0 || finalRemoval > finalCreate) return '';
  return functionDefinitionAt(finalCreate);
}

function countNeedle(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function dollarBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const start = contractionCode.indexOf(delimiter);
  const end = contractionCode.indexOf(delimiter, start + delimiter.length);
  expect(start, `opening ${delimiter}`).toBeGreaterThanOrEqual(0);
  expect(end, `closing ${delimiter}`).toBeGreaterThan(start);
  return contractionCode.slice(start + delimiter.length, end);
}

function migrationFunctionSource(source: string, name: string): string {
  const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`${name} is missing from its measured migration`);
  const header = source.slice(start);
  const delimiterMatch = /\bAS\s+(\$[a-zA-Z0-9_]*\$)/.exec(header);
  if (!delimiterMatch || delimiterMatch.index === undefined) {
    throw new Error(`${name} does not have a statically delimited body`);
  }
  const delimiter = delimiterMatch[1];
  const bodyStart = start + delimiterMatch.index + delimiterMatch[0].length;
  const bodyEnd = source.indexOf(delimiter, bodyStart);
  if (bodyEnd < 0) throw new Error(`${name} has no closing ${delimiter}`);
  return source.slice(bodyStart, bodyEnd);
}

const md5 = (source: string): string => createHash('md5').update(source).digest('hex');

const indirectTerminalWrappers = new Set([
  'atomic_cancel_tournament',
  'fn_complete_tournament_terminal',
]);

describe('Stage-B contraction preserves the exact current production tail', () => {
  it('pins the two later function bodies that the current-tail guard does not replace', () => {
    const postcondition = dollarBody('verify_current_postimage_contraction');

    for (const [identity, sourceHash] of [
      [
        'public.fn_active_maintenance_release_boundary()' as const,
        '66f0ca0e4ebf27a74dd4b7c211c4fd0f',
      ],
      [
        'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)' as const,
        '05855868cb0cbb1199049b5e0e97aa56',
      ],
    ]) {
      expect(compact(postcondition)).toContain(
        compact(`('${identity}'::regprocedure, '${sourceHash}'::text)`)
      );
      expect(countNeedle(postcondition, sourceHash)).toBe(1);
    }

    // These are the immediately superseded 034411 maintenance and pre-072322
    // eliminator hashes. Accepting either would silently certify a stale tail.
    expect(postcondition).not.toContain('9e66fb8c6cbecfa67fb91a924723a797');
    expect(postcondition).not.toContain('421488851cad34b81b8fea7f2f796fed');
  });

  it('never recreates or drops either preserved body in boundaries one through five', () => {
    for (const name of [
      'fn_active_maintenance_release_boundary',
      'fn_ca_eliminate_absent_tournament_players',
    ]) {
      expect(stageBOneThroughFive).not.toMatch(
        new RegExp(`(?:CREATE(?: OR REPLACE)?|DROP) FUNCTION\\s+public\\.${name}\\s*\\(`)
      );
    }
  });
});

describe('Stage-B contraction preserves the 035435 per-tournament settlement lanes', () => {
  it('derives one unique thirty-function topology from the live migration', () => {
    expect(plan).toHaveLength(30);
    expect(new Set(plan.map(({ name }) => name)).size).toBe(30);
    expect(
      plan.filter(({ replacement }) => replacement.includes('lane_for_tournament'))
    ).toHaveLength(8);
    expect(plan.filter(({ replacement }) => replacement.includes('lane_global'))).toHaveLength(20);
    expect(
      plan.filter(({ replacement }) => replacement.includes('share_settlement_lane'))
    ).toHaveLength(2);
  });

  it('leaves every surviving final definition on its 035435 lane helper', () => {
    const violations: string[] = [];
    let redefined = 0;

    for (const { name, replacement } of plan) {
      const { creates, removals } = operationIndexes(name);
      const finalCreate = creates.at(-1) ?? -1;
      const finalRemoval = removals.at(-1) ?? -1;

      // A function absent from the contraction survives the already-installed
      // 035435 body. A later DROP/RENAME is an intentional retirement. Only a
      // surviving replacement can accidentally restore the platform-wide key.
      if (finalCreate < 0 || finalRemoval > finalCreate) continue;
      redefined += 1;
      const definition = functionDefinitionAt(finalCreate);
      if (!definition) {
        violations.push(`${name}: final definition is not statically delimited`);
        continue;
      }
      if (
        !indirectTerminalWrappers.has(name) &&
        !compact(definition).includes(compact(replacement))
      ) {
        violations.push(`${name}: missing ${replacement}`);
      }
      if (
        /pg_advisory_xact_lock(?:_shared)?\s*\(\s*hashtextextended\s*\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)/.test(
          definition
        )
      ) {
        violations.push(`${name}: restored the direct platform-wide settlement key`);
      }
    }

    expect(redefined).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('keeps terminal wrappers on the mixed opener and their private cores on G plus B', () => {
    const opener = survivingFunctionDefinition('fn_ca_open_tournament_seat_exit_authority');
    expect(opener).not.toBe('');
    expect(countNeedle(opener, 'public.fn_ca_lock_settlement_lane_global()')).toBe(1);
    expect(
      countNeedle(opener, 'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)')
    ).toBe(1);
    expect(compact(opener)).toContain(
      "p_operation IN ('cancel','satellite_finish','terminal_finish')"
    );

    for (const [name, operation, core] of [
      ['atomic_cancel_tournament', 'cancel', 'atomic_cancel_tournament_pre_seat_guard'],
      [
        'fn_complete_tournament_terminal',
        'terminal_finish',
        'fn_complete_tournament_terminal_pre_seat_guard',
      ],
    ] as const) {
      const wrapper = survivingFunctionDefinition(name);
      expect(wrapper, `${name} wrapper`).not.toBe('');
      expect(compact(wrapper)).toContain(
        compact(
          `public.fn_ca_open_tournament_seat_exit_authority(
             p_tournament_id,'${operation}',NULL)`
        )
      );
      expect(wrapper).toContain(`public.${core}(`);
      expect(wrapper).not.toContain('public.fn_ca_lock_settlement_lane_global()');
      expect(contractionCode).toMatch(
        new RegExp(`ALTER FUNCTION public\\.${name}\\([^;]+?\\)\\s+RENAME TO ${core};`, 's')
      );
      expect(contractionCode).not.toMatch(
        new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+public\\.${core}\\s*\\(`)
      );
    }

    const satellite = survivingFunctionDefinition('fn_settle_satellite_tournament');
    expect(satellite).not.toBe('');
    expect(compact(satellite)).toContain(
      compact(
        `public.fn_ca_open_tournament_seat_exit_authority(
           p_tournament_id,'satellite_finish',NULL)`
      )
    );
    expect(satellite).toContain('public.fn_settle_satellite_tournament_seat_exit_core_v2(');
    expect(countNeedle(satellite, 'public.fn_ca_lock_settlement_lane_global()')).toBe(1);
    expect(contractionCode).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION\s+public\.fn_settle_satellite_tournament_seat_exit_core_v2\s*\(/
    );

    for (const coreIdentity of [
      'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)',
      'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
      'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
    ]) {
      expect(compact(contractionCode)).toContain(
        compact(
          `('${coreIdentity}'::regprocedure,
             'public.fn_ca_lock_settlement_lane_global()'::text)`
        )
      );
    }

    const postcondition = dollarBody('verify_current_postimage_contraction');
    expect(postcondition).toContain(
      "'public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)'::regprocedure"
    );
    expect(postcondition).toContain("'public.fn_settle_satellite_tournament_pre_money_path_gate('");
    expect(postcondition).toContain("position('fn_ca_lock_settlement_lane_global' IN p.prosrc)=0");

    expect(plan.find(({ name }) => name === 'atomic_cancel_tournament')?.replacement).toBe(
      'PERFORM public.fn_ca_lock_settlement_lane_global();'
    );
    expect(plan.find(({ name }) => name === 'fn_complete_tournament_terminal')?.replacement).toBe(
      'PERFORM public.fn_ca_lock_settlement_lane_global();'
    );
    expect(
      plan.find(({ name }) => name === 'fn_settle_satellite_tournament_pre_money_path_gate')
        ?.replacement
    ).toBe('PERFORM public.fn_ca_lock_settlement_lane_global();');
  });

  it('keeps raw G acquisitions at the three intentional transaction fences only', () => {
    expect(
      contractionCode.match(
        /SELECT\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;/g
      )
    ).toHaveLength(3);
  });

  it('does not remove the three 035435 lane helpers', () => {
    for (const helper of [
      'fn_ca_lock_settlement_lane_global',
      'fn_ca_lock_settlement_lane_for_tournament',
      'fn_ca_share_settlement_lane_for_table',
    ]) {
      expect(contractionCode).not.toMatch(
        new RegExp(`(?:DROP|ALTER) FUNCTION(?: IF EXISTS)?\\s+public\\.${helper}\\s*\\(`)
      );
    }
  });

  it('authenticates the exact helper catalog shape and two-principal ACL', () => {
    const preflight = dollarBody('require_scoped_settlement_lane_postimage');

    expect(preflight).toContain("v_postgres oid := 'postgres'::regrole");
    expect(preflight).toContain("v_service_role oid := 'service_role'::regrole");
    expect(countNeedle(preflight, 'AND NOT p.proisstrict AND NOT p.proleakproof')).toBe(3);
    expect(
      countNeedle(preflight, "AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f'")
    ).toBe(3);
    expect(countNeedle(preflight, 'AND p.proowner=v_postgres')).toBe(3);

    expect(preflight).toContain('LEFT JOIN LATERAL aclexplode(p.proacl) acl ON true');
    expect(preflight).toContain('WHERE p.oid IN (v_global,v_tournament,v_hand)');
    expect(preflight).toContain('HAVING count(acl.grantee)<>2');
    expect(countNeedle(preflight, 'acl.grantor=v_postgres')).toBe(2);
    expect(countNeedle(preflight, 'acl.grantee=v_postgres')).toBe(1);
    expect(countNeedle(preflight, 'acl.grantee=v_service_role')).toBe(1);
    expect(countNeedle(preflight, "acl.privilege_type='EXECUTE'")).toBe(2);
    expect(countNeedle(preflight, 'AND NOT acl.is_grantable')).toBe(2);
  });

  it('composes over the exact 063559 and 064701 busy-manager postimages', () => {
    const preflight = dollarBody('require_stage_a_request_authority');
    const finalProof = dollarBody('verify_current_postimage_contraction');
    const managerProof = dollarBody('assert_strict_manager_request_fence');

    for (const provenance of [
      '20260910063559',
      'a_busy_manager_keeps_its_lease',
      '2e95299dd7693a09ee310a4086b2dcdf16f0f942582007bdede0c4c81024e07d',
      '20260910064701',
      'a_hand_commit_does_not_hold_the_lease_against_its_own_heartb',
      '5816d16550ef470f9359cae427aec0c5346df92f5c6d35b07385def4ab9b4c04',
    ]) {
      expect(preflight).toContain(provenance);
    }

    for (const [definitionHash, sourceHash] of [
      ['c57716917b5ec20ccdf19c90e7a86427', 'ab227471f29f2944ebd64909622b6af7'],
      ['73abfc4523de42cb4b8bca5443602cbd', 'd1b5100c2b9f92bec5fd1680b0b4f230'],
      ['4a41b0124e75e46ed8121e6a56014758', '5e6c99545e07c21efcb50e5cb3441c14'],
      ['e3a2120fc6db33ad84fc4967126fe9b8', '457ad8f1e1528ad205f7bd43488f3e14'],
      ['276314a02cecc35607cde1afdc2fdf21', '8ab94f005d1dcc695c7094eec3fd279d'],
      ['0af954ab1264dc12ebce7741b7845343', '4abef1a7ccd6d56c2523fe6cb02396b6'],
    ]) {
      expect(preflight).toContain(definitionHash);
      expect(preflight).toContain(sourceHash);
    }

    expect(preflight).toContain('$manager_write_lease_pattern$');
    expect(preflight).toContain(
      "v_hook_semantic := regexp_replace(v_source, '/\\*.*?\\*/', ' ', 'gs')"
    );
    expect(preflight).toContain('v_hook_semantic !~ v_manager_write_lease_pattern');
    expect(preflight).toContain('FOR[[:space:]]+KEY[[:space:]]+SHARE[[:space:]]*;');
    expect(preflight).toContain('FOR UPDATE;\\n\\n');
    expect(preflight).toContain('FOR NO KEY UPDATE OF l SKIP LOCKED');
    expect(contraction).toContain('Preserve 20260910063559');
    expect(managerProof).toContain(
      "v_hook_semantic := regexp_replace(v_hook_source, '/\\*.*?\\*/', ' ', 'gs')"
    );
    expect(managerProof).toContain('v_hook_semantic !~ v_manager_write_lease_pattern');
    expect(managerProof).toContain(
      "v_hook_semantic ~\n          'engine_tournament_leases[[:space:]]+l[[:space:]][^;]*FOR[[:space:]]+SHARE[[:space:]]*;'"
    );
    expect(contraction).toContain('engine_tournament_leases[[:space:]]+l');
    expect(operationIndexes('claim_tournament_lease_v2')).toEqual({ creates: [], removals: [] });

    for (const sourceHash of [
      'd1b5100c2b9f92bec5fd1680b0b4f230',
      '5e6c99545e07c21efcb50e5cb3441c14',
      '457ad8f1e1528ad205f7bd43488f3e14',
      '8ab94f005d1dcc695c7094eec3fd279d',
      '4abef1a7ccd6d56c2523fe6cb02396b6',
    ]) {
      expect(finalProof).toContain(sourceHash);
    }
  });

  it('authenticates only the exact 20260910054712 one-seat-write production postimage', () => {
    const innerSource = migrationFunctionSource(
      oneSeatWritePostimage,
      'fn_ca_settle_hand_stacks_absolute'
    );
    const outerSource = migrationFunctionSource(
      oneSeatWritePostimage,
      'fn_ca_commit_hand_settlement'
    );
    expect(md5(innerSource)).toBe('e67e89b3aec325f8038e0507a1511eec');
    expect(md5(outerSource)).toBe('0ef3c57a6a31acc383ce4b95a0f9519f');

    const authorityPreflight = dollarBody('require_stage_a_request_authority');
    expect(authorityPreflight).toContain('2c5f04ae307d38f187b8b72a3f557738');
    expect(authorityPreflight).toContain('a1738adaf943656868e68a7bf7ce8d1e');
    expect(authorityPreflight).toContain('9d6a12c82aa260c22e1c013e95faca0e');

    const strictContract = dollarBody('strict_contract');
    for (const obsolete of [
      '2e322bc7dfee3cf5cb6548ed3a587095',
      '8ddb91f5f7bb5f27b609ec83cb69fa66',
      'ba1cdf1b56e5bb0c1c199b65390ee1f2',
      'a7744092d35a022996a61d9de10e982d',
      'edfd095bae13ece6bedc989c3acd0467',
      'c22ec3b288898efa319a384850d41ba7',
      'receipt-aware fn_ca_settle_hand_stacks_absolute changed before strict contraction',
      'receipt-aware fn_ca_commit_hand_settlement changed before strict contraction',
      'Receipt-aware inner core:',
    ]) {
      expect(strictContract).not.toContain(obsolete);
    }

    expect(strictContract.match(/IF md5\(v_inner\) =/g)).toHaveLength(1);
    expect(strictContract).toContain("IF md5(v_inner) = '2c5f04ae307d38f187b8b72a3f557738'");
    expect(strictContract).toContain(
      "AND md5(v_inner_source) = 'e67e89b3aec325f8038e0507a1511eec'"
    );
    expect(strictContract).toContain("AND md5(v_outer) = 'a1738adaf943656868e68a7bf7ce8d1e'");
    expect(strictContract).toContain(
      "AND md5(v_outer_source) = '0ef3c57a6a31acc383ce4b95a0f9519f'"
    );
    for (const target of [
      '9d1376a2b2e13e4dc1d25025b2d2e403',
      '3c2d594f08f52a66436f9a766947a1f1',
      '242f8a9d3ad57dac46cd8aa5b395b430',
      '9a3e7fccb42d396b4004b45672634e4f',
    ]) {
      expect(strictContract).toContain(target);
      expect(dollarBody('postconditions')).toContain(target);
    }
    expect(strictContract).toContain(
      'strict exact-seat contraction requires the measured 20260910054712 production postimage'
    );
  });

  it('contracts exact-seat identity without dropping the one-seat-write time-bank envelope', () => {
    const strictContract = dollarBody('strict_contract');
    const postconditions = dollarBody('postconditions');

    for (const marker of [
      "(v_tb_env->>'exact')::boolean IS TRUE",
      "'exact', true",
      "time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer",
      "time_bank_remaining = (v_tb->>'seconds_remaining')::integer",
      'SELECT count(*)::integer INTO v_row_count',
      "s.id = (v_item->>'seat_id')::uuid",
      "s.joined_at = (v_item->>'seat_joined_at')::timestamptz",
      'IF v_row_count = 0 AND EXISTS (',
    ]) {
      expect(strictContract).toContain(marker);
    }

    expect(postconditions).toContain("position('v_exact_seat_generation' in v_inner) > 0");
    expect(postconditions).toContain("position('v_exact_seat_generation' in v_outer) > 0");
    expect(postconditions).toContain("position('app.ca_hand_time_banks' in v_inner) = 0");
    expect(postconditions).toContain("position('app.ca_hand_time_banks' in v_outer) = 0");
    expect(postconditions).toContain("position('''exact'', true' in v_outer) = 0");
    expect(postconditions).toContain(
      "position('SELECT count(*)::integer INTO v_row_count' in v_outer) = 0"
    );
    expect(postconditions).toContain("position('IF v_row_count = 0 THEN' in v_outer) = 0");
  });

  it('preserves Diamond dispatch, history, and terminal receipt custody byte-for-byte', () => {
    const innerSource = migrationFunctionSource(
      oneSeatWritePostimage,
      'fn_ca_settle_hand_stacks_absolute'
    );
    const outerSource = migrationFunctionSource(
      oneSeatWritePostimage,
      'fn_ca_commit_hand_settlement'
    );
    const postconditions = dollarBody('postconditions');

    expect(innerSource).toContain('public.fn_poker_diamond_settle_cash_hand(');
    for (const marker of [
      'v_diamond boolean := false',
      'diamond_chip_obligation_or_fractional_fact',
      'public.hand_atomic_commits',
      'post_commit_request_hash',
      'post_commit_payload_hash',
    ]) {
      expect(outerSource).toContain(marker);
      expect(postconditions).toContain(marker);
    }
    expect(outerSource).toContain("(v_result->>'history_id')::uuid");
    expect(postconditions).toContain("(v_result->>''history_id'')::uuid");
    expect(postconditions).toContain('public.fn_poker_diamond_settle_cash_hand(');
    expect(contractionCode).not.toMatch(
      /(?:CREATE(?: OR REPLACE)?|DROP|ALTER)\s+FUNCTION(?: IF EXISTS)?\s+public\.fn_poker_diamond_settle_cash_hand\s*\(/
    );
  });

  it('keeps the unbound atomic cashout owner-only and the occupancy door service-only', () => {
    const cashoutCoreSource = migrationFunctionSource(
      cashoutPostimage,
      'atomic_seat_cashout_locked'
    );
    const occupancySource = migrationFunctionSource(cashoutPostimage, 'fn_cashout_seat_occupancy');
    const tournamentGuardSource = migrationFunctionSource(
      contraction,
      'atomic_seat_cashout_locked'
    );
    expect(md5(cashoutCoreSource)).toBe('f0e1b852a56808d39a48e3a27603333d');
    expect(md5(occupancySource)).toBe('1f7683406ca4d3d0ddce0e92ee8ef5e6');
    expect(md5(tournamentGuardSource)).toBe('08924758c5e10e72c38dba11d7d4c758');
    expect(cashoutCoreSource).toContain('public.fn_poker_diamond_cashout(');
    expect(cashoutCoreSource).toContain('cashout:occupancy:');
    expect(occupancySource).toContain('CASHOUT_OCCUPANCY_REQUIRED');
    expect(occupancySource).toContain('public.atomic_seat_cashout_locked(');

    expect(compact(contractionCode)).toContain(
      compact(
        `REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(
           uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;`
      )
    );
    expect(contractionCode).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.atomic_seat_cashout_locked\s*\(/
    );
    expect(operationIndexes('fn_cashout_seat_occupancy')).toEqual({ creates: [], removals: [] });

    const installer = dollarBody('install_cashout_tournament_guard_once');
    const finalProof = dollarBody('verify_cashout_occupancy_authority_preserved');
    for (const sourceHash of [
      'f0e1b852a56808d39a48e3a27603333d',
      '1f7683406ca4d3d0ddce0e92ee8ef5e6',
      '08924758c5e10e72c38dba11d7d4c758',
    ]) {
      expect(installer).toContain(sourceHash);
      expect(finalProof).toContain(sourceHash);
    }
    for (const definitionHash of [
      'e1b0b9702e75378ecac634c3a879502e',
      '46ccf386d5d737b8ecee34c421331681',
      'ff53d11cf9d102ea48666c1714d699e6',
      '2e60c4b66468b51061018a9058e9a395',
    ]) {
      expect(installer).toContain(definitionHash);
    }

    expect(installer).toContain('v_core IS NULL');
    expect(installer).toContain('AND count(*)=2');
    expect(installer).toContain('SELECT count(*)=3');
    expect(installer).toContain('IF v_apply THEN');
    expect(compact(installer)).toContain(compact('ELSIF v_verify THEN NULL; ELSE'));
    expect(installer).toContain('STAGE_B_CASHOUT_UNKNOWN_PREIMAGE');
    expect(installer).toContain("ARRAY['postgres']::name[]");
    expect(installer).toContain("ARRAY['postgres','service_role']::name[]");
    expect(installer).toContain('a.grantor<>p.proowner OR a.is_grantable');
    expect(installer.match(/ALTER FUNCTION public\.atomic_seat_cashout_locked\s*\(/g)).toHaveLength(
      1
    );
    expect(
      installer.match(/CREATE OR REPLACE FUNCTION public\.atomic_seat_cashout_locked\s*\(/g)
    ).toHaveLength(1);
    expect(
      installer.match(/REVOKE ALL ON FUNCTION\s+public\.atomic_seat_cashout_locked/g)
    ).toHaveLength(2);
    const applyStart = installer.indexOf('IF v_apply THEN');
    const verifyStart = installer.indexOf('ELSIF v_verify THEN', applyStart);
    const refusalStart = installer.indexOf('ELSE', verifyStart);
    const applyBranch = installer.slice(applyStart, verifyStart);
    const verifyBranch = installer.slice(verifyStart, refusalStart);
    expect(applyStart).toBeGreaterThan(-1);
    expect(verifyStart).toBeGreaterThan(applyStart);
    expect(refusalStart).toBeGreaterThan(verifyStart);
    expect(applyBranch).toContain('ALTER FUNCTION public.atomic_seat_cashout_locked(');
    expect(applyBranch).toContain('CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(');
    expect(applyBranch).toContain('REVOKE ALL ON FUNCTION');
    expect(compact(verifyBranch)).toBe('ELSIF v_verify THEN NULL;');
    expect(verifyBranch).not.toMatch(/ALTER FUNCTION|CREATE OR REPLACE FUNCTION|REVOKE|GRANT/);
    expect(installer).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.atomic_seat_cashout_locked/
    );
    expect(contractionCode).not.toContain('$require_current_cashout_authority$');
    expect(contractionCode).not.toContain('$rename_cashout_core$');

    expect(finalProof).toContain('WHERE p.oid IN (v_core,v_wrapper)');
    expect(finalProof).toContain('WHERE p.oid=v_occupancy');
    expect(finalProof).toContain('a.grantee=v_service_role');
    expect(countNeedle(finalProof, "a.privilege_type='EXECUTE')<>1")).toBe(1);
    expect(countNeedle(finalProof, "a.privilege_type='EXECUTE')<>2")).toBe(1);
  });
});
