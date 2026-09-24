/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE COMMERCE DESK SPEAKS THE MIGRATIONS' OWN CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * src/services/CommerceDeskService.ts calls the platform staff doors that
 *   20260922143541_club_and_union_diamond_commerce.sql
 *   20260924033509_club_and_union_diamond_commerce_fixes.sql
 *   20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql
 * install, and several of those doors are replaced by a later file. PostgREST
 * resolves an RPC by its name AND its argument names, so one renamed `p_` key
 * is not a type error anywhere: it is a 404 at the moment staff press Approve.
 *
 * This file reads the SQL text (no database), keeps the LATEST definition of
 * every function across the files in apply order, replays every REVOKE and
 * GRANT in that order, and pins, both ways:
 *
 *   1. every RPC the desk sends is a function whose latest definition takes
 *      exactly the keys sent (every key declared, every required key present,
 *      none undefined), and whose final grant state admits `authenticated`;
 *   2. every refusal code the latest body of each of those doors can return
 *      has staff copy in DESK_REFUSAL_COPY, in Title Case, with no em dash.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  reads: [] as Array<{ table: string; cols: string; ids: unknown[] }>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return { data: { success: true, requests: [] }, error: null };
    }),
    from: vi.fn((table: string) => ({
      select: (cols: string) => ({
        in: async (_col: string, ids: unknown[]) => {
          rpc.reads.push({ table, cols, ids });
          const rows = ids.map((id) =>
            table === 'profiles' ? { id, username: 'staffer' } : { id, name: 'Shark Club' }
          );
          return { data: rows, error: null };
        },
      }),
    })),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import CommerceDeskService, {
  CommerceDeskTransportError,
  DESK_REFUSAL_COPY,
  deskRefusalCopy,
  isRefusal,
  lookupDeskNames,
  lookupHandles,
  nextPriceStep,
  priceRulesFor,
  refundReasonWords,
  type RefundRequest,
} from '../../src/services/CommerceDeskService';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = [
  '20260922143541_club_and_union_diamond_commerce.sql',
  '20260924033509_club_and_union_diamond_commerce_fixes.sql',
  '20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql',
  '20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql',
].map((f) => ({ file: f, sql: readFileSync(resolve(ROOT, 'supabase/migrations', f), 'utf8') }));
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
interface Definition {
  file: string;
  params: Param[];
  body: string;
}

/** The latest CREATE [OR REPLACE] FUNCTION of every fn_ca_commerce_* door. */
const LATEST = new Map<string, Definition>();
for (const { file, sql } of MIGRATIONS) {
  const head =
    /^CREATE (?:OR REPLACE )?FUNCTION public\.(fn_ca_commerce_\w+)\((.*)\) RETURNS [^\n]*\n(?:[^\n]*\n)*?[^\n]*\bAS (\$\w*\$)/gm;
  for (const m of sql.matchAll(head)) {
    const tag = m[3];
    const start = (m.index ?? 0) + m[0].length;
    const end = sql.indexOf(tag, start);
    expect(end, `${m[1]} body in ${file} has no closing ${tag}`).toBeGreaterThan(start);
    LATEST.set(m[1], {
      file,
      params: splitTopLevel(m[2]).map((p) => ({
        name: p.split(/\s+/)[0],
        hasDefault: /\bDEFAULT\b/i.test(p),
      })),
      body: sql.slice(start, end),
    });
  }
}

/**
 * Replay every REVOKE ... ON FUNCTION ... FROM and GRANT EXECUTE ON FUNCTION
 * ... TO in apply order. A CREATE OR REPLACE keeps the grants it had, so the
 * last statement naming a function decides whether `authenticated` may call it.
 */
