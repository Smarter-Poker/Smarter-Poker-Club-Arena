/**
 * LAW: AN ADMIN MONEY PAGE NAMES ITS CLUB BEFORE IT READS A NUMBER (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five global-path pages render club money - /financial-admin,
 * /settlement-dashboard, /settlement-history, /credit-admin, /rate-audit -
 * and until 2026-09-10 not one of them said WHICH club. Each read a
 * club-keyed table with no club filter, so a two-club operator saw both
 * clubs summed, a union overseer saw the whole union labelled as one club,
 * and the credit console was open to anybody who was staff of ANY club.
 * Several also discarded the read's error, so a refused query rendered as
 * "nobody is owed anything".
 *
 * The one answer is `useFinancialAdminScope` (built on the shared
 * `resolvePageClubId` / `pickPreferredClubId` / `getClubNavigationCapabilities`
 * pieces) and `clubScoped()`, which refuses to build a query before the scope
 * is ready. This law pins that:
 *
 *   1. every admin money page calls the hook and renders the non-ready gate;
 *   2. every read of a club-keyed money table on those pages goes through
 *      `clubScoped(` and binds its error;
 *   3. `clubScoped` throws rather than issuing an unscoped read;
 *   4. the hook is built from the existing scoping pieces, not a fresh guess;
 *   5. TransactionLedgerView refuses a read with no union, club or player;
 *   6. the routes that used to be AuthGuard-only carry their role guard, and
 *      an env flag can no longer drop AuthGuard from a route.
 *
 * If you are adding a money read to one of these pages, wrap it in
 * `clubScoped(query, scopeKey)` and bind `error`. If you are adding a sixth
 * admin money page, add it to ADMIN_MONEY_PAGES here in the same commit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clubScoped } from '../src/hooks/useFinancialAdminScope';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ADMIN_MONEY_PAGES = [
  'src/pages/FinancialAdminHub.tsx',
  'src/pages/SettlementDashboardPage.tsx',
  'src/pages/SettlementHistoryPage.tsx',
  'src/pages/CreditAdminPanel.tsx',
  'src/pages/RateAuditPage.tsx',
];

/** Tables that carry a club_id and hold money or money-adjacent records. */
const CLUB_KEYED_MONEY_TABLES = [
  'agents',
  'agent_commissions',
  'chip_ledger',
  'commission_rate_audit',
  'disputes',
  'rake_rate_audit',
  'rake_records',
  'settlement_invoices',
  'settlement_periods',
];

function statementsAround(source: string, table: string): string[] {
  const needle = `.from('${table}')`;
  const out: string[] = [];
  let idx = source.indexOf(needle);
  while (idx !== -1) {
    const start = source.lastIndexOf(';', idx) + 1;
    const end = source.indexOf(';', idx + needle.length);
    out.push(source.slice(start, end === -1 ? undefined : end + 240));
    idx = source.indexOf(needle, idx + needle.length);
  }
  return out;
}

