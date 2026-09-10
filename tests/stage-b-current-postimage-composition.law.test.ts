import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const lanePostimage = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql'
  ),
  'utf8'
);
const contraction = readFileSync(
  resolve(root, 'supabase/migrations/20260910042112_stage_b_current_postimage_contraction.sql'),
  'utf8'
);
const contractionCode = contraction.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

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

const indirectTerminalWrappers = new Set([
  'atomic_cancel_tournament',
  'fn_complete_tournament_terminal',
]);

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

  it('keeps raw G acquisitions at the five intentional transaction fences only', () => {
    expect(
      contractionCode.match(
        /SELECT\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;/g
      )
    ).toHaveLength(5);
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

  it('has no obsolete generation-blind receipt-aware fallback ancestry', () => {
    const strictContract = dollarBody('strict_contract');
    for (const obsolete of [
      '2e322bc7dfee3cf5cb6548ed3a587095',
      '8ddb91f5f7bb5f27b609ec83cb69fa66',
      'receipt-aware fn_ca_settle_hand_stacks_absolute changed before strict contraction',
      'receipt-aware fn_ca_commit_hand_settlement changed before strict contraction',
      'Receipt-aware inner core:',
    ]) {
      expect(strictContract).not.toContain(obsolete);
    }

    expect(strictContract.match(/IF md5\(v_inner\) =/g)).toHaveLength(1);
    expect(strictContract).toContain("IF md5(v_inner) = 'ba1cdf1b56e5bb0c1c199b65390ee1f2'");
    expect(strictContract).toContain("AND md5(v_outer) = 'a7744092d35a022996a61d9de10e982d'");
    expect(strictContract).toContain(
      'strict exact-seat contraction requires the measured 20260910035435 production postimage'
    );
  });
});
