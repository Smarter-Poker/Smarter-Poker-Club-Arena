/**
 * LAW: ONE CAPABILITY REGISTRY. The database is authoritative, the TypeScript
 * mirror cannot drift from it, nothing below `deployed` is ever offered, and
 * every surface learns the answer through one hook.
 *
 * `public.platform_capabilities` (migration 20260924025555) holds each
 * technical capability and its readiness; `src/config/platformCapabilities.ts`
 * mirrors the ids and the readiness ladder for compile-time use, and
 * `src/hooks/usePlatformCapability.ts` is the one way a surface asks. Two
 * lists of the same ids drift the first time somebody adds a row to one of
 * them, so this holds the mirror to the migration's own seed and CHECKs.
 *
 * WHERE THE SEEDS ARE READ FROM. The mirror and the hook ship with their first
 * consumer, which may land before or after the registry migration. So the seed
 * source is, in order: the migration when the tree carries it; otherwise the
 * JSON copy named by $CAPABILITY_REGISTRY_SEEDS, or
 * scripts/ci/fixtures/capability-registry/seeds.json (pinned to the migration
 * by tests/unit/capabilityRegistrySeedsFixture.test.ts where both exist). With
 * none of them, ONLY the seed comparison is skipped, and it says why.
 *
 * It also pins the owner's decision that there is NO OFC: `variant.ofc` is
 * seeded `excluded`, and the client never turns an excluded or merely tested
 * capability into an offered one, whatever the RPC's `available` flag says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { supabase } from '../src/lib/supabase';
import {
  CAPABILITY_READINESS_ORDER,
  CAPABILITY_SCOPES,
  FIRST_AVAILABLE_READINESS,
  PLATFORM_CAPABILITY_IDS,
  isAvailable,
  readPlatformCapabilities,
} from '../src/config/platformCapabilities';
import {
  PLATFORM_CAPABILITY_TTL_MS,
  gateFrom,
  resetPlatformCapabilityCache,
  usePlatformCapability,
} from '../src/hooks/usePlatformCapability';

const ROOT = join(__dirname, '..');
const MIGRATION_REL =
  'supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql';
const FIXTURE_REL = 'scripts/ci/fixtures/capability-registry/seeds.json';
const SEEDS_ENV = 'CAPABILITY_REGISTRY_SEEDS';
const MIRROR_REL = 'src/config/platformCapabilities.ts';
const HOOK_REL = 'src/hooks/usePlatformCapability.ts';

interface SeedRow {
  id: string;
  scope: string;
  readiness: string;
}

interface RegistrySource {
  from: string;
  readiness: string[];
  scopes: string[];
  seeds: SeedRow[];
}

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function fromMigration(path: string): RegistrySource {
  const sql = readFileSync(path, 'utf8');
  const table = /CREATE TABLE public\.platform_capabilities \(([\s\S]*?)\n\);/.exec(sql);
  if (!table) throw new Error(`CREATE TABLE public.platform_capabilities not found in ${path}`);
  const ddl = table[1].replace(/--[^\n]*/g, '');
  const check = (column: string) => {
    const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(ddl);
    if (!m) throw new Error(`CHECK on ${column} not found in ${path}`);
    return quotedList(m[1]);
  };
  const insert =
    /INSERT INTO public\.platform_capabilities\s*\([^)]*\)\s*VALUES([\s\S]*?);\s*\n/.exec(sql);
  if (!insert)
    throw new Error(`seed INSERT INTO public.platform_capabilities not found in ${path}`);
  const seeds = [
    ...insert[1].matchAll(
      /\(\s*'([a-z0-9_.]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'/g
    ),
  ].map((r) => ({ id: r[1], scope: r[4], readiness: r[7] }));
  if (!sql.includes("c.readiness IN ('deployed','production_verified')")) {
    throw new Error(`fn_capability_available's rule not found in ${path}`);
  }
  return { from: MIGRATION_REL, readiness: check('readiness'), scopes: check('scope'), seeds };
}