describe('LAW: an admin money page names its club before it reads a number', () => {
  for (const page of ADMIN_MONEY_PAGES) {
    const source = read(page);

    it(`${page} resolves its scope through useFinancialAdminScope and gates on it`, () => {
      expect(source).toMatch(/useFinancialAdminScope\(\)/);
      expect(source).toMatch(/from '\.\.\/hooks\/useFinancialAdminScope'/);
      expect(source).toMatch(/<FinancialAdminScopeState scope=\{scope\} \/>/);
      expect(source).toMatch(/scope\.status !== 'ready'/);
    });

    for (const table of CLUB_KEYED_MONEY_TABLES) {
      const statements = statementsAround(source, table);
      if (statements.length === 0) continue;
      it(`${page}: every read of ${table} goes through clubScoped() and binds its error`, () => {
        for (const statement of statements) {
          expect(statement, `unscoped read of ${table}:\n${statement}`).toContain('clubScoped(');
          expect(statement, `error discarded on read of ${table}:\n${statement}`).toMatch(/error/);
        }
      });
    }

    it(`${page} never destructures data alone from a money read`, () => {
      const bare =
        source.match(/const \{ (?:data|count)(?:: [A-Za-z_]+)? \} = await supabase[^;]*;/g) || [];
      for (const hit of bare) {
        for (const table of CLUB_KEYED_MONEY_TABLES) {
          expect(hit, `bare destructure on ${table}: ${hit}`).not.toContain(`.from('${table}')`);
        }
        expect(hit, `bare destructure on an RPC: ${hit}`).not.toContain('.rpc(');
      }
    });
  }

  it('clubScoped refuses to build a query before the scope is ready, and filters otherwise', () => {
    const calls: Array<[string, string]> = [];
    const query = {
      eq(column: string, value: string) {
        calls.push([column, value]);
        return query;
      },
    };
    expect(() =>
      clubScoped(query, { status: 'loading', clubId: null, platformWide: false })
    ).toThrow();
    expect(() =>
      clubScoped(query, { status: 'denied', clubId: null, platformWide: false })
    ).toThrow();
    expect(() =>
      clubScoped(query, { status: 'ready', clubId: null, platformWide: false })
    ).toThrow();
    expect(calls).toEqual([]);

    expect(clubScoped(query, { status: 'ready', clubId: null, platformWide: true })).toBe(query);
    expect(calls).toEqual([]);

    const clubId = '11111111-1111-4111-8111-111111111111';
    expect(clubScoped(query, { status: 'ready', clubId, platformWide: false })).toBe(query);
    expect(calls).toEqual([['club_id', clubId]]);
  });

  it('the scope hook is built from the existing scoping pieces and fails closed', () => {
    const hook = read('src/hooks/useFinancialAdminScope.ts');
    expect(hook).toContain("from '../utils/resolvePageClubId'");
    expect(hook).toMatch(/resolvePageClubId\(\{/);
    expect(hook).toMatch(/allowFallback: false/);
    expect(hook).toMatch(/pickPreferredClubId\(/);
    expect(hook).toMatch(/getClubNavigationCapabilities\([^)]*\)\.canViewFinance/);
    expect(hook).toMatch(/isPlatformStaffRole\(/);
    // A profile that could not be read is not staff.
    expect(hook).toMatch(/!profileResult\.error && isPlatformStaffRole/);
    // The finance-role fallback is role-filtered, never "any membership".
    expect(hook).toMatch(/\.in\('role', \[\.\.\.CLUB_FINANCE_ROLES\]\)/);
  });

  it('TransactionLedgerView refuses a ledger read with no union, club or player', () => {
    const view = read('src/components/common/TransactionLedgerView.tsx');
    const guard = view.indexOf('if (!unionId && !clubId && !userId)');
    const readIdx = view.indexOf(".from('chip_ledger')");
    expect(guard).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(guard);
    // The settlement dashboard mounts it with a scope, never bare.
    const dashboard = read('src/pages/SettlementDashboardPage.tsx');
    expect(dashboard).not.toMatch(/<TransactionLedgerView limit=\{\d+\} \/>/);
    expect(dashboard).toMatch(/<TransactionLedgerView clubId=\{scopeClubId\} clubScoped/);
  });

  it('the admin routes that were AuthGuard-only carry their role guard', () => {
    const app = read('src/App.tsx');
    const routeElement = (path: string): string => {
      const at = app.indexOf(`path="${path}"`);
      expect(at, `route ${path} exists`).toBeGreaterThan(-1);
      return app.slice(at, app.indexOf('/>', app.indexOf('element={', at)));
    };
    expect(routeElement('engine')).toContain('<PlatformStaffGuard>');
    expect(routeElement('financial-alerts')).toContain('<PlatformStaffGuard>');
    expect(routeElement('financial-incidents')).toContain('<FinancialAdminGate>');
    for (const suffix of ['operations', 'table-management', 'data', 'statements', 'settlement']) {
      expect(routeElement(`unions/:unionId/${suffix}`)).toContain('<UnionOverseerGuard>');
    }
    // The club settlement route keeps its member guard; the union twin now
    // carries the overseer guard - neither is an open door.
    expect(routeElement('clubs/:clubId/settlement')).toContain('<ClubMemberGuard>');
  });

  it('an env flag never removes AuthGuard from a route', () => {
    const app = read('src/App.tsx');
    const at = app.indexOf('path="dev/game-cards"');
    const element = app.slice(at, app.indexOf('/>', app.indexOf('element={', at)));
    expect(element).toContain('<AuthGuard>');
    expect(element).not.toContain('clubButtonsPreviewEnabled ?');
    // Generally: no route element may choose between a guarded and an
    // unguarded render of the SAME page on a build flag.
    const flagTernaries =
      app.match(
        /\w+Enabled \? \(\s*<PageErrorBoundary pageName="([^"]+)">\s*<(\w+) \/>[\s\S]*?<AuthGuard>\s*<PageErrorBoundary pageName="[^"]+">\s*<(\w+) \/>/g
      ) || [];
    for (const hit of flagTernaries) {
      const pages = hit.match(/<(\w+) \/>/g) || [];
      expect(pages[0], `flag drops AuthGuard from ${pages[0]}:\n${hit}`).not.toBe(pages[1]);
    }
  });

  it('the guards fail closed', () => {
    const staff = read('src/components/auth/PlatformStaffGuard.tsx');
    expect(staff).toMatch(/if \(allowed === null\) return/);
    expect(staff).toMatch(/if \(!allowed\) return <Navigate/);
    expect(staff).toMatch(/if \(!cancelled\) setAllowed\(false\)/);
    const union = read('src/components/auth/UnionOverseerGuard.tsx');
    expect(union).toContain("supabase.rpc('ca_can_oversee_union'");
    expect(union).toMatch(/allowed: data === true/);
    expect(union).toMatch(/if \(!cancelled\) setVerdict\(\{ unionId, allowed: false \}\)/);
  });
});
