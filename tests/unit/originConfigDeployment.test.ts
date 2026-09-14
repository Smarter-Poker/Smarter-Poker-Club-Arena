import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const caddy = read('infra/ca-origin/Caddyfile');
const readme = read('infra/ca-origin/README.md');
const contract = read('.github/scripts/origin-contract.sh');
const auditWorkflow = read('.github/workflows/production-integrity-audit.yml');

describe('the origin Caddyfile is a reviewed disaster-recovery declaration', () => {
  it('has no workstation deployment script', () => {
    expect(existsSync(resolve(root, 'infra/ca-origin/deploy-origin-config.sh'))).toBe(false);
    expect(readme).toContain('disaster-recovery declaration');
    expect(readme).toContain('not a workstation deployment mechanism');
    expect(readme).not.toContain('bash infra/ca-origin/deploy-origin-config.sh');
  });

  it('declares the Club Arena static origin and immutable release layout', () => {
    expect(caddy).toMatch(/^ca-static\.smarter\.poker \{$/m);
    expect(caddy).toContain('root * /srv/club-arena/current');
    expect(caddy).toContain('root * /srv/club-arena/pool');
    expect(uncommented(caddy)).not.toMatch(/reverse_proxy.*world|vercel/i);
  });

  it('preserves cache safety for the shell, immutable assets, proof, and misses', () => {
    expect(caddy).toContain(
      'header @shell Cache-Control "public, max-age=0, s-maxage=60, stale-while-revalidate=60, stale-if-error=86400"'
    );
    expect(caddy).toContain(
      'header @immutable Cache-Control "public, max-age=31536000, immutable"'
    );
    expect(caddy).toContain(
      'header /build-info.json Cache-Control "no-store, no-cache, must-revalidate"'
    );
    expect(caddy).toMatch(/handle_errors \{[\s\S]*header Cache-Control "no-store"/);
  });
});

describe('automation validates public behavior without changing Caddy', () => {
  it('runs the external origin contract and no config installer', () => {
    expect(auditWorkflow).toContain('bash .github/scripts/origin-contract.sh');
    expect(auditWorkflow).not.toContain('deploy-origin-config.sh');
  });

  it('the contract is HTTPS-only observation', () => {
    const code = uncommented(contract);
    expect(code).toContain('curl');
    expect(code).toContain('https://smarter.poker/hub/club-arena');
    expect(code).toContain('https://ca-static.smarter.poker');
    expect(code).not.toMatch(
      /\bssh\b|\bscp\b|\brsync\b|\bsystemctl\b|caddy\s+(?:reload|start|stop)/
    );
  });
});
