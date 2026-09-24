/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND COSTS CLIENT SPEAKS THE MIGRATION'S OWN CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * src/services/ClubCommerceService.ts calls the browser doors that
 * supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql
 * installs. PostgREST resolves an RPC by its name AND its argument names, so
 * one renamed `p_` key is not a type error anywhere: it is a 404 "could not
 * find the function" at the moment an owner presses Pay.
 *
 * This file reads the SQL text itself (no database) and pins, both ways:
 *
 *   1. every RPC the service sends exists in the migration, is granted to
 *      `authenticated`, and receives only argument keys the signature
 *      declares, including every parameter that has no DEFAULT;
 *   2. every refusal code the migration can return (a literal 'error', a
 *      CA_COMMERCE_ exception lowered by the purchase and refund boundaries,
 *      the mandate_<state> family, and every renewal needs_attention reason)
 *      has operator copy in REFUSAL_COPY, in Title Case, with no em dash.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return { data: fn === 'fn_ca_commerce_receipts' ? [] : { success: true }, error: null };
    }),
  },
}));

import ClubCommerceService, {
  REFUSAL_COPY,
  isRefusal,
  listPrice,
  refusalCopy,
  type CatalogProduct,
} from '../../src/services/ClubCommerceService';

const ROOT = resolve(__dirname, '../..');
const SQL = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql'),
  'utf8'
);
const EM_DASH = String.fromCharCode(0x2014);

/** Split a parameter list on top level commas (DEFAULT now() has parens). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

type Param = { name: string; hasDefault: boolean };
const SIGNATURES = new Map<string, Param[]>();
for (const m of SQL.matchAll(/^CREATE FUNCTION public\.(fn_ca_commerce_\w+)\((.*)\) RETURNS /gm)) {
  SIGNATURES.set(
    m[1],
    splitTopLevel(m[2]).map((p) => ({
      name: p.split(/\s+/)[0],
      hasDefault: /\bDEFAULT\b/i.test(p),
    }))
  );
}

/** Function names in the GRANT ... TO authenticated statement(s). */
const GRANTED_TO_AUTHENTICATED = new Set<string>();
for (const m of SQL.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO ([^;]+);/g)) {
  if (!/\bauthenticated\b/.test(m[2])) continue;
  for (const f of m[1].matchAll(/public\.(fn_ca_commerce_\w+)\(/g))
    GRANTED_TO_AUTHENTICATED.add(f[1]);
}

/** Every code the migration can hand back as `error` (or as a renewal reason). */
function refusalCodes(): Set<string> {
  const codes = new Set<string>();
  // Literal refusals. The lookbehind skips `v_x->>'error', 'unknown'` inside a
  // COALESCE, which reads a field rather than returning a code.
  for (const m of SQL.matchAll(/(?<!->>)'error',\s*'([a-z_]+)'/g)) {
    if (m[1] !== 'mandate_') codes.add(m[1]);
  }
  // Exceptions the boundaries lower: 'CA_COMMERCE_X' -> 'x'.
  expect(SQL).toMatch(/lower\(replace\(SQLERRM, 'CA_COMMERCE_', ''\)\)/);
  for (const m of SQL.matchAll(/RAISE EXCEPTION 'CA_COMMERCE_([A-Z_]+)'/g))
    codes.add(m[1].toLowerCase());
  // 'mandate_' || v_m.state for every non-authorized mandate state.
  if (/'error',\s*'mandate_'\s*\|\|\s*v_m\.state/.test(SQL)) {
    const check = SQL.match(
      /CREATE TABLE public\.ca_commerce_renewal_mandates[\s\S]*?state text[^\n]*CHECK \(state IN \(([^)]*)\)\)/
    );
    expect(check, 'renewal mandate state CHECK list').not.toBeNull();
    for (const s of check![1].matchAll(/'([a-z_]+)'/g))
      if (s[1] !== 'authorized') codes.add(`mandate_${s[1]}`);
  }
  // Renewal outcomes: the reason a mandate needs attention, shown on the page.
  for (const m of SQL.matchAll(/'needs_attention',\s*'reason',\s*'([a-z_]+)'/g)) codes.add(m[1]);
  for (const m of SQL.matchAll(/COALESCE\(v_\w+->>'error',\s*'([a-z_]+)'\)/g)) codes.add(m[1]);
  return codes;
}