function fromFixture(path: string, label: string): RegistrySource {
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    readiness?: unknown;
    scopes?: unknown;
    seeds?: unknown;
  };
  if (!Array.isArray(json.readiness) || !Array.isArray(json.scopes) || !Array.isArray(json.seeds)) {
    throw new Error(`${label} is not a capability registry seed copy (readiness, scopes, seeds)`);
  }
  return {
    from: label,
    readiness: json.readiness as string[],
    scopes: json.scopes as string[],
    seeds: (json.seeds as SeedRow[]).map(({ id, scope, readiness }) => ({ id, scope, readiness })),
  };
}

/** The seed source, or the reason there is none. Never a silent default. */
const registry: { source: RegistrySource | null; reason: string } = (() => {
  const migration = join(ROOT, MIGRATION_REL);
  if (existsSync(migration)) return { source: fromMigration(migration), reason: '' };
  const override = process.env[SEEDS_ENV];
  if (override) {
    const path = resolve(ROOT, override);
    if (!existsSync(path)) throw new Error(`$${SEEDS_ENV} names ${override}, which does not exist`);
    return { source: fromFixture(path, `$${SEEDS_ENV} (${override})`), reason: '' };
  }
  const fixture = join(ROOT, FIXTURE_REL);
  if (existsSync(fixture)) return { source: fromFixture(fixture, FIXTURE_REL), reason: '' };
  return {
    source: null,
    reason: `SKIPPED ONLY THE SEED COMPARISON: this tree carries neither ${MIGRATION_REL} nor ${FIXTURE_REL}, and $${SEEDS_ENV} is unset`,
  };
})();

describe('one capability registry: the mirror equals the database', () => {
  it('the seeded ids, readiness ladder and scopes equal the mirror, and variant.ofc is seeded excluded', (ctx) => {
    const { source, reason } = registry;
    if (!source) {
      ctx.skip(reason);
      return;
    }
    const seeded = source.seeds.map((r) => r.id);
    expect(seeded.length, source.from).toBeGreaterThan(0);
    expect([...seeded].sort(), source.from).toEqual([...PLATFORM_CAPABILITY_IDS].sort());
    expect(source.readiness, source.from).toEqual([...CAPABILITY_READINESS_ORDER]);
    expect(source.scopes, source.from).toEqual([...CAPABILITY_SCOPES]);
    for (const row of source.seeds) {
      expect(source.readiness, `${row.id} readiness`).toContain(row.readiness);
      expect(source.scopes, `${row.id} scope`).toContain(row.scope);
    }
    expect(source.seeds.find((r) => r.id === 'variant.ofc')?.readiness, source.from).toBe(
      'excluded'
    );
  });

  it('ids are unique', () => {
    expect(new Set(PLATFORM_CAPABILITY_IDS).size).toBe(PLATFORM_CAPABILITY_IDS.length);
    expect([...PLATFORM_CAPABILITY_IDS]).toEqual([...PLATFORM_CAPABILITY_IDS].sort());
  });

  it('the readiness ladder is ordered, and available means deployed or production_verified', () => {
    expect([...CAPABILITY_READINESS_ORDER]).toEqual([
      'excluded',
      'planned',
      'implemented',
      'tested',
      'deployed',
      'production_verified',
    ]);
    expect(FIRST_AVAILABLE_READINESS).toBe('deployed');
    expect(CAPABILITY_READINESS_ORDER.filter((r) => isAvailable(r))).toEqual([
      'deployed',
      'production_verified',
    ]);
  });

  it('variant.ofc is in the mirror and excluded is never available', () => {
    expect(PLATFORM_CAPABILITY_IDS as readonly string[]).toContain('variant.ofc');
    expect(isAvailable('excluded')).toBe(false);
  });

  it('the mirror carries no hardcoded readiness per capability', () => {
    const mirror = readFileSync(join(ROOT, MIRROR_REL), 'utf8');
    for (const id of PLATFORM_CAPABILITY_IDS) {
      const line = mirror.split('\n').find((l) => l.includes(`'${id}'`)) ?? '';
      for (const rung of CAPABILITY_READINESS_ORDER) {
        expect(line, `${id} is paired with '${rung}' in the mirror`).not.toContain(`'${rung}'`);
      }
    }
  });
});

