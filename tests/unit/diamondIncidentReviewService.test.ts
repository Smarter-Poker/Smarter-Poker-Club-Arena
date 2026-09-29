/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND INCIDENT REVIEW SERVICE SPEAKS THE MIGRATION'S OWN CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * src/services/DiamondIncidentReviewService.ts calls the four platform staff
 * doors that 20260929211500_a_person_can_review_a_diamond_incident.sql
 * installs. PostgREST resolves an RPC by its name AND its argument names, so
 * one renamed `p_` key is not a type error anywhere: it is a 404 at the moment
 * staff press Resolve.
 *
 * This file reads the SQL text (no database) and pins, both ways:
 *   1. every RPC the service sends is a door the migration creates, takes
 *      exactly the keys sent (every declared key sent, none undefined), and is
 *      granted to `authenticated` and never to `anon`;
 *   2. every refusal code those doors can return has staff copy in
 *      INCIDENT_REFUSAL_COPY, in Title Case, with no em dash, and no copy is
 *      kept for a code no door returns.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  next: null as null | { data: unknown; error: unknown },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return rpc.next ?? { data: { success: true }, error: null };
    }),
  },
}));

const reported = vi.hoisted(() => ({ where: [] as string[] }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn((_e: unknown, where: string) => reported.where.push(where)),
}));

import DiamondIncidentReviewService, {
  DiamondIncidentTransportError,
  INCIDENT_REFUSAL_COPY,
  incidentRefusalCopy,
  isRefusal,
} from '../../src/services/DiamondIncidentReviewService';

const MIGRATION = '20260929211500_a_person_can_review_a_diamond_incident.sql';
const SQL = readFileSync(resolve(__dirname, '../..', 'supabase/migrations', MIGRATION), 'utf8');
const EM_DASH = String.fromCharCode(0x2014);
const DOORS = [
  'fn_ca_diamond_incident_board',
  'fn_ca_diamond_incident_trail',
  'fn_ca_diamond_incident_review',
  'fn_ca_diamond_incident_resolve_family',
];

type Param = { name: string; hasDefault: boolean };
interface Definition {
  params: Param[];
  body: string;
}

/** Split a parameter list on top level commas. */
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

/** Every function the migration creates, with its parameters and its body. */
const DEFS = new Map<string, Definition>();
for (const m of SQL.matchAll(
  /^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\) RETURNS [\s\S]*?\bAS (\$\w*\$)/gm
)) {
  const start = (m.index ?? 0) + m[0].length;
  const end = SQL.indexOf(m[3], start);
  DEFS.set(m[1], {
    params: splitTopLevel(m[2]).map((p) => ({
      name: p.split(/\s+/)[0],
      hasDefault: /\bDEFAULT\b/i.test(p),
    })),
    body: SQL.slice(start, end),
  });
}

/** Who the migration's GRANT EXECUTE statements admit, per function. */
const GRANTED = new Map<string, Set<string>>();
for (const m of SQL.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)\bTO ([^;]+);/g)) {
  const roles = m[2].split(',').map((r) => r.trim());
  for (const f of m[1].matchAll(/public\.(\w+)\(/g)) {
    const set = GRANTED.get(f[1]) ?? new Set<string>();
    roles.forEach((r) => set.add(r));
    GRANTED.set(f[1], set);
  }
}

/** Every code a door's body hands back as `error`. */
function refusalCodes(fn: string): Set<string> {
  const codes = new Set<string>();
  for (const m of (DEFS.get(fn)?.body ?? '').matchAll(/(?<!->>)'error',\s*'([a-z_]+)'/g))
    codes.add(m[1]);
  return codes;
}

async function exerciseEveryDoor() {
  const S = DiamondIncidentReviewService;
  await S.board({ status: 'unresolved', rule: null, severity: null, beforeId: null });
  await S.board({ status: null, rule: 'DR7', severity: 'warning', beforeId: 227302, limit: 20 });
  await S.trail(42);
  await S.acknowledge(42, null);
  await S.comment(42, 'Looked At The Ledger');
  await S.resolve(42, 'A fixture account, not a player');
  await S.reopen(42, 'The cause came back this morning');
  await S.resolveFamily('DR7', 'warning', '2026-09-29T20:47:00.000Z', 'Every one predates the cap');
  await S.resolveFamily('DR7:user_over_daily_cap', null, null, 'One reason for the whole rule');
}

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.next = null;
  reported.where.length = 0;
});

