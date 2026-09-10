/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MONITORING DEPLOY DEPLOYS (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `.github/workflows/deploy-monitoring.yml` ran for the first time at 12:23
 * UTC on 2026-09-06, the morning the cluster controller was down for 65
 * minutes with `ClusterPassErrors` declared in this repo and not loaded on
 * the box. Its Deploy step did
 *
 *     ssh box "curl -fsSL https://raw.githubusercontent.com/<repo>/main/infra/monitoring/deploy.sh | bash"
 *
 * This repository is private. raw answered 404, `bash` read an empty stdin
 * and exited 0, `| tail -60` reported tail's exit, and the step was GREEN.
 * The verify step after it then ran plain `ssh root@host` with no key and
 * went red for "Permission denied" - the right colour, the wrong reason, and
 * a reason that hid the one above it. Meanwhile the repo's docker-compose.yml
 * lacked the `cron_secret` mount the box had carried by hand since 09-04, so
 * a deploy that HAD worked would have unmounted the pager's token, and
 * deploy.sh would have copied a placeholder Caddyfile over the live one.
 *
 * Four pins, each a thing that was true that morning and must not be again.
 * The rules-agree half of this is `what-a-monitor-reads-is-what-the-repo-says`;
 * this is the half about the deploy that carries them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WF = readFileSync(join(ROOT, '.github/workflows/deploy-monitoring.yml'), 'utf8');
const DEPLOY = readFileSync(join(ROOT, 'infra/monitoring/deploy.sh'), 'utf8');
const COMPOSE = readFileSync(join(ROOT, 'infra/monitoring/docker-compose.yml'), 'utf8');
const AM = readFileSync(join(ROOT, 'infra/monitoring/alertmanager.yml'), 'utf8');

const stripComments = (s: string) => s.replace(/^\s*#[^\n]*$/gm, '');

describe('the deploy step ships the checkout it has, never a URL it cannot read', () => {
  it('never curls raw.githubusercontent.com for a private repo', () => {
    expect(stripComments(WF)).not.toMatch(/raw\.githubusercontent\.com/);
    expect(stripComments(DEPLOY)).not.toMatch(/raw\.githubusercontent\.com/);
  });

  it('sends infra/monitoring over the deploy key and runs deploy.sh from that copy', () => {
    expect(WF).toContain('tar -C . -cf - infra/monitoring');
    expect(WF).toMatch(
      /MONITORING_SRC_FROM_CHECKOUT=1 DEPLOY_CONTROL_SHA='\$DEPLOY_CONTROL_SHA' bash \/opt\/smarter-poker-monitoring-src\/infra\/monitoring\/deploy\.sh/
    );
  });

  it('converges on current main and strands no payload behind an unrelated push', () => {
    expect(WF).toContain(
      "TIP=\"$(timeout 30s gh api 'repos/${{ github.repository }}/commits/main'"
    );
    expect(WF).toContain('echo "DEPLOY_CONTROL_SHA=$TIP" >> "$GITHUB_ENV"');
    expect(WF).toContain('ref: ${{ steps.target.outputs.sha }}');
    expect(WF).toContain('MAIN_SHA="$(git rev-parse --verify \'origin/main^{commit}\')"');
    expect(WF).toContain('git merge-base --is-ancestor "$DEPLOY_CONTROL_SHA" "$MAIN_SHA"');
    expect(WF).toContain('git diff --quiet "$DEPLOY_CONTROL_SHA" "$MAIN_SHA" --');
    expect(WF).toContain(
      'infra/monitoring server/scripts/install-caddy-websocket-log-redaction.sh'
    );
    expect(WF).not.toContain('Stale monitoring request');
  });

  it('compare-and-swaps a fsynced host receipt and verifies every shipped payload byte', () => {
    expect(WF).toContain('.club-arena-monitoring-release');
    expect(WF).toContain('.club-arena-monitoring-payload.sha256');
    expect(WF).toContain('git merge-base --is-ancestor "$LIVE_SHA" "$DEPLOY_CONTROL_SHA"');
    expect(DEPLOY).toContain('Monitoring release compare-and-swap failed');
    expect(DEPLOY).toContain('sha256sum --strict --check "$PAYLOAD_MANIFEST"');
    expect(DEPLOY).toContain('os.fsync(descriptor)');
    expect(DEPLOY.indexOf('if [[ $FAIL -gt 0 ]]')).toBeLessThan(
      DEPLOY.indexOf('mv -T "$RECEIPT_TMP" "$RELEASE_RECEIPT"')
    );
  });

  it('copies in place, because a bind-mounted file follows its inode', () => {
    expect(WF).toContain('cp -R /opt/smarter-poker-monitoring-src.incoming/infra/monitoring/.');
  });

  it('does not hide the deploy exit code behind a pipe', () => {
    const deployStep = WF.slice(
      WF.indexOf('- name: Deploy\n'),
      WF.indexOf('- name: The box is running')
    );
    expect(stripComments(deployStep)).not.toMatch(/\|\s*tail/);
  });

  it('deploy.sh refuses a checkout mode with nothing shipped, and asks both services to reload', () => {
    expect(DEPLOY).toContain('MONITORING_SRC_FROM_CHECKOUT');
    expect(DEPLOY).toContain('prometheus.yml is missing - refusing.');
    expect(DEPLOY).toContain('http://127.0.0.1:9090/-/reload');
    expect(DEPLOY).toContain('http://127.0.0.1:9093/-/reload');
  });
});

describe('the verify step can reach the box', () => {
  it('writes an ssh Host entry so a bare `ssh root@host` uses the deploy key', () => {
    expect(WF).toContain('echo "Host $HETZNER_HOST"');
    expect(WF).toContain('echo "  IdentityFile ~/.ssh/id_deploy"');
    expect(WF).toContain('node scripts/ci/check-alert-rules-match.mjs');
    expect(DEPLOY).toContain('docker compose up -d');
    expect(DEPLOY).toContain('Reloading Prometheus and Alertmanager');
    expect(WF).not.toContain('docker compose up -d --force-recreate prometheus');
  });
});

describe('a working deploy cannot unmount the pager', () => {
  it('every file alertmanager.yml reads from /etc/alertmanager is mounted by docker-compose.yml', () => {
    const wanted = new Set(
      [...stripComments(AM).matchAll(/\/etc\/alertmanager\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1])
    );
    expect(wanted.has('cron_secret')).toBe(true);
    for (const f of wanted) {
      expect(stripComments(COMPOSE), `${f} is read by alertmanager.yml and not mounted`).toContain(
        `./${f}:/etc/alertmanager/${f}:ro`
      );
    }
  });
});

describe('a deploy never puts a placeholder over a live password', () => {
  it('deploy.sh leaves a Caddyfile that carries a real hash alone', () => {
    expect(DEPLOY).toContain(
      'live credential-bearing Caddy configuration is present and unchanged'
    );
    const guard = DEPLOY.indexOf(
      'grep -q \'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT\' "$CADDY_DST"'
    );
    expect(guard).toBeGreaterThan(0);
    expect(DEPLOY).not.toContain('cp "$CADDY_SRC" "$CADDY_DST"');
  });
});