describe('one capability registry: the client read', () => {
  it('gates on the RPC and never offers a capability below deployed', async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValueOnce({
      data: [
        row('variant.ofc', 'excluded', true),
        row('club.membership_cap', 'tested', true),
        row('cash.insurance_ev_cashout', 'deployed', true),
        row('cash.fixed_limit.kill_pots', 'production_verified', false),
        { ...row('cash.insurance_ev_cashout', 'deployed', true), id: 'future.capability' },
      ],
      error: null,
    } as never);
    const read = await readPlatformCapabilities();
    expect(rpc).toHaveBeenCalledWith('fn_platform_capabilities');
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    const offered = Object.fromEntries(read.capabilities.map((c) => [c.id, c.available]));
    expect(offered).toEqual({
      'variant.ofc': false,
      'club.membership_cap': false,
      'cash.insurance_ev_cashout': true,
      'cash.fixed_limit.kill_pots': false,
    });
  });

  it('a read that fails is unknown, never an empty registry', async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } } as never);
    expect((await readPlatformCapabilities()).status).toBe('unknown');
    rpc.mockResolvedValueOnce({
      data: [{ id: 'variant.ofc', readiness: 'shipped' }],
      error: null,
    } as never);
    expect((await readPlatformCapabilities()).status).toBe('unknown');
  });
});

function row(id: string, readiness: string, available: boolean) {
  return {
    id,
    version: 'v1',
    title: 'A Capability',
    scope: 'platform',
    variants: [],
    compatibility: {},
    readiness,
    available,
  };
}

describe('one capability registry: the hook', () => {
  const rpc = vi.mocked(supabase.rpc);
  const asked = () => rpc.mock.calls.filter(([fn]) => fn === 'fn_platform_capabilities').length;
  let answer: { data: unknown; error: unknown };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetPlatformCapabilityCache();
    rpc.mockReset();
    answer = { data: [row('cash.insurance_ev_cashout', 'deployed', true)], error: null };
    rpc.mockImplementation((async (fn: string) =>
      fn === 'fn_platform_capabilities' ? answer : { data: null, error: null }) as never);
  });

  it('null asks nothing and is unavailable', async () => {
    const { result } = renderHook(() => usePlatformCapability(null));
    expect(result.current).toBe('unavailable');
    await act(async () => {});
    expect(asked()).toBe(0);
    expect(result.current).toBe('unavailable');
  });

  it('answers loading, then available, unavailable or unknown', async () => {
    const live = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    expect(live.result.current).toBe('loading');
    await waitFor(() => expect(live.result.current).toBe('available'));
    // Not in the registry at all: the registry answered, and it is not offered.
    const absent = renderHook(() => usePlatformCapability('variant.ofc'));
    await waitFor(() => expect(absent.result.current).toBe('unavailable'));

    resetPlatformCapabilityCache();
    answer = { data: null, error: { message: 'boom' } };
    const failed = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    await waitFor(() => expect(failed.result.current).toBe('unknown'));
  });

  it('gateFrom never widens: a failed read is unknown, a row below deployed is unavailable', () => {
    expect(gateFrom({ status: 'unknown', reason: 'x' }, 'variant.ofc')).toBe('unknown');
    expect(gateFrom({ status: 'ok', capabilities: [] }, 'variant.ofc')).toBe('unavailable');
  });

  it('one read is shared for a minute, and a failed read is never kept', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const a = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    const b = renderHook(() => usePlatformCapability('cash.fixed_limit.kill_pots'));
    await waitFor(() => expect(a.result.current).toBe('available'));
    await waitFor(() => expect(b.result.current).toBe('unavailable'));
    expect(asked()).toBe(1);

    now.mockReturnValue(1_000_000 + PLATFORM_CAPABILITY_TTL_MS - 1);
    const c = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    await waitFor(() => expect(c.result.current).toBe('available'));
    expect(asked()).toBe(1);

    now.mockReturnValue(1_000_000 + PLATFORM_CAPABILITY_TTL_MS);
    answer = { data: null, error: { message: 'boom' } };
    const d = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    await waitFor(() => expect(d.result.current).toBe('unknown'));
    expect(asked()).toBe(2);

    answer = { data: [row('cash.insurance_ev_cashout', 'deployed', true)], error: null };
    const e = renderHook(() => usePlatformCapability('cash.insurance_ev_cashout'));
    await waitFor(() => expect(e.result.current).toBe('available'));
    expect(asked()).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */
/* Every surface gates on the hook.                                          */
/* ------------------------------------------------------------------------ */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Source text with block and line comments removed (a comment may name an id). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const sources = walk(join(ROOT, 'src'))
  .map((full) => ({ full, rel: relative(ROOT, full).split('\\').join('/') }))
  .filter(({ rel }) => rel !== MIRROR_REL && rel !== HOOK_REL)
  .map(({ full, rel }) => ({ full, rel, code: code(readFileSync(full, 'utf8')) }));

const ID_LITERAL = new RegExp(
  `['"\`](${PLATFORM_CAPABILITY_IDS.map((id) => id.replace(/\./g, '\\.')).join('|')})['"\`]`
);
const READINESS_LITERAL = new RegExp(`['"\`](${CAPABILITY_READINESS_ORDER.join('|')})['"\`]`);
const HOOK_CALL = /\busePlatformCapability\(/;

function localImports(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dirname(file), m[1]);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        out.push(relative(ROOT, candidate).split('\\').join('/'));
        break;
      }
    }
  }
  return out;
}