beforeEach(() => {
  rpc.calls.length = 0;
});

async function exerciseEveryDoor() {
  const scope = '00000000-0000-4000-8000-000000000001';
  await ClubCommerceService.catalog('club');
  await ClubCommerceService.scopeStatus('club', scope);
  await ClubCommerceService.activateTrial('union', scope);
  await ClubCommerceService.quote('club', scope, [{ sku: 'capacity_100', quantity: 1 }]);
  await ClubCommerceService.quote('club', scope, [{ sku: 'capacity_250' }], {
    sponsorshipId: scope,
    renewalMaxDiamonds: 700,
    purchaseKind: 'upgrade',
  });
  await ClubCommerceService.purchase(scope, 'order-key-0001', 'upgrade');
  await ClubCommerceService.receipts('club', scope);
  await ClubCommerceService.receipts(null, null);
  await ClubCommerceService.setRenewal(scope, true, 700, 'capacity_100', 1);
  await ClubCommerceService.setRenewal(scope, false, null);
  await ClubCommerceService.setSponsorship(scope, { totalBudget: 5000, perClubBudget: 500 });
  await ClubCommerceService.setSponsorship(scope, { sponsorshipId: scope, revoke: true });
  await ClubCommerceService.admission('club', scope, 'approve_member');
}

describe('ClubCommerceService: every RPC matches the migration signature', () => {
  it('parses the migration signatures it is checked against', () => {
    expect(SIGNATURES.size).toBeGreaterThan(20);
    expect(SIGNATURES.get('fn_ca_commerce_quote')?.map((p) => p.name)).toEqual([
      'p_scope_kind',
      'p_scope_id',
      'p_lines',
      'p_sponsorship_id',
      'p_renewal_max_diamonds',
      'p_purchase_kind',
    ]);
  });

  it('exercises every service door', async () => {
    await exerciseEveryDoor();
    const doors = Object.keys(ClubCommerceService).length;
    expect(new Set(rpc.calls.map((c) => c.fn)).size).toBe(doors);
  });

  it('sends only declared argument keys, and every required one', async () => {
    await exerciseEveryDoor();
    for (const { fn, args } of rpc.calls) {
      const sig = SIGNATURES.get(fn);
      expect(sig, `${fn} is not a function in the migration`).toBeDefined();
      expect(GRANTED_TO_AUTHENTICATED.has(fn), `${fn} is not granted to authenticated`).toBe(true);
      const declared = new Set(sig!.map((p) => p.name));
      for (const key of Object.keys(args))
        expect(declared.has(key), `${fn} has no parameter ${key}`).toBe(true);
      for (const p of sig!.filter((x) => !x.hasDefault))
        expect(Object.keys(args), `${fn} must send ${p.name}`).toContain(p.name);
    }
  });

  it('a sponsored club quote sends exactly the declared keys, renewal null', async () => {
    const club = '00000000-0000-4000-8000-0000000000c1';
    const sponsorship = '00000000-0000-4000-8000-0000000000a1';
    await ClubCommerceService.quote('club', club, [{ sku: 'capacity_100', quantity: 1 }], {
      sponsorshipId: sponsorship,
      renewalMaxDiamonds: null,
      purchaseKind: 'purchase',
    });
    const [call] = rpc.calls;
    expect(call.fn).toBe('fn_ca_commerce_quote');
    expect(Object.keys(call.args).sort()).toEqual(
      SIGNATURES.get('fn_ca_commerce_quote')!
        .map((p) => p.name)
        .sort()
    );
    expect(call.args).toEqual({
      p_scope_kind: 'club',
      p_scope_id: club,
      p_lines: [{ sku: 'capacity_100', quantity: 1 }],
      p_sponsorship_id: sponsorship,
      p_renewal_max_diamonds: null,
      p_purchase_kind: 'purchase',
    });
  });

  it('reads every receipt of the viewer with both scope arguments null', async () => {
    await ClubCommerceService.receipts(null, null);
    expect(rpc.calls[0]).toEqual({
      fn: 'fn_ca_commerce_receipts',
      args: { p_scope_kind: null, p_scope_id: null },
    });
    const sig = SIGNATURES.get('fn_ca_commerce_receipts')!;
    expect(sig.every((p) => p.hasDefault)).toBe(true);
  });

  it('never sends undefined (PostgREST drops the key and picks another overload)', async () => {
    await exerciseEveryDoor();
    for (const { fn, args } of rpc.calls)
      for (const [k, v] of Object.entries(args))
        expect(v, `${fn}.${k} is undefined`).not.toBeUndefined();
  });

  it('throws on an empty answer instead of handing the page null', async () => {
    const { supabase } = await import('../../src/lib/supabase');
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never);
    await expect(ClubCommerceService.scopeStatus('club', 'x')).rejects.toThrow(/no data/);
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never);
    await expect(ClubCommerceService.receipts('club', 'x')).resolves.toEqual([]);
  });
});

