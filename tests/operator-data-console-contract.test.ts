import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const pages = [
  'src/pages/FinancialAdminHub.tsx',
  'src/pages/RateAuditPage.tsx',
  'src/pages/AgentPortalPage.tsx',
];

const styles = [
  'src/pages/FinancialAdminHub.module.css',
  'src/pages/RateAuditPage.module.css',
  'src/pages/AgentPortalPage.module.css',
];

describe('operator Data surfaces use intentional Club Arena console families', () => {
  it('maps each route to an approved painted family without rejected crests', () => {
    const hub = read(pages[0]);
    const rates = read(pages[1]);
    const agent = read(pages[2]);

    expect(hub).toMatch(/family="spade"[\s\S]*?crest="flat"/);
    expect(hub).toMatch(/family="spade"[\s\S]*?crest="spade"/);
    expect(hub).not.toContain('family="shark"');
    expect(rates).toMatch(/family="shark"[\s\S]*?crest="flat"/);
    expect(agent).toMatch(/family="riveted"[\s\S]*?crest="spade"/);
    expect(agent).toMatch(/family="spade"[\s\S]*?crest="flat"/);
    expect(agent).not.toContain('family="shark"');

    for (const path of pages) {
      const source = read(path);
      expect(source).not.toMatch(/crest="(?:club|diamond)"/);
      expect(source).not.toContain('PageSkeleton');
      expect(source).not.toContain('FinancialAdminScopeState');
      expect(source).not.toMatch(/style=\{\{/);
      expect(source).not.toContain('All Services Operational');
    }
  });

  it('uses engraved glass rows and painted plates instead of CSS card chrome', () => {
    for (const path of styles) {
      const css = read(path);
      expect(css).not.toMatch(/:hover\b/);
      expect(css).not.toMatch(/border-radius\s*:/);
      expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/);
    }
    for (const path of pages) {
      const source = read(path);
      expect(source).not.toMatch(/[◈◆◇⚠▦▣▤⚖↓→←]/);
    }
  });

  it('keeps every rate audit filter word on the 44px touch floor', () => {
    const rates = read('src/pages/RateAuditPage.module.css');
    const controls = rates.match(/\.filterWord,\s*\.litAction\s*\{[^}]*\}/s)?.[0] ?? '';

    expect(controls).toContain('min-width: 44px');
    expect(controls).toContain('min-height: 44px');
  });

  it('keeps the Financial Admin union selector above the iOS zoom floor', () => {
    const hub = read('src/pages/FinancialAdminHub.module.css');
    const select = hub.match(/\.select\s*\{[^}]*\}/s)?.[0] ?? '';

    expect(select).toContain('min-height: 44px');
    expect(select).toContain('font-size: max(16px, 3.4cqw)');
  });

  it('keeps every Data route in the retained phone-fit and thumb sweeps', () => {
    const phoneFit = read('tests/e2e/mobile-fit-audit.spec.ts');
    const thumbSweep = read('tests/e2e/mobile-tap-targets.spec.ts');

    expect(phoneFit).toContain("'financial-admin'");
    expect(phoneFit).toContain('`rate-audit?club=${');
    expect(phoneFit).toContain("'settlement-history'");
    for (const route of [
      '`clubs/${CLUB}/data`',
      "'stats'",
      '`rate-audit?club=${CLUB}`',
      "'settlement-history'",
    ]) {
      expect(thumbSweep).toContain(route);
    }
  });

  it('keeps database identifiers internal when a display name is unavailable', () => {
    const rates = read('src/pages/RateAuditPage.tsx');
    const clubData = read('src/pages/club/ClubDataPage.tsx');
    const bombPots = read('src/pages/club/ClubBombPotReportPage.tsx');

    expect(rates).toContain("'Agent Name Unavailable'");
    expect(rates).toContain("'Club Name Unavailable'");
    expect(rates).toContain("changedBy: 'Operator Name Unavailable'");
    expect(rates).not.toMatch(/entityId\.slice\s*\(/);
    expect(rates).not.toMatch(/changed_by\.slice\s*\(/);

    expect(clubData).toContain("'Creator Name Unavailable'");
    expect(clubData).not.toMatch(/creator_id\.slice\s*\(/);
    expect(bombPots).toContain("d.table_name ?? 'Table Name Unavailable'");
    expect(bombPots).not.toMatch(/table_id\.slice\s*\(/);
  });

  it('keeps scope generations and failed reads explicit rather than false zeroes', () => {
    const hub = read(pages[0]);
    const rates = read(pages[1]);
    const agent = read(pages[2]);

    expect(hub).toContain('const statsRequest = useRef(0)');
    expect(hub).toContain('request === statsRequest.current');
    expect(hub).toContain('Financial Status Could Not Be Verified');
    expect(hub).not.toMatch(/catch \([^)]*\) \{[\s\S]{0,180}?return 0;/);

    expect(rates).toContain('useVisibleRead({');
    expect(rates).toContain('dateRange}`');
    expect(rates).toContain(".gte('created_at', cutoff)");
    expect(rates).toContain(".lte('created_at', windowEnd.toISOString())");
    expect(rates).toContain('.abortSignal(signal)');
    expect(rates).toContain('parseRateAuditRows(commResult.data');
    expect(rates).toContain('parseRateAuditRows(rakeResult.data');

    expect(agent).toContain('scope === walletScope.current');
    expect(agent).toContain('request === walletRequest.current');
    expect(agent).toContain('Commission History Could Not Be Read');
    expect(agent).not.toContain('Debt calculation skipped');
  });
});
