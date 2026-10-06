/**
 * Legacy Financial Alerts retirement and live incident-console authority.
 *
 * The old alerts export was bound to a page that no route rendered. The
 * financial admin surface now owns one reachable incident queue with scoped
 * reads and server-authorized actions; this ratchet prevents the duplicate
 * alert page from returning merely to preserve a stale test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('retired Financial Alerts surface', () => {
  it('keeps the unreachable duplicate page deleted', () => {
    expect(() => read('src/pages/FinancialAlertsPage.tsx')).toThrow();
    expect(() => read('src/pages/FinancialAlertsPage.css')).toThrow();
  });

  it('preserves the guarded legacy bookmark as a redirect to the live queue', () => {
    const app = read('src/App.tsx');
    expect(app).not.toContain("import('./pages/FinancialAlertsPage')");
    expect(app).toMatch(
      /path="financial-alerts"[\s\S]*?<PlatformStaffGuard>[\s\S]*?<Navigate replace to="\/financial-incidents" \/>[\s\S]*?<\/PlatformStaffGuard>/
    );
    expect(app).toMatch(
      /path="financial-incidents"[\s\S]*?<FinancialAdminGate>[\s\S]*?<DriftIncidentsPage \/>/
    );
  });

  it('links Financial Admin to the live incident queue, not the retired page', () => {
    const hub = read('src/pages/FinancialAdminHub.tsx');
    expect(hub).toContain("path: '/financial-incidents'");
    expect(hub).not.toContain("path: '/financial-alerts'");
  });

  it('keeps incident reads and actions fenced to the current authenticated scope', () => {
    const incidents = read('src/pages/DriftIncidentsPage.tsx');
    expect(incidents).toContain("useCashoutScopeKey(user?.id, 'drift-incidents')");
    expect(incidents).toContain("useCashoutScope(actorId, 'drift-incidents')");
    expect(incidents).toContain('DriftIncidentService.getDashboard');
    expect(incidents).toContain('DriftIncidentService.getMetrics');
    expect(incidents).toContain('DriftIncidentService.act');
    expect(incidents).toMatch(/if \(!isCurrent\(\)\)/);
    expect(incidents).toMatch(/disabled=\{acting !== null\}/);
  });

  it('keeps the bounded financial exporter wired to the live weekly-accounting surface', () => {
    const weekly = read('src/components/accounting/ClubWeeklyAccountingSummary.tsx');
    expect(weekly).toContain("from '../../services/FinancialExportService'");
    expect(weekly).toContain('FinancialExportService.exportCSV');
    expect(weekly).toContain("type: 'settlement_club'");
    expect(weekly).toContain('expectedActorId: user.id');
    expect(weekly).toContain('isCurrent: current');
    expect(weekly).toContain('Export Weekly Summaries');
  });
});
