/**
 * A MONEY DOOR NOTHING CALLS IS CLOSED, AND EVERY MANUAL MOVEMENT IS ON THE
 * REPORT.
 *
 * Chip Accounting Standard, Phase 2, lane 2.5 (F9 + F10 advisory), 2026-09-03.
 * Audit: docs/audits/2026-09-02-chip-standard-round2/lane2-hierarchy.md 2.2
 * and 3.1.
 *
 * F9. Seven RPCs that move chips had EXECUTE grants and, the audit said, no
 * callers. Re-verified against the live grants, both repos, pg_proc, pg_cron
 * and 30 days of ledger rows, TWO were dead by every measure:
 *
 *   fn_wallet_claim_back         - authenticated could pull ANY amount from
 *                                  ANY downline player, no window, no consent.
 *                                  Zero callers, zero rows in 30 days.
 *   fn_union_send_chips_to_club  - pays a union distribution into the club
 *                                  OWNER's pocket. Zero callers, zero rows.
 *
 * The other five are NOT touched, because the lane rule is "a caller or a
 * call in 30 days means do not touch": fn_union_send_to_club_atomic (World
 * Hub union-wallet.js), fn_union_deposit_from_wallet (UnionDashboardPage),
 * calculate_cascading_commission (settle_hand_atomically, record-rake.js,
 * LobbyManager.js, CommissionService.ts), mint_club_chips (a textual caller
 * in World Hub mint-chips.js marked unreachable), fn_cashier_claim_back (one
 * 1.00-chip call on 2026-08-21, inside the window; eligible 2026-09-21).
 *
 * The rules this pins, each a way the closure could quietly reopen:
 *
 *   - both doors are REVOKED from PUBLIC, anon, authenticated AND
 *     service_role (nothing calls them, so no role keeps a key);
 *   - nothing is DROPPED (the roadmap drops after one clean week; a revoke is
 *     reversible in one statement if a caller surfaces);
 *   - the five live doors are not named by any REVOKE, GRANT or DROP;
 *   - both are registered `closed` in ca_money_rpc_registry, and
 *     fn_ca_money_rpc_drift raises an incident when a closed door is
 *     executable by anon, authenticated or service_role again - while still
 *     carrying its original unregistered-writer scan;
 *   - no quoted call to either function exists in src/, server/src/ or
 *     supabase/functions/ (a quoted name is how supabase.rpc() names one).
 *
 * F10, ADVISORY ONLY. Dan has not set the four-eyes threshold (roadmap
 * decision 6). fn_ca_adjustments_report is the READ side and nothing more:
 *
 *   - SECURITY DEFINER, revoked from PUBLIC/anon/authenticated, granted to
 *     service_role, with the management gate fn_ca_post_correction uses
 *     (ca_incident_recipients, or profiles.role in admin/god);
 *   - it writes nothing: no INSERT, UPDATE or DELETE anywhere in its body;
 *   - it schedules nothing: no cron.schedule in the file;
 *   - it enforces no threshold: its only RAISE is the management gate;
 *   - single_actor is derived from ca_manual_adjustments, so the day an
 *     approver row exists the report already knows how to read it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) => f.includes('two_orphan_money_doors_are_closed'));
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

const CLOSED = ['fn_wallet_claim_back', 'fn_union_send_chips_to_club'] as const;
const NOT_TOUCHED = [
  'fn_cashier_claim_back',
  'fn_union_send_to_club_atomic',
  'fn_union_deposit_from_wallet',
  'mint_club_chips',
  'calculate_cascading_commission',
] as const;

/** A function body, bounded by its own dollar-quoted block. */
function body(fn: string): string {
  const open = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, `${fn} is not dollar-quoted as expected`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

/** Every line of SQL that is a REVOKE, GRANT or DROP statement (comments stripped). */
function grantLines(): string[] {
  return SQL.split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => /^(REVOKE|GRANT|DROP)\b/i.test(l));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

describe('F9: the two dead doors are closed, not dropped, and the live ones are untouched', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the lane 2.5 migration is missing').toBeTruthy();
  });

  it.each(CLOSED)(
    '%s is revoked from PUBLIC, anon, authenticated and service_role with its exact signature',
    (fn) => {
      const sig =
        fn === 'fn_wallet_claim_back'
          ? 'uuid, uuid, numeric, text, text, text, text'
          : 'uuid, uuid, numeric, text';
      const re = new RegExp(
        `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\(${sig.replace(/[()]/g, '\\$&')}\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role;`,
        'i'
      );
      expect(SQL).toMatch(re);
    }
  );

  it('drops nothing - the roadmap drops after one clean week', () => {
    const drops = grantLines().filter((l) => /^DROP\b/i.test(l));
    // The only DROP in the file is the CHECK constraint being widened.
    expect(
      drops.every((l) =>
        /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+ca_money_rpc_registry_status_check/i.test(l)
      ),
      drops.join('\n')
    ).toBe(true);
    expect(SQL).not.toMatch(/DROP\s+FUNCTION/i);
  });

  it.each(NOT_TOUCHED)('%s is not named by any REVOKE, GRANT or DROP', (fn) => {
    for (const line of grantLines()) {
      expect(line, `a grant statement names ${fn}`).not.toContain(fn);
    }
  });

  it('marks both closed doors `closed` in ca_money_rpc_registry and teaches the CHECK that word', () => {
    expect(SQL).toMatch(
      /ADD\s+CONSTRAINT\s+ca_money_rpc_registry_status_check[\s\S]*'closed'::text/i
    );
    const upd = SQL.match(
      /UPDATE\s+public\.ca_money_rpc_registry\s+SET\s+status\s*=\s*'closed'[\s\S]*?WHERE\s+proname\s+IN\s*\(([^)]*)\)/i
    );
    expect(upd, 'the registry UPDATE is missing').toBeTruthy();
    for (const fn of CLOSED) expect(upd![1]).toContain(`'${fn}'`);
    for (const fn of NOT_TOUCHED) expect(upd![1]).not.toContain(`'${fn}'`);
  });

  it('fn_ca_money_rpc_drift keeps its unregistered-writer scan and gains the closed-door scan', () => {
    const b = body('fn_ca_money_rpc_drift');
    expect(b).toContain("'rpc-drift:' || r.pn");
    expect(b).toContain("'rpc-closed-door-open:' || r.pn");
    expect(b).toMatch(/g\.status\s*=\s*'closed'/);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(b).toContain(`has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
    // Both scans report through the same incident path, so the daily cron
    // and the epoch gates see closed-door drift exactly like writer drift.
    expect((b.match(/fn_ca_raise_drift_incident\(/g) || []).length).toBe(2);
    expect((b.match(/proname := r\.pn; RETURN NEXT;/g) || []).length).toBe(2);
  });

  it.each(CLOSED)('%s has no quoted caller in src/, server/src/ or supabase/functions/', (fn) => {
    const files = [
      ...walk(resolve(ROOT, 'src')),
      ...walk(resolve(ROOT, 'server/src')),
      ...walk(resolve(ROOT, 'supabase/functions')),
    ];
    const quoted = new RegExp(`['"\`]${fn}['"\`]`);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes(fn)) continue;
      text.split('\n').forEach((line, i) => {
        if (quoted.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      hits,
      `a quoted call to ${fn} is back in the repo - it was revoked from every role`
    ).toEqual([]);
  });
});

describe('F10 advisory: fn_ca_adjustments_report reads, and only reads', () => {
  it('is SECURITY DEFINER, service_role only, with the management gate', () => {
    const head = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_adjustments_report('),
      SQL.indexOf(
        '$function$',
        SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_adjustments_report(')
      )
    );
    expect(head).toMatch(/SECURITY\s+DEFINER/);
    expect(head).toMatch(/SET\s+search_path\s+TO\s+'public',\s*'pg_temp'/);
    expect(SQL).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.fn_ca_adjustments_report\(timestamptz\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.fn_ca_adjustments_report\(timestamptz\)\s+TO\s+service_role;/
    );
    const b = body('fn_ca_adjustments_report');
    expect(b).toContain('public.ca_incident_recipients');
    expect(b).toMatch(/p\.role\s+IN\s*\('admin','god'\)/);
    expect(b).toContain("RAISE EXCEPTION 'management_only'");
  });

  it('writes nothing, schedules nothing, enforces nothing', () => {
    const b = body('fn_ca_adjustments_report');
    const code = b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\w+(\.\w+)?\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bPERFORM\b/i);
    expect(SQL).not.toMatch(/cron\.schedule/i);
    // The only RAISE is the gate; no threshold is enforced here.
    expect((code.match(/RAISE\s+EXCEPTION/gi) || []).length).toBe(1);
    expect(code).not.toMatch(/threshold/i);
  });

  it('reads every declared source and derives single_actor from ca_manual_adjustments', () => {
    const b = body('fn_ca_adjustments_report');
    for (const t of [
      'public.chip_transactions',
      'public.union_wallet_transactions',
      'public.ca_mint_ledger',
      'public.chip_ledger',
    ]) {
      expect(b).toContain(`FROM ${t}`);
    }
    for (const cat of [
      'mint',
      'club_bank_send',
      'club_bank_claim',
      'agent_send',
      'agent_claim',
      'union_settlement',
      'union_send',
      'correction',
      'reversal',
    ]) {
      expect(b).toContain(`'${cat}'`);
    }
    // 148,000 auto-audited trigger rows a week are table activity, not actors.
    expect(b).toMatch(
      /l\.category\s*=\s*'adjustment'\s+AND\s+COALESCE\(l\.description,\s*''\)\s+NOT\s+LIKE\s+'auto-%'/
    );
    expect(b).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.ca_manual_adjustments/);
    expect(b).toMatch(/a\.approver\s+IS\s+DISTINCT\s+FROM\s+m\.actor/);
    expect(b).toMatch(/\)\s+AS\s+single_actor/);
    // Nothing below zero is a movement.
    expect((b.match(/\.amount\s*>\s*0/g) || []).length).toBe(4);
  });
});

describe('the migration proves itself before it commits', () => {
  it('has a self-check DO block that raises when the live state lacks the change', () => {
    const doStart = SQL.lastIndexOf('DO $$');
    expect(doStart).toBeGreaterThan(-1);
    const check = SQL.slice(doStart);
    for (const fn of CLOSED) expect(check).toContain(`'${fn}'`);
    expect(check).toContain('is still executable by a client role or service_role');
    expect(check).toContain('is not registered as closed');
    expect(check).toContain('rpc-closed-door-open:');
    expect(check).toContain('fn_ca_adjustments_report must not be executable by a browser role');
    expect(check).toContain('fn_agent_wallet_send must remain executable by authenticated');
  });

  it('carries no em dash', () => {
    expect(SQL.includes('\u2014')).toBe(false);
  });
});
