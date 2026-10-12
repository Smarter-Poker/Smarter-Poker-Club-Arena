import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Financial Admin production certificate rejects snake_case words as raw
 * backend copy, and sets aside only text a page marks data-player-name. A
 * player's alias ("the_kicker") is the player's own words and prints exactly
 * as chosen, so every console that prints one must mark it, or the certificate
 * fails on a real handle (Post-Deploy E2E run 37562538452, Credit Admin).
 */
const source = (path: string) => readFileSync(path, 'utf8');

describe('financial consoles mark the player aliases they print', () => {
  it('Credit Admin marks agent and audit names', () => {
    const page = source('src/pages/CreditAdminPanel.tsx');
    expect(page).toContain('<strong data-player-name>{titleCase(agent.displayName)}</strong>');
    expect(page).toContain('<strong data-player-name>{titleCase(log.agentName)}</strong>');
  });

  it('the credit request inbox marks the requester', () => {
    expect(source('src/components/agent/CreditRequestWidget.tsx')).toMatch(
      /className="requester" data-player-name>\s*\{titleCase\(req\.requesterName\)\}/
    );
  });

  it('Club Disputes marks the submitter', () => {
    expect(source('src/pages/DisputeManagementPage.tsx')).toMatch(
      /className="dmp__submitter sc-ink--muted" data-player-name>\s*By \{titleCase\(dispute\.submitterName\)\}/
    );
  });

  it('the certificate sets marked aliases aside only from the raw-enum scan', () => {
    expect(source('tests/e2e/helpers/financial-console-copy.ts')).toContain(
      "copy.querySelectorAll('[data-player-name]').forEach((name) => name.remove());"
    );
    const spec = source('tests/e2e/financial-admin-deep.spec.ts');
    expect(spec).toContain('expect(copy).not.toMatch(UUID_IN_COPY);');
    expect(spec).toContain(
      'expect(await root.evaluate(financialConsoleEnumCopy)).not.toMatch(RAW_ENUM_IN_COPY);'
    );
  });
});