describe('the Diamond incident review service speaks the migration contract', () => {
  it('finds the four doors, granted to authenticated and never to anon', () => {
    for (const door of DOORS) {
      expect(DEFS.has(door), door).toBe(true);
      expect([...(GRANTED.get(door) ?? [])].sort(), door).toEqual([
        'authenticated',
        'service_role',
      ]);
    }
    for (const [fn, roles] of GRANTED) expect(roles.has('anon'), fn).toBe(false);
    expect(DEFS.get('fn_ca_diamond_incident_board')?.params.map((p) => p.name)).toEqual([
      'p_status',
      'p_rule',
      'p_severity',
      'p_before_id',
      'p_limit',
    ]);
    expect(DEFS.get('fn_ca_diamond_incident_review')?.params.map((p) => p.name)).toEqual([
      'p_incident_id',
      'p_action',
      'p_note',
    ]);
    expect(DEFS.get('fn_ca_diamond_incident_resolve_family')?.params).toEqual([
      { name: 'p_family', hasDefault: false },
      { name: 'p_severity', hasDefault: false },
      { name: 'p_filed_before', hasDefault: false },
      { name: 'p_reason', hasDefault: false },
    ]);
  });

  it('calls every door, and nothing else', async () => {
    await exerciseEveryDoor();
    expect([...new Set(rpc.calls.map((c) => c.fn))].sort()).toEqual([...DOORS].sort());
  });

  it('sends every declared key and no other, never undefined', async () => {
    await exerciseEveryDoor();
    for (const { fn, args } of rpc.calls) {
      const declared = DEFS.get(fn)!.params.map((p) => p.name);
      expect(Object.keys(args).sort(), fn).toEqual([...declared].sort());
      for (const [key, value] of Object.entries(args))
        expect(value, `${fn}.${key} is undefined`).not.toBeUndefined();
    }
  });

  it('sends each review as its own action, and the board a limit by default', async () => {
    await exerciseEveryDoor();
    const actions = rpc.calls
      .filter((c) => c.fn === 'fn_ca_diamond_incident_review')
      .map((c) => c.args.p_action);
    expect(actions).toEqual(['acknowledge', 'comment', 'resolve', 'reopen']);
    const review = DEFS.get('fn_ca_diamond_incident_review')!.body;
    for (const action of actions) expect(review).toContain(`'${action}'`);
    expect(rpc.calls[0].args).toEqual({
      p_status: 'unresolved',
      p_rule: null,
      p_severity: null,
      p_before_id: null,
      p_limit: 50,
    });
  });

  it('throws a reported transport error when the call fails or answers nothing', async () => {
    rpc.next = { data: null, error: { message: 'network' } };
    await expect(DiamondIncidentReviewService.trail(1)).rejects.toBeInstanceOf(
      DiamondIncidentTransportError
    );
    rpc.next = { data: null, error: null };
    await expect(DiamondIncidentReviewService.resolve(1, 'a written reason')).rejects.toThrow(
      'The Server Could Not Be Reached To Resolve The Incident'
    );
    expect(reported.where).toEqual([
      'DiamondIncidentReviewService.fn_ca_diamond_incident_trail',
      'DiamondIncidentReviewService.fn_ca_diamond_incident_review',
    ]);
  });

  it('hands a refusal back as a refusal, in staff words', async () => {
    rpc.next = { data: { success: false, error: 'staff_required' }, error: null };
    const res = await DiamondIncidentReviewService.board({
      status: null,
      rule: null,
      severity: null,
      beforeId: null,
    });
    expect(isRefusal(res)).toBe(true);
    expect(isRefusal({ success: true })).toBe(false);
    expect(incidentRefusalCopy(isRefusal(res) ? res.error : null)).toBe(
      'Only Platform Staff Can Review Diamond Incidents'
    );
  });
});

describe('every refusal a review door can return has staff copy', () => {
  const codes = new Set(DOORS.flatMap((d) => [...refusalCodes(d)]));

  it('reads the codes from the doors', () => {
    for (const known of [
      'staff_required',
      'authentication_required',
      'reason_required',
      'already_resolved',
      'not_resolved',
      'nothing_to_resolve',
    ])
      expect(codes).toContain(known);
  });

  it.each([...codes].sort())('%s has copy', (code) => {
    expect(Object.prototype.hasOwnProperty.call(INCIDENT_REFUSAL_COPY, code)).toBe(true);
  });

  it('carries no copy for a code no door returns', () => {
    for (const code of Object.keys(INCIDENT_REFUSAL_COPY)) expect(codes, code).toContain(code);
  });

  it.each(Object.entries(INCIDENT_REFUSAL_COPY))(
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
    expect(incidentRefusalCopy('not_a_code', 'Fallback')).toBe('Fallback');
    expect(incidentRefusalCopy('constructor', 'Fallback')).toBe('Fallback');
    expect(incidentRefusalCopy(undefined)).toBe('The Server Refused That Review');
  });
});
