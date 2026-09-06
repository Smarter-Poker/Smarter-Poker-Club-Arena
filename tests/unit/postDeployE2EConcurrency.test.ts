import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);
const realtimeCertification = readFileSync(
  resolve(__dirname, '../e2e/production-customization-realtime.spec.ts'),
  'utf8'
);

describe('post-deploy E2E concurrency', () => {
  it('does not let a skipped workflow_run cancel a real production check', () => {
    const concurrency = workflow.match(/concurrency:\n([\s\S]*?)\n\njobs:/)?.[1] ?? '';

    expect(concurrency).toContain("github.event.workflow_run.conclusion != 'success'");
    expect(concurrency).toContain("format('noop-{0}', github.run_id)");
    expect(concurrency).toContain("'production'");
  });

  it('still serializes genuine production checks so authenticated writes cannot overlap', () => {
    const concurrency = workflow.match(/concurrency:\n([\s\S]*?)\n\njobs:/)?.[1] ?? '';

    expect(concurrency).toContain('cancel-in-progress: false');
    expect(concurrency).not.toContain('manual-');
  });

  it('runs stateful production contracts alone and never hides a first-attempt failure', () => {
    expect(workflow).not.toContain('--retries=1');
    expect(workflow.match(/--retries=0/g)?.length).toBeGreaterThanOrEqual(5);

    for (const spec of [
      'club-lobby.spec.ts',
      'production-customization-realtime.spec.ts',
      'production-customization-commerce.spec.ts',
      'production-daily-missions.spec.ts',
    ]) {
      expect(workflow).toMatch(
        new RegExp(`${spec.replaceAll('.', '\\.')}[\\s\\S]{0,120}--workers=1 --retries=0`)
      );
    }
    expect(workflow).toContain('--reporter=line,json --workers=2 --retries=0');
  });

  it('hard-deletes disposable realtime fixtures without restoring cosmetics first', () => {
    expect(realtimeCertification).not.toContain('restoreState(');
    expect(realtimeCertification).toContain(
      'cleanupTemporaryCustomizationAccount(environment, primaryAccount)'
    );
    expect(realtimeCertification).toContain(
      'cleanupTemporaryCustomizationAccount(environment, otherAccount)'
    );
    expect(realtimeCertification).toContain(
      '[customization-realtime] second player remained isolated'
    );
  });

  it('rehydrates realtime settings with one bounded Studio navigation', () => {
    expect(realtimeCertification).not.toContain(
      "mobilePage.reload({ waitUntil: 'domcontentloaded' })"
    );
    expect(realtimeCertification).toContain('mobileStudio = await openStudio(mobilePage)');
    expect(realtimeCertification).toContain(
      "page.goto('./', { waitUntil: 'domcontentloaded', timeout: 60_000 })"
    );
    expect(realtimeCertification).toContain(
      '[customization-realtime] persisted appearance survived a device reload'
    );
    expect(realtimeCertification).toContain("pathname.endsWith('/rest/v1/user_theme_settings')");
    expect(realtimeCertification.indexOf('const hydrated = page.waitForResponse')).toBeLessThan(
      realtimeCertification.indexOf('await Promise.all([hydrated, open.click()])')
    );
    expect(realtimeCertification).toContain('await Promise.all([hydrated, open.click()])');
  });
});
