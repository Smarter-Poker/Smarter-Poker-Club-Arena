import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('financial admin subpages keep the Club Arena console contract', () => {
  it('keeps the Financial Admin union surface off the shark family empty plate', () => {
    const page = read('src/pages/FinancialAdminHub.tsx');

    expect(page).not.toContain('family="shark"');
    expect(page).toContain("clubPath: 'financials'");
    expect(page).not.toContain("label: 'Settlements'");
  });

  it('renders Credit Admin on the approved money console without generic card chrome', () => {
    const page = read('src/pages/CreditAdminPanel.tsx');
    const pageCss = read('src/pages/CreditAdminPanel.module.css');
    const requestCss = read('src/components/agent/CreditRequestWidget.css');

    expect(page).toContain('family="spade"');
    expect(page).not.toContain('family="riveted"');
    expect(page).toContain('crest="spade"');
    expect(page).toContain('const hasExport = dataReady && agents.length > 0');
    expect(page).toContain("foot={hasExport ? 'plates' : 'foot'}");
    expect(page).toContain('className={styles.backWord}');
    expect(page).toContain('{titleCase(agent.clubName)}');
    expect(page).toContain('{titleCase(log.clubName)}');
    expect(page).not.toContain('PageSkeleton');
    expect(page).not.toMatch(/plates=\{\{\s*secondary:[^}]+\}\}/);
    expect(page).not.toMatch(/style=\{\{/);
    expect(page).not.toMatch(/[✓✕←→]/);
    for (const css of [pageCss, requestCss]) {
      expect(css).not.toMatch(/border-radius\s*:/);
      expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/);
      expect(css).not.toMatch(/backdrop-filter\s*:/);
    }
    expect(pageCss).toContain('@media (max-width: 480px)');
    expect(requestCss).toContain('@media (max-width: 480px)');
  });

  it('uses one scope console instead of nesting painted frames and keeps loading plate-free', () => {
    const scopeState = read('src/components/common/FinancialAdminScopeState.tsx');
    const credit = read('src/pages/CreditAdminPanel.tsx');
    const settlement = read('src/pages/SettlementDashboardPage.tsx');

    expect(scopeState).toContain("family={failed ? 'riveted' : denied ? 'shark' : 'spade'}");
    expect(scopeState).toContain("foot={failed || denied ? 'plates' : 'foot'}");
    expect(credit).toContain("if (scope.status !== 'ready') {");
    expect(credit).toContain('return <FinancialAdminScopeState scope={scope} />;');
    expect(credit).not.toMatch(/<SpadeConsole[\s\S]{0,900}<FinancialAdminScopeState/);
    expect(settlement).toContain(
      "if (scope.status !== 'ready') return <FinancialAdminScopeState scope={scope} />;"
    );
    expect(settlement).not.toMatch(/<SpadeConsole[\s\S]{0,500}<FinancialAdminScopeState/);
  });

  it('renders weekly accounting and its retained ledger in approved painted consoles', () => {
    const page = read('src/pages/SettlementDashboardPage.tsx');

    expect(page).toContain('family="spade"');
    expect(page).not.toContain('family="riveted"');
    expect(page).toContain('crest="flat"');
    expect(page).toContain(
      "const ledgerTitle = scopeClubId ? 'Club Transaction Records' : 'Your Account Transactions';"
    );
    expect(page).toContain('title={ledgerTitle}');
    expect(page).toContain('aria-label={ledgerTitle}');
    expect(page).toContain('className={styles.backButton}');
    expect(page).not.toContain('plates={{ secondary');
    expect(page).not.toMatch(/style=\{\{/);
  });

  it('wraps ledger copy on phones and never restores the clipped one-line layout', () => {
    const css = read('src/components/common/TransactionLedgerView.css');

    expect(css).toContain('@media (max-width: 480px)');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).not.toMatch(/\.tlv-path,[\s\S]{0,180}?overflow:\s*hidden/);
    expect(css).not.toMatch(/\.tlv-description[\s\S]{0,180}?white-space:\s*nowrap/);
  });
});
