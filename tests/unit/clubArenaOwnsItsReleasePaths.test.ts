import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const retiredProvider = ['sen', 'try'].join('');

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

  it('executes production-credential workflows only through default-branch events', () => {
    expect(publisher).toContain('types: [publish-club-arena]');
    expect(engineDeploy).toContain('types: [deploy-club-arena-engine]');
    expect(monitoringDeploy).toContain('types: [deploy-club-arena-monitoring]');
    for (const workflow of [publisher, engineDeploy, monitoringDeploy]) {
      expect(workflow).not.toMatch(/^\s*workflow_dispatch:/m);
    }
  });

  it('retires the generic external error-watcher and automated repair path', () => {
    for (const path of [
      `.github/workflows/${retiredProvider}-autofix.yml`,
      `.github/workflows/deploy-${retiredProvider}-autofix.yml`,
      `scripts/${retiredProvider}-autofix/package.json`,
      `services/${retiredProvider}-autofix/package.json`,
      `docs/${retiredProvider}-autofix.md`,
      `docs/runbooks/09-${retiredProvider}-autofix.md`,
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
    expect(read('vercel.json')).not.toContain(`${retiredProvider}-autofix`);
  });

  it('keeps deploy credentials out of local env examples while naming their homes', () => {
    const env = read('.env.example');
    expect(env).toContain('CA_ORIGIN_SSH_KEY');
    expect(env).toContain('HETZNER_SSH_PRIVATE_KEY');
    expect(env).toContain('values into this file');
    expect(env).not.toMatch(
      /^\s*(?:CA_ORIGIN_(?:SSH_KEY|HOST|HOST_KEY)|HETZNER_(?:SSH_PRIVATE_KEY|HOST|HOST_KEY))\s*=/m
    );
    expect(env).not.toMatch(
      new RegExp(String.raw`^\s*${retiredProvider.toUpperCase()}_AUTH_TOKEN\s*=`, 'm')
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
    expect(names).not.toContain('HETZNER_SSH_KEY');
    expect(names).not.toContain('WORLD_HUB_SYNC_TOKEN');
    expect(names).not.toContain('VERCEL_TOKEN');
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
      '.agent/workflows/build-verify.md',
      '.agents/workflows/build-verify.md',
      '.agents/rules/00-automated-janitor.md',
      '.claude/commands/deploy.md',
      '.claude/skills/deploy-hetzner/SKILL.md',
      '_antigravity-prompts/deploy-hetzner-rounds-39-40.md',
      '.memory/SUMMARY.md',
      '.memory/context/001-architecture.md',
      '.memory/preferences/002-no-terminal-prompts-only-antigravity.md',
      '.memory/context/003-hetzner-vps.md',
      '.memory/context/004-vercel-deploy.md',
      'AGENTS-PUSH-GUIDE.md',
      'skills/mandatory-typecheck/SKILL.md',
      'skills/browser-recovery/SKILL.md',
      'server/src/scale/README.md',
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
    expect(activeDocs).not.toMatch(/^\s*ssh\b/m);
    expect(activeDocs).not.toMatch(
      /^\s*(?:docker\s+(?:restart|run)|vercel\s+(?:--prod|deploy))\b/m
    );
    expect(activeDocs).not.toMatch(/\bWORLD_HUB_SYNC_TOKEN\b/);
    expect(activeDocs).not.toMatch(/-f\s+force(?:=|\s)/);
    expect(activeDocs).not.toMatch(/publish it yourself/i);
    expect(activeDocs).not.toMatch(/estate-ci-ip/);
    expect(activeDocs).not.toMatch(/SELF-PUBLISH-PROTOCOL|CLAUDE_AGENT_RULES/);
    expect(activeDocs).toContain('ca-static.smarter.poker');
    expect(activeDocs).toContain('publish-club-arena.yml');
  });

  it('removes one-off direct-main delivery scripts', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/git-safe-push.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/ci/pr-push.mjs'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/step1-verify-commit.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/commit-step2.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'scripts/step3-verify-commit.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-TOURNEY-SWEEP4.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-TOURNEY-SWEEP5.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-TOURNEY-SWEEP6.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-TOURNEY-AUDIT.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-LOBBY-CARDS.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'DEPLOY-RAKE-AUDIT.sh'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'wait_for_deploy.sh'))).toBe(false);
    expect(
      existsSync(resolve(process.cwd(), `services/${retiredProvider}-autofix/deploy-engine01.sh`))
    ).toBe(false);
    for (const path of [
      '.agent/handoffs/apply-and-push-2026-08-20.sh',
      '.agent/handoffs/2026-08-20-bbj-popup-buyins-errors.md',
      '.agent/handoffs/2026-08-20-bbj-popup-buyins-errors.patch',
      '.deploy-retrigger',
      'fix_hub.cjs',
      'fix_hub2.cjs',
      'fix_hub3.cjs',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
  });

  it('leaves no runnable direct-main or World Hub publisher in operational handoffs', () => {
    const handoffDir = resolve(process.cwd(), '.agent/handoffs');
    const handoffs = readdirSync(handoffDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => read(`.agent/handoffs/${name}`))
      .join('\n');
    expect(handoffs).not.toMatch(/git push[^\n]*:main\b/);
    expect(handoffs).not.toContain('sync-club-arena.sh');
    expect(handoffs).not.toContain('CA_SRC_OVERRIDE=');
    expect(handoffs).not.toContain('WH_OVERRIDE=');
  });

  it('keeps the build provenance gate fail-closed', () => {
    const provenance = read('scripts/stamp-build-provenance.mjs');
    expect(provenance).toContain('process.exit(1)');
    expect(provenance).not.toContain('console.log("bypassed")');
    expect(provenance).not.toContain('World Hub gate');
  });
});
