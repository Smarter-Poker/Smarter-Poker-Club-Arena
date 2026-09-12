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
  it('runs only after exact publish proof or a successful safe stand-down', () => {
    expect(workflow).toContain('publication-gate:');
    expect(workflow).toContain('/actions/runs/$SOURCE_RUN_ID/jobs?filter=latest&per_page=100');
    expect(workflow).toContain("entry?.name === 'publish-to-origin'");
    expect(workflow).toContain(
      "entry?.name === 'Stand down if the origin already serves a newer bundle'"
    );
    expect(workflow).toContain(
      "entry?.name === 'Publish through the host-owned immutable transaction'"
    );
    expect(workflow).toContain("entry?.name === 'Verify the origin serves this bundle'");
    expect(workflow).toContain("origin.conclusion === 'success'");
    expect(workflow).toContain("proofs[0].conclusion === 'success'");
    expect(workflow).toContain("publishes[0].conclusion === 'skipped'");
    expect(workflow).toContain("proofs[0].conclusion === 'skipped'");
    expect(workflow).not.toContain('SOURCE_CONCLUSION:');
    expect(workflow).not.toContain('should_run=false');
    expect(workflow).toContain(
      'The source run neither proved a Hetzner web publish nor completed a safe forward stand-down.'
    );
    expect(workflow).toContain("fs.appendFileSync(output, 'should_run=true\\n')");
    expect(workflow).toContain('needs: publication-gate');
    expect(workflow).toContain("needs.publication-gate.outputs.should_run == 'true'");
  });

  it('still serializes genuine production checks so authenticated writes cannot overlap', () => {
    const productionJob = workflow.slice(workflow.indexOf('  production-e2e:'));
    const concurrency = productionJob.match(/concurrency:\n([\s\S]*?)\n\s+steps:/)?.[1] ?? '';

    expect(concurrency).toContain('cancel-in-progress: false');
    expect(concurrency).toContain('group: post-deploy-e2e-production');
    expect(concurrency).toContain('queue: max');
    expect(concurrency).not.toContain('manual-');
  });

  it('fails closed on malformed, unknown, or divergent live provenance', () => {
    expect(workflow).toContain('production-e2e-provenance.mjs build-info');
    expect(workflow).toContain('[[ "$LIVE" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('git fetch --no-tags origin "$LIVE" --depth=1');
    expect(workflow).toContain('production-e2e-provenance.mjs lineage "$LIVE" "$HERE"');
    expect(workflow).not.toContain(
      'git fetch --no-tags origin "$LIVE" --depth=1 2>/dev/null || true'
    );
    expect(workflow).not.toContain('::warning::deployed sha');
    expect(workflow).not.toContain('specs left at $HERE');
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
