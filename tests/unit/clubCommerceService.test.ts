/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND COSTS CLIENT SPEAKS THE MIGRATION'S OWN CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * src/services/ClubCommerceService.ts calls the browser doors that the
 * commerce migrations install, in order: 20260922143541 (base),
 * 20260924033509 (fixes), 20260924102040 (refunds, notices, catalog
 * lifecycle) and 20260924102056 (admission wired in shadow). Every migration
 * that names fn_ca_commerce_ is read, so a new one is covered the day it
 * lands. PostgREST resolves an RPC by its name AND its argument names, so one
 * renamed `p_` key is not a type error anywhere: it is a 404 "could not find
 * the function" at the moment an owner presses Pay.
 *
 * This file reads the SQL text itself (no database) and pins, both ways:
 *
 *   1. every RPC the service sends exists (its LAST definition across the
 *      migrations wins), is granted to `authenticated` after every later
 *      REVOKE, and receives only argument keys the signature declares,
 *      including every parameter that has no DEFAULT;
 *   2. every refusal code the migrations can return (a literal 'error', a
 *      CA_COMMERCE_ exception lowered by the purchase and refund boundaries,
 *      the mandate_<state> family, and every renewal needs_attention reason)
 *      has operator copy in REFUSAL_COPY, in Title Case, with no em dash;
 *   3. the refund reasons the page offers are exactly the SQL CHECK list.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      if (fn === 'fn_ca_commerce_receipts') return { data: [], error: null };
      if (fn === 'fn_ca_commerce_written_quotes')
        return { data: { success: true, written_quotes: [] }, error: null };
      if (fn === 'fn_ca_commerce_trial_reviews')
        return { data: { success: true, reviews: [] }, error: null };
      if (fn === 'fn_ca_commerce_policies')
        return { data: { success: true, policies: [] }, error: null };
      return { data: { success: true }, error: null };
    }),
  },
}));

import ClubCommerceService, {
  REFUND_REASONS,
  REFUSAL_COPY,
  ceilingSentence,
  isRefusal,
  listPrice,
  owedReasonWords,
  refusalCopy,
  type CatalogProduct,
} from '../../src/services/ClubCommerceService';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS_DIR = resolve(ROOT, 'supabase/migrations');
/** Every migration that touches the commerce boundary, in apply order. */
const COMMERCE_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes('fn_ca_commerce_'));
const SQL_BY_FILE = COMMERCE_FILES.map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'));
const SQL = SQL_BY_FILE.join('\n');
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
/** The last definition of each function wins, as it does in the database. */
const SIGNATURES = new Map<string, Param[]>();
for (const m of SQL.matchAll(
  /^CREATE (?:OR REPLACE )?FUNCTION public\.(fn_ca_commerce_\w+)\((.*)\) RETURNS /gm
)) {
  SIGNATURES.set(
    m[1],
    splitTopLevel(m[2]).map((p) => ({
      name: p.split(/\s+/)[0],
      hasDefault: /\bDEFAULT\b/i.test(p),
    }))
  );
}

/**
 * Function names `authenticated` may execute after every GRANT and REVOKE
 * statement, applied in migration order (a later REVOKE ALL ... FROM
 * authenticated removes an earlier grant until a later GRANT restores it).
 */
const GRANTED_TO_AUTHENTICATED = new Set<string>();
for (const m of SQL.matchAll(
  /(GRANT EXECUTE|REVOKE ALL) ON FUNCTION([\s\S]*?)(TO|FROM) ([^;]+);/g
)) {
  if (!/\bauthenticated\b/.test(m[4])) continue;
  for (const f of m[2].matchAll(/public\.(fn_ca_commerce_\w+)\(/g)) {
    if (m[1] === 'GRANT EXECUTE') GRANTED_TO_AUTHENTICATED.add(f[1]);
    else GRANTED_TO_AUTHENTICATED.delete(f[1]);
  }
}

/** Every code the migrations can hand back as `error` (or as a renewal reason). */
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
  await ClubCommerceService.refundRequest(scope, 0, 'scope_closed', 'refund-key-0001', null);
  await ClubCommerceService.refundRequest(scope, 1, 'purchase_in_error', 'refund-key-0002', 'x');
  await ClubCommerceService.policies('refund');
  await ClubCommerceService.policies('service_terms');
  await ClubCommerceService.policies();
  /* 20260924182605: written quotes and free month reviews */
  await ClubCommerceService.writtenQuotes('club', scope);
  await ClubCommerceService.requestWrittenQuote('club', scope, 3000, null);
  await ClubCommerceService.requestWrittenQuote('club', scope, 3000, 'Three Towns');
  await ClubCommerceService.withdrawWrittenQuote(scope);
  await ClubCommerceService.trialReviews('union', scope);
  await ClubCommerceService.requestTrialReview('club', scope, 'A New Independent Operation');
  /* 20260924183657: settled earnings coverage */
  await ClubCommerceService.earningsCoverage('club', scope);
  await ClubCommerceService.earningsCoverage('union', scope, 60);
}