const AUTHENTICATED_MAY_CALL = new Map<string, boolean>();
for (const { sql } of MIGRATIONS) {
  const stmt = /(REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION)([\s\S]*?)(FROM|TO) ([^;]+);/g;
  for (const m of sql.matchAll(stmt)) {
    if (!/\bauthenticated\b/.test(m[4])) continue;
    const grant = m[1].startsWith('GRANT');
    for (const f of m[2].matchAll(/public\.(fn_ca_commerce_\w+)\(/g))
      AUTHENTICATED_MAY_CALL.set(f[1], grant);
  }
}

/** Every code a door's latest body hands back as `error`. */
function refusalCodes(fn: string): Set<string> {
  const body = LATEST.get(fn)?.body ?? '';
  const codes = new Set<string>();
  // The lookbehind skips `v_x->>'error'`, which reads a field, not a code.
  for (const m of body.matchAll(/(?<!->>)'error',\s*'([a-z_]+)'/g)) codes.add(m[1]);
  return codes;
}

const SCOPE = '00000000-0000-4000-8000-000000000001';

async function exerciseEveryDoor() {
  await CommerceDeskService.catalog();
  await CommerceDeskService.admissionReport();
  await CommerceDeskService.admissionReport(90);
  await CommerceDeskService.refundQueue('requested');
  await CommerceDeskService.refundQueue(null, 50);
  await CommerceDeskService.decideRefund(SCOPE, true, 500, null);
  await CommerceDeskService.decideRefund(SCOPE, false, null, 'Duplicate purchase');
  await CommerceDeskService.draftPrice(
    'capacity_100',
    700,
    'flat',
    null,
    'R2 Section 3.1 Schedule'
  );
  await CommerceDeskService.draftPrice(
    'union_insurance_module',
    200,
    'per_unit_capped',
    1000,
    'R2 3.3'
  );
  await CommerceDeskService.validatePrice(SCOPE);
  await CommerceDeskService.publishPrice(SCOPE, null);
  await CommerceDeskService.publishPrice(SCOPE, '2026-10-01T00:00:00.000Z');
  await CommerceDeskService.retirePrice(SCOPE, null);
  await CommerceDeskService.retirePrice(SCOPE, '2026-10-01T00:00:00.000Z');
  await CommerceDeskService.setProductSupport('capacity_100', false);
  await CommerceDeskService.setSettings({ checkoutEnabled: false, catalogVisible: null });
  await CommerceDeskService.recordComparison({
    sku: 'capacity_100',
    sourceName: 'Example Poker Club Software',
    sourceUrl: 'https://example.com/pricing',
    observedPrice: 49.99,
    observedUnit: 'One Club For 30 Days',
    observedAt: '2026-09-20T00:00:00.000Z',
    conversionNote: 'At One Cent Per Diamond, 49.99 Is 4,999 Diamonds',
    priceVersionId: null,
  });
  await CommerceDeskService.verifyComparison(SCOPE, null);
  await CommerceDeskService.priceVersions(null);
  await CommerceDeskService.priceVersions('capacity_100');
  await CommerceDeskService.comparisonList(null);
  await CommerceDeskService.comparisonList('capacity_100');
}

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.reads.length = 0;
});