describe('REFUSAL_COPY: every code the migration can return has operator copy', () => {
  const codes = refusalCodes();

  it('finds the refusal codes it guards', () => {
    for (const known of [
      'insufficient_diamonds',
      'quote_expired',
      'trial_active_authorize_instead',
      'upgrade_target_gone',
      'debit_reference_reused',
      'mandate_needs_attention',
      'price_above_accepted_ceiling',
      'sponsor_payer_required',
    ])
      expect(codes).toContain(known);
  });

  it.each([...codes].sort())('%s has copy', (code) => {
    expect(Object.prototype.hasOwnProperty.call(REFUSAL_COPY, code)).toBe(true);
  });

  it.each(Object.entries(REFUSAL_COPY))('%s copy is Title Case with no em dash', (_code, copy) => {
    expect(copy.includes(EM_DASH)).toBe(false);
    for (const word of copy.split(/\s+/)) {
      const bare = word.replace(/^[("']+/, '');
      if (bare) expect(bare, `"${copy}"`).toMatch(/^[A-Z0-9$]/);
    }
  });

  it('falls back for an unknown code and never reads the prototype', () => {
    expect(refusalCopy('not_a_code', 'Fallback')).toBe('Fallback');
    expect(refusalCopy('constructor', 'Fallback')).toBe('Fallback');
    expect(refusalCopy(undefined, 'Fallback')).toBe('Fallback');
    expect(refusalCopy('insufficient_diamonds')).toBe('Not Enough Available Diamonds');
  });
});

describe('the page and the service carry no em dash', () => {
  it.each([
    'src/pages/club/ClubDiamondCostsPage.tsx',
    'src/services/ClubCommerceService.ts',
    'src/pages/club/ClubDiamondCostsPage.module.css',
  ])('%s', (file) => {
    expect(readFileSync(resolve(ROOT, file), 'utf8').includes(EM_DASH)).toBe(false);
  });
});

describe('helpers', () => {
  const product = (rule: 'flat' | 'per_unit' | 'per_unit_capped', cap: number | null = null) =>
    ({
      price: {
        price_version_id: 'v',
        version: 1,
        diamonds: 250,
        price_rule: rule,
        cap_diamonds: cap,
        price_authority: 'test',
        comparison_verified: false,
        effective_from: '2026-09-22T00:00:00Z',
      },
    }) as CatalogProduct;

  it('listPrice follows fn_ca_commerce_line_gross', () => {
    expect(listPrice(product('flat'), 7)).toBe(250);
    expect(listPrice(product('per_unit'), 4)).toBe(1000);
    expect(listPrice(product('per_unit_capped', 600), 4)).toBe(600);
    expect(listPrice(product('per_unit_capped', 600), 2)).toBe(500);
    expect(listPrice(null)).toBeNull();
  });

  it('isRefusal recognises only success === false', () => {
    expect(isRefusal({ success: false, error: 'quote_expired' })).toBe(true);
    expect(isRefusal({ success: true })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});
