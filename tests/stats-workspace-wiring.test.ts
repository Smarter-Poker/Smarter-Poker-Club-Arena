import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Stats workspace wiring', () => {
  it('keeps the workspace owner-only, lazy and outside printed dossiers', () => {
    const page = read('src/pages/PlayerStatsPage.tsx');
    expect(page).toContain("const WorkspaceTab = lazy(() => import('./stats/WorkspaceTab'))");
    expect(page).toContain("if (isOwnProfile && t === 'analysis') out.push('workspace')");
    expect(page).toContain("{category === 'workspace' && isOwnProfile && (");
    expect(page).not.toContain("showTab('workspace')");
  });

  it('loads the persisted privacy preference before the workspace tab is opened', () => {
    const page = read('src/pages/PlayerStatsPage.tsx');
    expect(page).toContain("import('../services/StatsWorkspaceService')");
    expect(page).toContain('setPrivacyPresentationMode(result.data.privacyPresentationMode)');
    expect(page).toContain('statsWorkspaceService.loadPreferences()');
    expect(page).toContain("privacyPresentationMode && category !== 'workspace'");
    expect(page).toContain('statsWorkspaceService.evaluateAlerts');
    expect(page).toContain('setDashboardLayout');
    expect(read('src/pages/PlayerStatsPage.css')).toContain(
      '.stats-page--presentation .stats-hero'
    );
  });

  it('masks share cards and CSV exports rather than changing only a label', () => {
    const share = read('src/components/stats/StatsShareCard.tsx');
    const csv = read('src/pages/stats/statsCsvExport.ts');
    expect(share).toContain("privacyPresentationMode ? 'Private Player' : displayName");
    expect(share).toContain("privacyPresentationMode ? 'PRIVATE'");
    expect(csv).toContain("value: 'Hidden'");
    expect(csv).toContain("presentation_mode: metadata.privacyPresentationMode ? 'on' : 'off'");
  });
});