describe('CommerceDeskService: every RPC matches the latest migration signature', () => {
  it('parses the definitions it is checked against, latest file winning', () => {
    expect(LATEST.size).toBeGreaterThan(30);
    // Replaced by the refunds migration: the latest body is the one that counts.
    expect(LATEST.get('fn_ca_commerce_price_draft')?.file).toMatch(/^20260924102040_/);
    expect(LATEST.get('fn_ca_commerce_price_publish')?.file).toMatch(/^20260924102040_/);
    expect(LATEST.get('fn_ca_commerce_product_support')?.file).toMatch(/^20260924102040_/);
    expect(LATEST.get('fn_ca_commerce_settings_set')?.file).toMatch(/^20260922143541_/);
    expect(LATEST.get('fn_ca_commerce_price_versions')?.params).toEqual([
      { name: 'p_sku', hasDefault: true },
    ]);
    expect(LATEST.get('fn_ca_commerce_comparison_list')?.params).toEqual([
      { name: 'p_sku', hasDefault: true },
    ]);
    expect(LATEST.get('fn_ca_commerce_refund_decide')?.params.map((p) => p.name)).toEqual([
      'p_request_id',
      'p_approve',
      'p_amount',
      'p_note',
    ]);
    expect(LATEST.get('fn_ca_commerce_price_draft')?.body).toContain("'draft'");
  });

  it('exercises every service door', async () => {
    await exerciseEveryDoor();
    const doors = Object.keys(CommerceDeskService).length;
    expect(new Set(rpc.calls.map((c) => c.fn)).size).toBe(doors);
  });

  it('sends only declared argument keys, every required one, and never undefined', async () => {
    await exerciseEveryDoor();
    for (const { fn, args } of rpc.calls) {
      const def = LATEST.get(fn);
      expect(def, `${fn} is not a function in the migrations`).toBeDefined();
      expect(AUTHENTICATED_MAY_CALL.get(fn), `${fn} is not granted to authenticated`).toBe(true);
      const declared = new Set(def!.params.map((p) => p.name));
      for (const [key, value] of Object.entries(args)) {
        expect(declared.has(key), `${fn} has no parameter ${key}`).toBe(true);
        expect(value, `${fn}.${key} is undefined`).not.toBeUndefined();
      }
      for (const p of def!.params.filter((x) => !x.hasDefault))
        expect(Object.keys(args), `${fn} must send ${p.name}`).toContain(p.name);
    }
  });

  it('never switches admission enforcement from the desk', async () => {
    await CommerceDeskService.setSettings({ checkoutEnabled: null, catalogVisible: true });
    expect(rpc.calls[0]).toEqual({
      fn: 'fn_ca_commerce_settings_set',
      args: {
        p_checkout_enabled: null,
        p_catalog_visible: true,
        p_admission_enforced_from: null,
        p_clear_admission: false,
      },
    });
    // COALESCE keeps the stored value for a null, and the clear flag is false.
    const body = LATEST.get('fn_ca_commerce_settings_set')!.body;
    expect(body).toMatch(
      /admission_enforced_from = CASE WHEN p_clear_admission THEN NULL ELSE COALESCE\(p_admission_enforced_from, admission_enforced_from\) END/
    );
  });

  it('a decision sends the exact four keys', async () => {
    await CommerceDeskService.decideRefund(SCOPE, true, null, null);
    expect(rpc.calls[0]).toEqual({
      fn: 'fn_ca_commerce_refund_decide',
      args: { p_request_id: SCOPE, p_approve: true, p_amount: null, p_note: null },
    });
  });

  it('throws a transport error on an RPC error or an empty answer, and reports it', async () => {
    const { supabase } = await import('../../src/lib/supabase');
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: null,
      error: { message: 'Failed to fetch' },
    } as never);
    await expect(CommerceDeskService.catalog()).rejects.toBeInstanceOf(CommerceDeskTransportError);
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never);
    await expect(CommerceDeskService.refundQueue(null)).rejects.toThrow(/Could Not Be Reached/);
  });
});

