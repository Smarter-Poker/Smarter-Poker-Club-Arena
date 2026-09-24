/**
 * LAW: ONE CAPABILITY REGISTRY. The database is authoritative, the TypeScript
 * mirror cannot drift from it, and nothing below `deployed` is ever offered.
 *
 * `public.platform_capabilities` (migration 20260924025555) holds each
 * technical capability and its readiness; `src/config/platformCapabilities.ts`
 * mirrors the ids and the readiness ladder for compile-time use. Two lists of
 * the same ids drift the first time somebody adds a row to one of them, so
 * this reads the migration's own seed and CHECK and holds the mirror to them.
 *
 * It also pins the owner's decision that there is NO OFC: `variant.ofc` is
 * seeded `excluded`, and the client never turns an excluded or merely tested
 * capability into an offered one, whatever the RPC's `available` flag says.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabase } from '../src/lib/supabase';
import {
  CAPABILITY_READINESS_ORDER,
  CAPABILITY_SCOPES,
  PLATFORM_CAPABILITY_IDS,
  isAvailable,
  readPlatformCapabilities,
} from '../src/config/platformCapabilities';

const MIGRATION = join(
  __dirname,
  '..',
  'supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');

/** The CREATE TABLE statement for the registry, with `--` comments removed. */
const registryDdl = (() => {
  const m = /CREATE TABLE public\.platform_capabilities \(([\s\S]*?)\n\);/.exec(sql);
  if (!m) throw new Error('CREATE TABLE public.platform_capabilities not found in the migration');
  return m[1].replace(/--[^\n]*/g, '');
})();

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function checkList(column: string): string[] {
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(registryDdl);
  if (!m) throw new Error(`CHECK on ${column} not found`);
  return quotedList(m[1]);
}

/** Each seed row as [id, rule_version, title, scope, variants, compatibility, readiness]. */
const seedRows = (() => {
  const m = /INSERT INTO public\.platform_capabilities\s*\([^)]*\)\s*VALUES([\s\S]*?);\s*\n/.exec(
    sql
  );
  if (!m) throw new Error('seed INSERT INTO public.platform_capabilities not found');
  return [
    ...m[1].matchAll(
      /\(\s*'([a-z0-9_.]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'/g
    ),
  ].map((r) => r.slice(1));
})();

describe('one capability registry', () => {
  it('the migration seeds exactly the ids the TypeScript mirror declares', () => {
    const seeded = seedRows.map((r) => r[0]).sort();
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded).toEqual([...PLATFORM_CAPABILITY_IDS].sort());
  });

  it('variant.ofc is seeded excluded: there is no OFC', () => {
    const ofc = seedRows.find((r) => r[0] === 'variant.ofc');
    expect(ofc, 'variant.ofc seed row').toBeDefined();
    expect(ofc?.[6]).toBe('excluded');
    expect(isAvailable('excluded')).toBe(false);
  });

  it('the readiness ladder equals the database CHECK, in order', () => {
    expect(checkList('readiness')).toEqual([...CAPABILITY_READINESS_ORDER]);
  });

  it('the scope vocabulary equals the database CHECK', () => {
    expect(checkList('scope')).toEqual([...CAPABILITY_SCOPES]);
  });

  it('every seed row uses a readiness and a scope the CHECK allows', () => {
    for (const [id, , , scope, , , readiness] of seedRows) {
      expect(CAPABILITY_READINESS_ORDER as readonly string[], id).toContain(readiness);
      expect(CAPABILITY_SCOPES as readonly string[], id).toContain(scope);
    }
  });

  it('available means deployed or production_verified, the same rule as fn_capability_available', () => {
    const offered = CAPABILITY_READINESS_ORDER.filter((r) => isAvailable(r));
    expect(offered).toEqual(['deployed', 'production_verified']);
    expect(sql).toContain("c.readiness IN ('deployed','production_verified')");
  });

  it('the mirror carries no hardcoded readiness per capability', () => {
    const mirror = readFileSync(
      join(__dirname, '..', 'src/config/platformCapabilities.ts'),
      'utf8'
    );
    for (const id of PLATFORM_CAPABILITY_IDS) {
      const line = mirror.split('\n').find((l) => l.includes(`'${id}'`)) ?? '';
      for (const rung of CAPABILITY_READINESS_ORDER) {
        expect(line, `${id} is paired with '${rung}' in the mirror`).not.toContain(`'${rung}'`);
      }
    }
  });

  it('the client gates on the RPC and never offers a capability below deployed', async () => {
    const rpc = vi.mocked(supabase.rpc);
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: 'variant.ofc',
          version: 'retired',
          title: 'Open Face Chinese',
          scope: 'platform',
          variants: [],
          compatibility: {},
          readiness: 'excluded',
          available: true,
        },
        {
          id: 'club.membership_cap',
          version: 'club-membership-v2',
          title: 'Club Membership Cap',
          scope: 'club',
          variants: [],
          compatibility: {},
          readiness: 'tested',
          available: true,
        },
        {
          id: 'cash.insurance_ev_cashout',
          version: 'insurance-v1',
          title: 'Insurance And EV Cashout',
          scope: 'cash_table',
          variants: [],
          compatibility: {},
          readiness: 'deployed',
          available: true,
        },
        {
          id: 'cash.fixed_limit.kill_pots',
          version: 'kill-v1',
          title: 'Fixed Limit Kill Pots',
          scope: 'cash_table',
          variants: ['flh', 'flo8'],
          compatibility: {},
          readiness: 'production_verified',
          available: false,
        },
        {
          id: 'future.capability',
          version: 'v1',
          title: 'Not In This Build',
          scope: 'platform',
          variants: [],
          compatibility: {},
          readiness: 'deployed',
          available: true,
        },
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
