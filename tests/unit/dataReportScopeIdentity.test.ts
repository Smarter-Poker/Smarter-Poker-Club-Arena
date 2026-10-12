import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

const financials = read('src/pages/ClubFinancialsPage.tsx');
const disputes = read('src/pages/DisputeManagementPage.tsx');
const insurance = read('src/pages/club/ClubInsuranceReportPage.tsx');
const bombPots = read('src/pages/club/ClubBombPotReportPage.tsx');

const ownedPages = [financials, disputes, insurance, bombPots];
const reportPages = [financials, insurance, bombPots];

function consoleOpenings(source: string): string[] {
  return source.match(/<SpadeConsole\b[\s\S]*?>/g) ?? [];
}

describe('connected data reports keep asynchronous results inside their request scope', () => {
  it('binds every report snapshot to the active account, club, and period', () => {
    for (const source of reportPages) {
      expect(source).toContain('scopeKey');
      expect(source).toContain('snapshot?.scope === scopeKey');
      expect(source).toContain('requestVersionRef');
      expect(source).toContain('activeScopeRef.current === requestScope');
      expect(source).toContain('inFlightRef.current?.scope === requestScope');
      expect(source).toContain("user?.id ?? 'signed-out'");
    }
  });

  it('makes stale permission and missing-club verdicts request-scoped and resettable', () => {
    for (const source of [financials, insurance, bombPots]) {
      expect(source).toMatch(/setRequestState\(\{[\s\S]*?denied: false,[\s\S]*?notFound: false/);
      expect(source).toContain('current.scope === requestScope');
    }
  });

  it('guards late completions after unmount or scope replacement', () => {
    for (const source of ownedPages) {
      expect(source).toContain('useIsMounted');
      expect(source).toContain('activeScopeRef.current');
    }
    expect(disputes).toContain('requestVersionRef.current === requestId');
    expect(disputes).toContain('const actionScope = scopeKey');
    expect(financials).toContain('activeRoleScopeRef.current === requestRoleScope');
  });

  it('does not leave the bomb-pot refusal as a dead-end error state', () => {
    expect(bombPots).toContain('className={styles.errorState}');
    expect(bombPots).toContain('onClick={() => void load()}');
    expect(bombPots).toMatch(/>\s*Retry\s*<\/button>/);
  });

  it('closes club-scoped financial drawers before a new club can use them', () => {
    expect(financials).toContain('setActiveCashier(null)');
    expect(financials).toContain('setShowPlayerWallet(false)');
  });
});

describe('connected data reports render only approved, intentional console families', () => {
  it('declares an approved family on every painted console', () => {
    for (const source of ownedPages) {
      const openings = consoleOpenings(source);
      expect(openings.length).toBeGreaterThan(0);
      for (const opening of openings) {
        expect(opening).toMatch(/family="(?:spade|shark|riveted)"/);
        expect(opening).not.toMatch(/crest="(?:club|diamond)"/);
      }
    }
  });

  it('keeps financial loading, refusal, missing, and failure states on painted masters', () => {
    expect(financials).not.toMatch(/<(?:ErrorState|PermissionState)\b/);
    expect(consoleOpenings(financials)).toHaveLength(10);
  });
});
