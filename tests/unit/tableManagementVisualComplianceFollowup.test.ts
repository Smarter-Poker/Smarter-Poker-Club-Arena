import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const help = read('src/components/common/HelpPopover.tsx');
const controls = read('src/components/table-config/controls.tsx');
const configCss = read('src/pages/TableConfigPage.css');
const management = read('src/pages/GameManagementPage.tsx');
const ticker = read('src/components/club/TickerManagementPanel.tsx');
const production = read('tests/e2e/production-table-management.spec.ts');

describe('Table Management visual compliance follow-up', () => {
  it('uses an organic Help label with a keyboard-sized transparent control', () => {
    expect(help).toMatch(/>\s*Help\s*<\/button>/);
    expect(help).not.toMatch(/>\s*\?\s*<\/button>/);

    const rule = configCss.match(/\.config-help__button\s*\{([\s\S]*?)\}/)?.[1] || '';
    expect(rule).toContain('min-width: 44px');
    expect(rule).toContain('min-height: 44px');
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border-bottom: 1px solid currentColor');
  });

  it('reuses the approved engraved tick well instead of a CSS-built switch', () => {
    expect(controls).toContain('table-config-switch sc-check');
    expect(controls).toContain("value ? ' sc-check--on' : ''");
    expect(controls).toContain('table-config-switch__input sc-check__box');
    expect(controls).not.toContain('table-config-switch__track');
    expect(controls).not.toContain('table-config-switch__thumb');
    expect(configCss).not.toContain('.table-config-switch__track');
    expect(configCss).not.toContain('.table-config-switch__thumb');
  });

  it('title-cases operator-facing database and configuration names at print sites', () => {
    expect(management).toContain('title: titleCase(game.name)');
    expect(management).toContain('subtitle: titleCase(game.hostName)');
    expect(management).toContain('subtitle={titleCase(scopeName)}');
    expect(ticker).toContain("subtitle={titleCase(scopeName || 'Live Message Rail')}");
  });

  it('keeps production creator proof read-only and covers every purpose-built frame', () => {
    for (const path of ['?create=table&game=nlh', '?create=event', '?create=spin', '?create=sng']) {
      expect(production).toContain(path);
    }
    expect(production).toContain("page.getByRole('dialog', { name: 'Create Game' })");
    expect(production).toContain('toHaveClass(/sc--family-riveted/)');
    expect(production).toContain("getByRole('heading', { name: 'NLH Setup' })");
    expect(production).not.toMatch(/getByRole\('button', \{ name: 'Create Tournament' \}\)\.click/);
  });
});
