/**
 * LAW: no long-lived token fallback or mutating recovery watcher may reappear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WF = join(ROOT, '.github/workflows');
const workflows = () =>
  readdirSync(WF)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, body: readFileSync(join(WF, file), 'utf8') }));

describe('release and merge automation has no credential fallback watcher', () => {
  it('no workflow names the retired long-lived PATs', () => {
    const offenders = workflows()
      .filter(({ body }) => /secrets\.(GH_PAT|AUTOFIX_GITHUB_TOKEN)/.test(body))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the retired mutation watchers remain absent', () => {
    for (const path of [
      '.github/workflows/publish-watchdog.yml',
      '.github/scripts/publish-watchdog.sh',
      '.github/scripts/engine-watchdog.sh',
      '.github/scripts/orphan-work-watchdog.sh',
      '.github/scripts/report-stuck-prs.sh',
      '.github/scripts/schedule-liveness.mjs',
    ]) {
      expect(existsSync(join(ROOT, path)), `${path} was restored`).toBe(false);
    }
  });

  it('the surviving production provenance audits cannot dispatch or toggle workflows', () => {
    for (const path of [
      '.github/scripts/audit-publish-provenance.sh',
      '.github/scripts/audit-engine-provenance.sh',
    ]) {
      const body = readFileSync(join(ROOT, path), 'utf8');
      expect(body).not.toMatch(/repository\/dispatches|actions\/workflows\/[^"]+\/dispatches/);
      expect(body).not.toMatch(/workflow\s+(enable|disable)/);
    }
  });
});