describe('one capability registry: every surface gates on the hook', () => {
  const callers = sources.filter((s) => HOOK_CALL.test(s.code));
  const naming = sources.filter((s) => ID_LITERAL.test(s.code));

  it('only the mirror calls fn_platform_capabilities', () => {
    const offenders = sources
      .filter((s) => /\brpc\(\s*['"]fn_platform_capabilities['"]/.test(s.code))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('no surface reads the registry around the hook', () => {
    // What a surface may take from the mirror: ids and types, never the read
    // or the readiness rule (those belong to the hook).
    const offenders = sources
      .filter((s) =>
        [
          ...s.code.matchAll(
            /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*config\/platformCapabilities['"]/g
          ),
        ].some((m) => /\b(readPlatformCapabilities|isAvailable)\b/.test(m[1]))
      )
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('every file that names a capability id is a hook caller or a module one imports', () => {
    expect(callers.length, 'no surface calls usePlatformCapability').toBeGreaterThan(0);
    const gated = new Set<string>();
    for (const caller of callers) {
      gated.add(caller.rel);
      for (const imported of localImports(caller.full, caller.code)) gated.add(imported);
    }
    const ungated = naming.filter((s) => !gated.has(s.rel)).map((s) => s.rel);
    expect(ungated).toEqual([]);
  });

  it('a surface shows a gated control only on available, never on a boolean', () => {
    for (const caller of callers) {
      const gates = [
        ...caller.code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*usePlatformCapability\(/g),
      ];
      expect(gates.length, `${caller.rel} keeps the gate in a named const`).toBeGreaterThan(0);
      for (const [, name] of gates) {
        expect(caller.code, `${caller.rel}: ${name} is compared with 'available'`).toMatch(
          new RegExp(`\\b${name}\\s*[!=]==\\s*'available'`)
        );
        expect(caller.code, `${caller.rel}: ${name} is not a boolean`).not.toMatch(
          new RegExp(`\\b${name}\\s*[!=]==?\\s*(true|false|null)\\b|!\\s*${name}\\b`)
        );
      }
    }
  });

  it('no surface carries a readiness of its own', () => {
    for (const s of [...callers, ...naming]) {
      expect(s.code, `${s.rel} names a readiness rung`).not.toMatch(READINESS_LITERAL);
      expect(s.code, `${s.rel} reads a readiness`).not.toMatch(/\.readiness\b/);
    }
  });
});
