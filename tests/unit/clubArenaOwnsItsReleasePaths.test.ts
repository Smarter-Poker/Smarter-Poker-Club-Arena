import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const publisher = read('.github/workflows/publish-club-arena.yml');
const engineDeploy = read('.github/workflows/auto-deploy-hetzner.yml');
const monitoringDeploy = read('.github/workflows/deploy-monitoring.yml');

describe('Club Arena owns every Club Arena release path', () => {
  it('publishes the frontend directly to the Club Arena Hetzner origin', () => {
    expect(publisher).toContain('publish-to-origin:');
    expect(publisher).toContain('CA_ORIGIN_HOST');
    expect(publisher).toContain('CA_ORIGIN_SSH_KEY');
    expect(publisher).toContain('CA_ORIGIN_HOST_KEY');
    expect(publisher).toContain('ORIGIN_ROOT: /srv/club-arena');
    expect(publisher).toContain('ORIGIN_URL: https://ca-static.smarter.poker');

    const runnable = publisher
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(runnable).not.toMatch(/Smarter-Poker-World-Hub|WORLD_HUB_SYNC_TOKEN/);
    expect(runnable).not.toMatch(/vercel\s+(?:--prod|deploy)/i);
  });

  it('uses one Club Arena-owned engine credential name with no legacy fallback', () => {
    for (const workflow of [engineDeploy, monitoringDeploy]) {
      expect(workflow).toMatch(/secrets\.HETZNER_SSH_PRIVATE_KEY/);
      expect(workflow).toMatch(/secrets\.HETZNER_HOST/);
      expect(workflow).toMatch(/secrets\.HETZNER_HOST_KEY/);
      expect(workflow).not.toMatch(/\bHETZNER_SSH_KEY\b/);
      expect(workflow).not.toMatch(/SSH_KEY_LEGACY|World Hub repo/);
    }
  });

  it('keeps deploy credentials out of local env examples while naming their homes', () => {
    const env = read('.env.example');
    expect(env).toContain('CA_ORIGIN_SSH_KEY');
    expect(env).toContain('HETZNER_SSH_PRIVATE_KEY');
    expect(env).toContain('values into this file');
    expect(env).not.toMatch(
      /^\s*(?:CA_ORIGIN_(?:SSH_KEY|HOST|HOST_KEY)|HETZNER_(?:SSH_PRIVATE_KEY|HOST|HOST_KEY))\s*=/m
    );
  });

  it('keeps the credential inventory aligned with the two Hetzner authorities', () => {
    const inventory = JSON.parse(read('scripts/ci/secrets-inventory.json')) as {
      secrets: Array<{ name: string; where: string }>;
    };
    const names = inventory.secrets.map(({ name }) => name);
    expect(names).toContain('HETZNER_SSH_PRIVATE_KEY');
    expect(names).toContain('CA_ORIGIN_SSH_KEY / CA_ORIGIN_HOST / CA_ORIGIN_HOST_KEY');
    expect(names).not.toContain('HETZNER_SSH_PRIVATE_KEY / hetzner_engine_key');
  });

  it('the active quick-start documents cannot send a Club Arena release through World Hub', () => {
    const activeDocs = [
      'CLAUDE.md',
      'MIGRATION-LAW.md',
      'DEPLOYMENT_PLAN.md',
      '.agent/AGENT-OPERATIONS-GUIDE.md',
      '.agent/architecture/deploy-paths.md',
      '.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md',
      '.agent/workflows/deploy.md',
      '.agent/workflows/completion-protocol.md',
      '.agent/workflows/deploy-troubleshooting.md',
      '.agent/workflows/browser-testing.md',
      '.agent/workflows/agent-execution-modes.md',
      '.agents/workflows/build-verify.md',
      '.agents/rules/00-automated-janitor.md',
      'scripts/build-and-verify.sh',
    ]
      .map(read)
      .join('\n');

    expect(activeDocs).not.toMatch(/rsync dist to World Hub/i);
    expect(activeDocs).not.toMatch(/Git commit \+ push World Hub/i);
    expect(activeDocs).not.toMatch(/Wait for Vercel Deploy/i);
    expect(activeDocs).not.toMatch(/\bHETZNER_SSH_KEY\b/);
    expect(activeDocs).not.toMatch(/^\s*git push origin main\s*$/m);
    expect(activeDocs).not.toMatch(/^\s*(?:ssh|rsync)\b.*\/srv\/club-arena/m);
    expect(activeDocs).not.toMatch(/publish it yourself/i);
    expect(activeDocs).not.toMatch(/estate-ci-ip/);
    expect(activeDocs).toContain('ca-static.smarter.poker');
    expect(activeDocs).toContain('publish-club-arena.yml');
  });

  it('removes one-off direct-main delivery scripts', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/git-safe-push.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/ci/pr-push.mjs'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/step1-verify-commit.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/commit-step2.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/step3-verify-commit.sh'))).toBe(false);
  });
});