describe('ClubCommerceService: every RPC matches the migration signature', () => {
  it('reads every commerce migration, in order', () => {
    for (const f of [
      '20260922143541_club_and_union_diamond_commerce.sql',
      '20260924033509_club_and_union_diamond_commerce_fixes.sql',
      '20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql',
      '20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql',
      '20260924182605_diamond_commerce_catalog_terms_written_quotes_and_trial_reviews.sql',
      '20260924183657_diamond_commerce_settled_earnings_coverage.sql',
    ])
      expect(COMMERCE_FILES).toContain(f);
    expect([...COMMERCE_FILES].sort()).toEqual(COMMERCE_FILES);
  });

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

  it('a refund request sends exactly the declared keys, details null when empty', async () => {
    const purchase = '00000000-0000-4000-8000-0000000000b1';
    await ClubCommerceService.refundRequest(purchase, 2, 'service_unavailable', 'rk-00000001');
    const [call] = rpc.calls;
    expect(call.fn).toBe('fn_ca_commerce_refund_request');
    expect(Object.keys(call.args).sort()).toEqual(
      SIGNATURES.get('fn_ca_commerce_refund_request')!
        .map((p) => p.name)
        .sort()
    );
    expect(call.args).toEqual({
      p_purchase_id: purchase,
      p_line_index: 2,
      p_reason: 'service_unavailable',
      p_request_key: 'rk-00000001',
      p_details: null,
    });
  });

  it('set_renewal is the sponsor-aware body from the refunds migration', () => {
    expect(SIGNATURES.get('fn_ca_commerce_set_renewal')?.map((p) => p.name)).toEqual([
      'p_entitlement_id',
      'p_enabled',
      'p_max_diamonds',
      'p_sku',
      'p_quantity',
    ]);
    expect(GRANTED_TO_AUTHENTICATED.has('fn_ca_commerce_refund_request')).toBe(true);
    expect(GRANTED_TO_AUTHENTICATED.has('fn_ca_commerce_policies')).toBe(true);
    /* Internal doors stay private, so the page never calls them. */
    expect(GRANTED_TO_AUTHENTICATED.has('fn_ca_commerce_execute_approved_refunds')).toBe(false);
    expect(GRANTED_TO_AUTHENTICATED.has('fn_ca_commerce_refund_policy')).toBe(false);
  });

  it('the new doors send every declared key, optional ones as null or their default', async () => {
    const club = '00000000-0000-4000-8000-0000000000d1';
    await ClubCommerceService.requestWrittenQuote('club', club, 4000);
    await ClubCommerceService.withdrawWrittenQuote(club);
    await ClubCommerceService.writtenQuotes('club', club);
    await ClubCommerceService.requestTrialReview('union', club, 'A New Independent Operation');
    await ClubCommerceService.trialReviews('club', club);
    await ClubCommerceService.earningsCoverage('club', club);
    for (const { fn, args } of rpc.calls)
      expect(Object.keys(args).sort(), fn).toEqual(
        SIGNATURES.get(fn)!
          .map((p) => p.name)
          .sort()
      );
    expect(rpc.calls[0].args).toEqual({
      p_scope_kind: 'club',
      p_scope_id: club,
      p_requested_capacity: 4000,
      p_note: null,
    });
    expect(rpc.calls[5].args).toEqual({ p_scope_kind: 'club', p_scope_id: club, p_days: 30 });
    /* The staff doors stay off the owner's page. */
    expect(GRANTED_TO_AUTHENTICATED.has('fn_ca_commerce_written_quote_offer')).toBe(true);
    expect(Object.keys(ClubCommerceService)).not.toContain('offerWrittenQuote');
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
      /* 20260924102040 and 20260924102056 */
      'request_already_open',
      'error_window_passed',
      'no_unused_whole_days',
      'replaced_by_newer_purchase',
      'invalid_reason',
      'operating_access_required',
      'consumer_not_running',
      'unexpected_error',
      /* 20260924182605 and 20260924183657 */
      'catalog_not_visible',
      'rate_limited',
      'written_quote_expired',
      'written_quote_already_requested',
      'statement_too_short',
      'trial_review_already_requested',
      'invalid_window',
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

describe('refunds: the page offers exactly what the migration accepts', () => {
  const checkList = (re: RegExp) => {
    const m = SQL.match(re);
    expect(m, String(re)).not.toBeNull();
    return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };

  it('the reasons are the reason_code CHECK list and the request door list', () => {
    const table = checkList(/reason_code text NOT NULL CHECK \(reason_code IN \(([^)]*)\)\)/);
    const door = checkList(/p_reason NOT IN \(([^)]*)\)/);
    expect(REFUND_REASONS.map((r) => r.code)).toEqual(table);
    expect(door).toEqual(table);
    for (const r of REFUND_REASONS) {
      expect(r.label.includes(EM_DASH) || r.note.includes(EM_DASH)).toBe(false);
      for (const word of `${r.label} ${r.note}`.split(/\s+/))
        expect(word, r.label).toMatch(/^[A-Z0-9(]/);
    }
  });

  it('the ceiling preview fills the same three placeholders the server fills', () => {
    const template = SQL.match(/\('renewal_ceiling', 1, 'Renewal Authorization',\s*'([^']+)'\)/);
    expect(template).not.toBeNull();
    for (const ph of ['{product}', '{ceiling}', '{payer}']) expect(template![1]).toContain(ph);
    expect(ceilingSentence(template![1], 'Up To 250 Approved Members', 1, 1500, false)).toBe(
      'I Authorize Club Arena To Renew Up To 250 Approved Members For Up To 1,500 Diamonds Per Period, Paid From My Diamond Balance, Until I Cancel.'
    );
    expect(ceilingSentence(template![1], 'Union Back Office', 3, 3000, true)).toBe(
      'I Authorize Club Arena To Renew Union Back Office For 3 Covered Clubs For Up To 3,000 Diamonds Per Period, Paid From My Diamond Balance Within My Sponsorship Budget, Until I Cancel.'
    );
    expect(ceilingSentence(null, 'X', 1, 1, false)).toBeNull();
  });

  it('an owed reason always reads in words', () => {
    expect(owedReasonWords('diamond_balance_limit')).toBe('Your Diamond Balance Is At Its Limit');
    expect(owedReasonWords('some_new_wallet_code')).toBe('Some New Wallet Code');
    expect(owedReasonWords(null)).toBe('The Wallet Could Not Receive It Yet');
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