describe('DESK_REFUSAL_COPY: every code the desk doors can return has staff copy', () => {
  const DOORS = [
    'fn_ca_commerce_refund_queue',
    'fn_ca_commerce_refund_decide',
    'fn_ca_commerce_price_draft',
    'fn_ca_commerce_price_validate',
    'fn_ca_commerce_price_publish',
    'fn_ca_commerce_price_retire',
    'fn_ca_commerce_product_support',
    'fn_ca_commerce_settings_set',
    'fn_ca_commerce_comparison_record',
    'fn_ca_commerce_comparison_verify',
    'fn_ca_commerce_price_versions',
    'fn_ca_commerce_comparison_list',
    'fn_ca_commerce_admission_report',
  ];
  const codes = new Set(DOORS.flatMap((d) => [...refusalCodes(d)]));

  it('the list of doors is the desk: every door the service calls, and only those', async () => {
    await exerciseEveryDoor();
    const called = new Set(rpc.calls.map((c) => c.fn));
    // The catalog read returns no refusal code; every other door is listed.
    expect([...called].filter((f) => f !== 'fn_ca_commerce_catalog').sort()).toEqual(
      [...DOORS].sort()
    );
  });

  it('finds the refusal codes it guards', () => {
    for (const known of [
      'staff_required',
      'cannot_decide_own_request',
      'exceeds_refundable',
      'note_required',
      'not_draft',
      'not_validated',
      'price_changes_are_prospective',
      'supported_product_needs_a_price',
      'retirement_is_prospective',
      'second_staff_member_required',
      'evidence_already_verified',
      'invalid_source_url',
    ])
      expect(codes).toContain(known);
  });

  it.each([...codes].sort())('%s has copy', (code) => {
    expect(Object.prototype.hasOwnProperty.call(DESK_REFUSAL_COPY, code)).toBe(true);
  });

  it('carries no copy for a code no door returns', () => {
    for (const code of Object.keys(DESK_REFUSAL_COPY)) expect(codes, code).toContain(code);
  });

  it.each(Object.entries(DESK_REFUSAL_COPY))(
    '%s copy is Title Case with no em dash',
    (_code, copy) => {
      expect(copy.includes(EM_DASH)).toBe(false);
      for (const word of copy.split(/\s+/)) {
        const bare = word.replace(/^[("']+/, '');
        if (bare) expect(bare, `"${copy}"`).toMatch(/^[A-Z0-9$]/);
      }
    }
  );

  it('falls back for an unknown code and never reads the prototype', () => {
    expect(deskRefusalCopy('not_a_code', 'Fallback')).toBe('Fallback');
    expect(deskRefusalCopy('constructor', 'Fallback')).toBe('Fallback');
    expect(deskRefusalCopy(undefined, 'Fallback')).toBe('Fallback');
    expect(deskRefusalCopy('second_staff_member_required')).toBe(
      'You Recorded This Evidence. A Second Staff Member Must Verify It'
    );
  });
});

describe('the queue reads what the SQL returns', () => {
  it('the refund request JSON carries every field the desk prints', () => {
    const json = LATEST.get('fn_ca_commerce_refund_request_json')!.body;
    for (const key of [
      'request_id',
      'purchase_id',
      'line_index',
      'scope_kind',
      'scope_id',
      'payer_id',
      'requested_by',
      'reason_code',
      'details',
      'policy_version',
      'policy_basis',
      'policy_amount',
      'policy_detail',
      'state',
      'approved_amount',
      'decided_at',
      'decision_note',
      'owed_reason',
      'last_error',
      'attempts',
      'executed_at',
      'created_at',
    ])
      expect(json, key).toContain(`'${key}'`);
    // The policy detail the request recorded (unused days, right dates, right started).
    const policy = LATEST.get('fn_ca_commerce_refund_policy')!.body;
    for (const key of [
      'line_net',
      'refundable',
      'purchased_at',
      'right_starts_at',
      'right_ends_at',
      'right_started',
      'sponsored',
      'unused_days',
      'period_days',
    ])
      expect(policy, key).toContain(`'${key}'`);
  });

  it('every state and reason the table allows has a label', async () => {
    const { REFUND_STATE_LABEL, REFUND_REASON_LABEL, REFUND_BASIS_LABEL } =
      await import('../../src/services/CommerceDeskService');
    const table = MIGRATIONS[2].sql.match(
      /CREATE TABLE public\.ca_commerce_refund_requests \(([\s\S]*?)\n\);/
    )![1];
    const listOf = (col: string) =>
      [
        ...table
          .match(new RegExp(`${col} text[^\\n]*CHECK \\(${col} IN \\(([^)]*)\\)\\)`))![1]
          .matchAll(/'([a-z_]+)'/g),
      ].map((m) => m[1]);
    expect(Object.keys(REFUND_STATE_LABEL).sort()).toEqual(listOf('state').sort());
    expect(Object.keys(REFUND_REASON_LABEL).sort()).toEqual(listOf('reason_code').sort());
    expect(Object.keys(REFUND_BASIS_LABEL).sort()).toEqual(listOf('policy_basis').sort());
  });

  it('names people, clubs and unions best effort, one read each', async () => {
    const r = (o: Partial<RefundRequest>) => ({ ...o }) as RefundRequest;
    const names = await lookupDeskNames([
      r({ payer_id: 'p1', requested_by: 'p1', scope_kind: 'club', scope_id: 'c1' }),
      r({ payer_id: 'p2', requested_by: 'p3', scope_kind: 'union', scope_id: 'u1' }),
    ]);
    expect(rpc.reads.map((x) => x.table).sort()).toEqual(['clubs', 'profiles', 'unions']);
    expect(rpc.reads.find((x) => x.table === 'profiles')!.ids).toEqual(['p1', 'p2', 'p3']);
    expect(names.people.p3).toBe('staffer');
    expect(names.clubs.c1).toBe('Shark Club');
    expect(names.unions.u1).toBe('Shark Club');
  });
});

describe('the catalog and evidence read what the staff reads return', () => {
  /** Keys a jsonb_build_object in a body names, so `'key', value` pairs. */
  const keysIn = (fn: string) =>
    new Set([...LATEST.get(fn)!.body.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]));

  it('every price version field the desk prints is built by fn_ca_commerce_price_versions', () => {
    const keys = keysIn('fn_ca_commerce_price_versions');
    for (const key of [
      'price_versions',
      'price_version_id',
      'sku',
      'version',
      'status',
      'diamonds',
      'price_rule',
      'cap_diamonds',
      'price_authority',
      'effective_from',
      'effective_to',
      'created_by',
      'published_by',
      'published_at',
      'comparison_verified',
      'in_effect',
      'created_at',
    ])
      expect(keys, key).toContain(key);
    // Newest first, as the desk lists them.
    expect(LATEST.get('fn_ca_commerce_price_versions')!.body).toMatch(
      /ORDER BY v\.created_at DESC/
    );
  });

  it('every evidence field the desk prints is built by fn_ca_commerce_comparison_list', () => {
    const keys = keysIn('fn_ca_commerce_comparison_list');
    for (const key of [
      'evidence',
      'evidence_id',
      'sku',
      'source_name',
      'source_url',
      'observed_price',
      'observed_unit',
      'observed_at',
      'conversion_note',
      'price_version_id',
      'recorded_by',
      'recorded_by_name',
      'recorded_at',
      'verified_by',
      'verified_by_name',
      'verified_at',
      'verified',
    ])
      expect(keys, key).toContain(key);
  });

  it('product support answers with the open quotes it withdrew', () => {
    expect(LATEST.get('fn_ca_commerce_product_support')!.body).toMatch(
      /RETURN jsonb_build_object\('success', true, 'sku', p_sku, 'supported', p_supported, 'quotes_withdrawn', v_withdrawn\)/
    );
  });

  it('the two reads are staff only, and refuse with a code the desk has copy for', () => {
    for (const fn of ['fn_ca_commerce_price_versions', 'fn_ca_commerce_comparison_list']) {
      expect(LATEST.get(fn)!.body).toContain('fn_is_platform_admin()');
      expect([...refusalCodes(fn)]).toEqual(['staff_required']);
    }
  });

  it('nextPriceStep follows the lifecycle the doors enforce', () => {
    expect(LATEST.get('fn_ca_commerce_price_validate')!.body).toContain("IF v_v.status <> 'draft'");
    expect(LATEST.get('fn_ca_commerce_price_publish')!.body).toContain("v_v.status <> 'validated'");
    expect(nextPriceStep('draft')).toBe('validate');
    expect(nextPriceStep('validated')).toBe('publish');
    expect(nextPriceStep('published')).toBe('retire');
    expect(nextPriceStep('retired')).toBeNull();
  });

  it('lookupHandles reads each staff id once, best effort', async () => {
    const h = await lookupHandles(['s1', null, 's1', 's2']);
    expect(rpc.reads).toEqual([
      { table: 'profiles', cols: 'id, username, alias', ids: ['s1', 's2'] },
    ]);
    expect(h).toEqual({ s1: 'staffer', s2: 'staffer' });
    rpc.reads.length = 0;
    expect(await lookupHandles([null])).toEqual({});
    expect(rpc.reads).toEqual([]);
  });
});

describe('helpers', () => {
  it('priceRulesFor offers only what fn_ca_commerce_price_validate accepts', () => {
    const body = LATEST.get('fn_ca_commerce_price_validate')!.body;
    expect(body).toContain("(v_product.quantity_unit = 'flat' AND v_v.price_rule <> 'flat')");
    expect(body).toContain(
      "(v_product.quantity_unit = 'covered_club' AND v_v.price_rule NOT IN ('per_unit','per_unit_capped'))"
    );
    expect(priceRulesFor('flat')).toEqual(['flat']);
    expect(priceRulesFor('covered_club')).toEqual(['per_unit', 'per_unit_capped']);
  });

  it('refundReasonWords prints a wallet reason as words, never raw', () => {
    expect(refundReasonWords('diamond_balance_limit')).toBe('Diamond Balance Limit');
    expect(refundReasonWords('staff_required: detail')).toBe(DESK_REFUSAL_COPY.staff_required);
    expect(refundReasonWords(null)).toBe('');
  });

  it('isRefusal recognises only success === false', () => {
    expect(isRefusal({ success: false, error: 'not_draft' })).toBe(true);
    expect(isRefusal({ success: true })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

describe('the desk carries no em dash', () => {
  it.each([
    'src/pages/admin/CommerceDeskPage.tsx',
    'src/pages/admin/CommerceDeskPage.module.css',
    'src/services/CommerceDeskService.ts',
  ])('%s', (file) => {
    expect(readFileSync(resolve(ROOT, file), 'utf8').includes(EM_DASH)).toBe(false);
  });

  it('and no hover rule', () => {
    const css = readFileSync(resolve(ROOT, 'src/pages/admin/CommerceDeskPage.module.css'), 'utf8');
    expect(css).not.toMatch(/:hover/);
  });
});
