import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const job = (yaml: string, name: string) => {
  const start = yaml.search(new RegExp(`^ {2}${name}:$`, 'm'));
  expect(start, `missing job ${name}`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + `  ${name}:`.length);
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(rest);
  return yaml.slice(start, next ? start + `  ${name}:`.length + next.index : undefined);
};

const deploy = read('.github/workflows/auto-deploy-hetzner.yml');
const publish = read('.github/workflows/publish-club-arena.yml');
/**
 * The origin job's shell is the step text PLUS the activation transaction it
 * pipes to the host. That transaction was a heredoc inside the step until
 * 2026-09-22, when the step outgrew the size GitHub Actions accepts for one
 * `run` and the workflow stopped parsing. Reading both keeps every pin below
 * pointed at the same bytes, in the same order they execute.
 */
const originActivate = read('.github/scripts/publish-origin-activate.sh');
const ACTIVATION_PIPE = '< .github/scripts/publish-origin-activate.sh';
const originJob = () => {
  const text = job(publish, 'publish-to-origin');
  const pipe = text.indexOf(ACTIVATION_PIPE);
  expect(pipe, 'the origin job must pipe the activation transaction').toBeGreaterThan(-1);
  const after = pipe + ACTIVATION_PIPE.length;
  // Spliced where it runs, so every ordering pin below still reads the real
  // sequence: stage, transfer, activate, then the separate rollback step.
  return `${text.slice(0, after)}\n${originActivate}${text.slice(after)}`;
};
const publishCode = uncommented(publish);
const buildProvenance = read('scripts/stamp-build-provenance.mjs');
const ci = read('.github/workflows/ci.yml');

describe('the required server check joins independent accounting and engine work', () => {
  const shards = uncommented(job(ci, 'server_shards'));
  const aggregate = uncommented(job(ci, 'server'));
  it('starts independent jobs together and retains both complete prerequisites', () => {
    expect(aggregate).toMatch(/^ {4}name: Server Engine \(typecheck \+ tests\)$/m);
    expect(aggregate).toMatch(/^ {4}needs: \[changes, server_shards, accounting_postgres\]$/m);
    expect(aggregate).toMatch(/^ {4}if: always\(\)$/m);
    expect(shards).toMatch(/^ {4}needs: changes$/m);
    expect(shards).not.toContain('needs.accounting_postgres');
    expect(shards).toMatch(/^ {8}shard: \[1, 2, 3, 4\]$/m);
    expect(shards).not.toMatch(/^\s+(?:include|exclude|continue-on-error):/m);
    expect(shards).toMatch(/^\s+npm test -- --shard="\$SERVER_TEST_SHARD\/4"\s*$/m);
    expect(shards).toContain("needs.changes.result != 'success'");
    expect(aggregate).toContain('ACCOUNTING_RESULT: ${{ needs.accounting_postgres.result }}');
  });
  const script = aggregate
    .match(/^ {8}run: \|\n((?:^ {10}.+\n?)+)/m)?.[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  // Execute the actual required-check script. Every missing, skipped, failed or
  // cancelled dependency refuses even if its independent peer passed.
  for (const matrix of ['success', 'failure', 'cancelled', 'skipped', 'unknown', '']) {
    for (const accounting of ['success', 'failure', 'cancelled', 'skipped', 'unknown', '']) {
      it(`joins engine=${matrix || 'missing'} and accounting=${accounting || 'missing'}`, () => {
        const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script!], {
          encoding: 'utf8',
          timeout: 2000,
          env: {
            PATH: process.env.PATH,
            MATRIX_RESULT: matrix,
            ACCOUNTING_RESULT: accounting,
            CI_EVENT_NAME: 'pull_request',
            DIFF_RESULT: 'success',
            SERVER_CHANGED: 'true',
          },
        });
        expect(run.status, run.stderr).toBe(
          matrix === 'success' && accounting === 'success' ? 0 : 1
        );
      });
    }
  }
  for (const [event, diff, changed, expected] of [
    ['pull_request', 'success', 'false', 0],
    ['pull_request', 'success', 'true', 1],
    ['pull_request', 'failure', 'false', 1],
    ['pull_request', 'cancelled', 'false', 1],
    ['pull_request', 'success', '', 1],
    ['schedule', 'success', 'false', 1],
  ] as const) {
    it(`permits skipped work only for a verified unaffected diff: ${event}/${diff}/${changed}`, () => {
      const run = spawnSync('bash', ['-euo', 'pipefail', '-c', script!], {
        encoding: 'utf8',
        timeout: 2000,
        env: {
          PATH: process.env.PATH,
          MATRIX_RESULT: 'skipped',
          ACCOUNTING_RESULT: 'skipped',
          CI_EVENT_NAME: event,
          DIFF_RESULT: diff,
          SERVER_CHANGED: changed,
        },
      });
      expect(run.status, run.stderr).toBe(expected);
    });
  }
});

describe('engine deployment reports what actually happened', () => {
  it('calls a release shipped only after the durable transaction and independent proof agree', () => {
    expect(deploy).toContain('[ "$UNIT_RESULT" = success ] && [ "$RESULT_SHA" = "$SHA" ]');
    expect(deploy).toContain('case "$RESULT" in sealed|already-released)');
    expect(deploy).toMatch(
      /shipped: .*steps\.release\.outputs\.result == 'sealed'.*steps\.verify\.outputs\.verified == 'true'/
    );
    expect(deploy).toContain("steps.release.outputs.result || 'not completed'");
    expect(deploy).toContain("steps.verify.outputs.verified || 'false'");
    expect(deploy).toContain("STRICT_RECEIPT: '1'");
  });

  it('keeps npm verification on a separate runner from root SSH release authority', () => {
    const preflight = uncommented(job(deploy, 'preflight'));
    const doors = uncommented(job(deploy, 'engine-doors'));
    const release = uncommented(job(deploy, 'deploy'));
    const receipt = uncommented(job(deploy, 'record-receipt'));

    // A GitHub job is the runner isolation boundary: server dependency scripts
    // and tests finish in preflight before the root-authorized job can start.
    expect(preflight).toMatch(/^ {2}preflight:/);
    expect(preflight).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(preflight).toMatch(/^ {8}working-directory: server$/m);
    expect(preflight).toMatch(/^\s+npm ci --no-audit --no-fund\s*$/m);
    expect(preflight).toMatch(/^\s+npm run build\s*$/m);
    // All four partitions must finish before the matrix dependency releases
    // either privileged job. No conditional/excluded shard or ignored failure.
    expect(preflight).toMatch(
      /^ {4}strategy:\n {6}fail-fast: false\n {6}max-parallel: 4\n {6}matrix:\n {8}shard: \[1, 2, 3, 4\]$/m
    );
    expect(preflight).toMatch(/^ {10}RELEASE_TEST_SHARD: \$\{\{ matrix\.shard \}\}$/m);
    expect(preflight).toMatch(/^\s+npm test -- --shard="\$RELEASE_TEST_SHARD\/4"\s*$/m);
    expect(preflight).not.toMatch(/^\s+(?:if|exclude|include|continue-on-error):/m);
    expect(preflight).not.toMatch(/\$\{\{[^}\n]*\bsecrets\b[^}\n]*\}\}/);
    expect(preflight).not.toContain('SSH_USER: root');

    expect(doors).toMatch(/^ {2}engine-doors:/);
    expect(doors).toMatch(/^ {4}needs: preflight$/m);
    expect(doors).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(doors).toContain('node scripts/ci/check-engine-doors-exist.mjs');
    expect(doors).not.toMatch(/secrets\.HETZNER_|\bSSH_(?:USER|KEY|DIR)\b|\bHSSH\b/);

    expect(release).toMatch(/^ {2}deploy:/);
    expect(release).toMatch(/^ {4}needs: \[preflight, engine-doors\]$/m);
    expect(release).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(release).toMatch(/^ {6}SHA: \$\{\{ needs\.preflight\.outputs\.target_sha \}\}$/m);
    expect(release).toMatch(/^ {6}SSH_USER: root$/m);
    expect(release).toContain('SSH_KEY: ${{ secrets.HETZNER_SSH_PRIVATE_KEY }}');
    expect(release).toContain('HOST_KEY: ${{ secrets.HETZNER_HOST_KEY }}');
    expect(release).not.toMatch(/^\s*(?:npm|npx|pnpm|yarn)\b/m);
    expect(release).not.toContain('actions/setup-node@');

    expect(receipt).toMatch(/^ {2}record-receipt:/);
    expect(receipt).toMatch(/^ {4}needs: \[preflight, deploy\]$/m);
    expect(receipt).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(receipt).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(receipt).toContain('node scripts/ci/record-engine-deploy-attempt.mjs');
    expect(receipt).not.toMatch(/secrets\.HETZNER_|\bSSH_(?:USER|KEY|DIR)\b|\bHSSH\b/);
  });

  it('never represents a selectable ref or force flag as deployment authority', () => {
    const code = uncommented(deploy);
    expect(code).not.toMatch(/workflow_dispatch:|github\.event\.inputs/);
    expect(code).not.toMatch(/force=true|inputs\.force/);
    expect(code).toContain('github.event.client_payload.ref_sha');
  });

  it('immediately hands a successful exact engine release to cross-artifact production E2E', () => {
    const certification = job(deploy, 'certify-production');
    expect(certification).toContain('needs: [preflight, deploy, record-receipt]');
    expect(certification).toMatch(/^\s+contents:\s*write\s*$/m);
    expect(certification).toMatch(/^\s+actions:\s*read\s*$/m);
    expect(certification).toContain('ENGINE_SHA: ${{ needs.preflight.outputs.target_sha }}');
    expect(certification).toContain('-f event_type=run-post-deploy-e2e');
    expect(certification).toContain('-F "client_payload[engine_sha]=$ENGINE_SHA"');
    expect(certification).toContain(
      'actions/workflows/post-deploy-e2e.yml/runs?event=repository_dispatch'
    );
    expect(certification).toContain('Post-Deploy E2E $ENGINE_SHA');
    expect(certification).not.toContain('if: always()');
  });

  it('pins the engine SSH transport to only the supplied host-key file', () => {
    expect(deploy).toContain('StrictHostKeyChecking=yes');
    expect(deploy).toContain('UserKnownHostsFile=%q');
    expect(deploy).toContain('GlobalKnownHostsFile=/dev/null');
    expect(deploy).toContain('IdentitiesOnly=yes');
    expect(deploy).not.toContain('StrictHostKeyChecking=accept-new');
  });
});

describe('the Club Arena bundle publishes directly to its Hetzner origin', () => {
  it('a recovery event can publish only the exact current protected-main SHA', () => {
    const resolver = publish.slice(
      publish.indexOf('- name: Resolve the tip of main'),
      publish.indexOf('- name: Has this exact tree already passed the client suite?')
    );
    expect(resolver).toContain('[ "$REQUESTED_SHA" = "$TIP" ]');
    expect(resolver).toContain('TARGET="$REQUESTED_SHA"');
    expect(resolver).not.toContain('/compare/${REQUESTED_SHA}...${TIP}');
    expect(resolver).not.toMatch(/identical\|ahead/);
  });

  it('contains no executable World Hub checkout, sync token, or Vercel deploy', () => {
    expect(publishCode).not.toMatch(/repository:\s*Smarter-Poker\/Smarter-Poker-World-Hub/);
    expect(publishCode).not.toMatch(/WORLD_HUB_(?:SYNC_)?TOKEN/);
    expect(publishCode).not.toMatch(/\bvercel\s+(?:deploy|--prod)\b/i);
    expect(publishCode).toContain('ORIGIN_URL: https://ca-static.smarter.poker');
  });

  it('uses only the Club Arena origin credential names', () => {
    const origin = originJob();
    expect(origin).toContain('secrets.CA_ORIGIN_HOST');
    expect(origin).toContain('secrets.CA_ORIGIN_SSH_KEY');
    expect(origin).toContain('secrets.CA_ORIGIN_HOST_KEY');
    expect(origin).not.toMatch(/HETZNER_SSH_KEY|WORLD_HUB|VERCEL_TOKEN/);
  });

  it('uses the dedicated identity and pinned host key as the only SSH trust path', () => {
    const origin = originJob();
    const count = (needle: string) => origin.split(needle).length - 1;
    const transports = count('UserKnownHostsFile=$HOME/.ssh/ca_origin_known_hosts');

    expect(transports).toBe(5);
    expect(count('GlobalKnownHostsFile=/dev/null')).toBe(transports);
    expect(count('StrictHostKeyChecking=yes')).toBe(transports);
    expect(count('IdentitiesOnly=yes')).toBe(transports);
    expect(origin).toContain('chmod 600 ~/.ssh/ca_origin_known_hosts');
    expect(origin).not.toContain('StrictHostKeyChecking=accept-new');
  });

  it('runs every release job on a fresh hosted runner', () => {
    const runners = [...publish.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((match) => match[1].trim());
    expect(runners.length).toBeGreaterThanOrEqual(4);
    expect(new Set(runners)).toEqual(new Set(['ubuntu-latest']));
    expect(publish).not.toContain('vars.CI_RUNNER');
    expect(publish).not.toContain('self-hosted');
  });

  it('requires both the built artifact and the test verdict before publishing', () => {
    const origin = originJob();
    expect(origin).toContain('needs: [publish-needed, build-and-store, client-tests]');
    expect(origin).toContain("needs.build-and-store.result == 'success'");
    expect(origin).toContain("needs.client-tests.result == 'success'");
  });

  it('checks out the exact publish control before invoking repository proof scripts', () => {
    const origin = originJob();
    const checkout = origin.indexOf('- name: Checkout the exact protected-main publish control');
    const download = origin.indexOf('- name: Download the dist built by the previous job');
    const proof = origin.indexOf(
      'OURS_SHA=$(node scripts/ci/production-e2e-provenance.mjs build-info'
    );

    expect(checkout).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(checkout);
    expect(proof).toBeGreaterThan(download);
    expect(origin).toContain('ref: ${{ needs.publish-needed.outputs.target_sha }}');
    expect(origin).toContain('persist-credentials: false');
  });

  it('has read-only repository authority while the origin SSH key performs the publish', () => {
    const origin = originJob();
    expect(origin).toMatch(/^\s+contents:\s*read\s*$/m);
    expect(origin).not.toMatch(/^\s+(?:contents|actions):\s*write\s*$/m);
  });

  it('uploads an immutable release and swaps current only after the transfer', () => {
    const origin = originJob();
    const upload = origin.indexOf('"$ORIGIN_USER@$ORIGIN_HOST:$ORIGIN_ROOT/incoming/$STAGE_NAME/"');
    const manifest = origin.indexOf(
      '(cd "$STAGE" && sha256sum --strict -c .release-manifest.sha256'
    );
    const lock = origin.indexOf('flock -w 45 9');
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"');
    expect(upload).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(upload);
    expect(manifest).toBeGreaterThan(lock);
    expect(swap).toBeGreaterThan(manifest);
    expect(origin).not.toContain('$ORIGIN_ROOT/releases/$SHA/"');
    expect(publish).toContain('Seal the immutable release bytes');
    expect(origin).toContain('(cd "$FINAL" && sha256sum --strict -c');
  });

  it('reuses a sealed same-SHA release even when a rebuild has new run-time metadata', () => {
    const origin = originJob();
    const existingReleaseStart = origin.indexOf('if [ -e "$FINAL" ] || [ -L "$FINAL" ]');
    const existingReleaseEnd = origin.indexOf('else\n  mv -- "$STAGE" "$FINAL"');
    expect(existingReleaseStart).toBeGreaterThan(-1);
    expect(existingReleaseEnd).toBeGreaterThan(existingReleaseStart);
    const existingRelease = origin.slice(existingReleaseStart, existingReleaseEnd);

    expect(publish).toContain('"built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(buildProvenance).toContain('buildTime: new Date().toISOString()');
    expect(existingRelease).not.toContain(
      'cmp -s "$STAGE/.release-manifest.sha256" "$FINAL/.release-manifest.sha256"'
    );
    expect(existingRelease).toContain('find "$FINAL" -type l -print -quit');
    expect(existingRelease).toContain('sealed release contains a symlink');
    expect(existingRelease).toContain('find "$FINAL" ! -type d ! -type f -print -quit');
    expect(existingRelease).toContain('sealed release contains a special file');
    expect(existingRelease).toContain(
      '(cd "$FINAL" && sha256sum --strict -c .release-manifest.sha256 >/dev/null)'
    );
    expect(existingRelease).toContain('verify_complete_manifest "$FINAL"');
    expect(existingRelease).toContain('verify_release_identity "$FINAL" "$SHA" "$REPOSITORY"');
    expect(origin).toContain("provenance.get('schema')");
    expect(origin).toContain("provenance.get('commit') == expected_sha");
    expect(origin).toContain("provenance.get('builtBy') == 'github-actions'");
    expect(origin).toContain("provenance.get('dirty') is False");
    expect(origin).toContain("provenance.get('historyComplete') is True");
    expect(origin).toContain("provenance['behindMain'] == 0");
    expect(origin).toContain("provenance['aheadMain'] == 0");
    expect(origin).toContain("build_info.get('ca_sha') == expected_sha");
    expect(origin).toContain("build_info.get('built_by') == 'publish-club-arena.yml'");
    expect(origin).toContain("re.fullmatch(r'[0-9]+', build_info['run_id'])");
    expect(origin).toContain(
      'expected_run = f"https://github.com/{repository}/actions/runs/{build_info[\'run_id\']}"'
    );
    expect(origin).toContain("provenance.get('ciRun') == expected_run");
    expect(existingRelease).toContain('rm -rf -- "$STAGE"');
  });

  it('seals the exact pre-manifest current release for first-adoption rollback under the activation lock', () => {
    const origin = originJob();
    const lock = origin.indexOf('flock -w 45 9');
    const seal = origin.indexOf('seal_current_release_for_rollback \\');
    const pool = origin.indexOf('assert_additive_pool_has_no_collision "$FINAL/assets"');
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"');
    expect(seal).toBeGreaterThan(lock);
    expect(pool).toBeGreaterThan(seal);
    expect(swap).toBeGreaterThan(pool);
    expect(origin).toContain(
      'verify_release_identity "$release_dir" "$expected_sha" "$repository"'
    );
    expect(origin).toContain('legacy manifest staging is not on the release filesystem');
    expect(origin).toContain('sync -f "$staged_manifest"');
    expect(origin).toContain('mv -Tf "$staged_manifest" "$manifest"');
    expect(origin).toContain('rm -f -- "$ROOT/incoming/.legacy-release-manifest.$STAGE_NAME"');
  });

  it('carries the hidden release seal through the artifact courier', () => {
    const upload = publish.slice(
      publish.indexOf('- name: Upload dist for the sync job'),
      publish.indexOf('- name: Verify dist is complete')
    );
    expect(upload).toContain('uses: actions/upload-artifact@v4');
    expect(upload).toContain('include-hidden-files: true');
    expect(publish).toContain('test -s dist/.release-manifest.sha256');
  });

  it('requires the artifact to prove its exact clean protected-main CI source', () => {
    const origin = originJob();
    const gateStart = origin.indexOf(
      'EXPECTED_SHA="${{ needs.publish-needed.outputs.target_sha }}"'
    );
    const gateEnd = origin.indexOf(
      'OURS_SHA=$(node scripts/ci/production-e2e-provenance.mjs build-info'
    );
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gate = origin.slice(gateStart, gateEnd);
    expect(gate).toContain("fs.readFileSync('dist/ca-provenance.json', 'utf8')");
    expect(gate).toContain('provenance.schema === 1');
    expect(gate).toContain('provenance.commit === expectedSha');
    expect(gate).toContain("provenance.builtBy === 'github-actions'");
    expect(gate).toContain('provenance.dirty === false');
    expect(gate).toContain('provenance.historyComplete === true');
    expect(gate).toContain('provenance.behindMain === 0');
    expect(gate).toContain('provenance.aheadMain === 0');
    expect(gate).toContain('provenance.ciRun === expectedRun');
  });

  it('performs the final decision as a host-locked compare-and-swap', () => {
    const origin = originJob();
    const lock = origin.indexOf('flock -w 45 9');
    const readCurrent = origin.indexOf(
      'CURRENT_SHA=$(read_exact_build_info_sha "$ROOT/current/build-info.json")',
      lock
    );
    const compare = origin.indexOf('[ "$CURRENT_SHA" != "$EXPECTED_SHA" ]', readCurrent);
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"', compare);
    expect(lock).toBeGreaterThan(-1);
    expect(readCurrent).toBeGreaterThan(lock);
    expect(compare).toBeGreaterThan(readCurrent);
    expect(swap).toBeGreaterThan(compare);
    expect(origin).toContain('refusing stale activation');
  });

  it('parses every publish-authority build-info as strict JSON, never matching text with sed', () => {
    const origin = originJob();
    expect(origin).toContain(
      'OURS_SHA=$(node scripts/ci/production-e2e-provenance.mjs build-info < dist/build-info.json)'
    );
    expect(origin).toContain('node scripts/ci/production-e2e-provenance.mjs build-info); then');
    expect(origin).toContain('read_exact_build_info_sha "$ROOT/current/build-info.json"');
    expect(origin).toContain('read_exact_build_info_sha "$STAGE/build-info.json"');
    expect(origin).not.toMatch(/sed -n[\s\S]*ca_sha/);
  });

  it('flushes release bytes before activation and the symlink rename before success', () => {
    const origin = originJob();
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"');
    const flushes = [...origin.matchAll(/sync -f "\$ROOT"/g)].map((match) => match.index!);
    expect(flushes.some((index) => index < swap)).toBe(true);
    expect(flushes.some((index) => index > swap)).toBe(true);
    expect(origin).toContain('rsync -az --delete --fsync');
  });

  it('serializes the additive pool with activation and gives mutable fonts one pointer', () => {
    const origin = originJob();
    const lock = origin.indexOf('flock -w 45 9');
    const collisionGuard = origin.indexOf(
      'assert_additive_pool_has_no_collision "$FINAL/assets"',
      lock
    );
    const pool = origin.indexOf('rsync -a --ignore-existing --fsync "$FINAL/assets/"', lock);
    const poolProof = origin.indexOf('prove_additive_pool_contains_release "$FINAL/assets"', pool);
    const fontPointer = origin.indexOf('ln -s "$ROOT/current/fonts/fonts.css" "$FONT_NEXT"', pool);
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"', fontPointer);
    expect(collisionGuard).toBeGreaterThan(lock);
    expect(pool).toBeGreaterThan(collisionGuard);
    expect(poolProof).toBeGreaterThan(pool);
    expect(fontPointer).toBeGreaterThan(pool);
    expect(swap).toBeGreaterThan(fontPointer);
    expect(origin).not.toContain('dist/fonts/ "$ORIGIN_USER@$ORIGIN_HOST:$ORIGIN_ROOT/pool');
    expect(origin).not.toContain('find "$ROOT/pool" -type f -mtime +30 -delete');
  });

  it('rejects both changed bytes and files omitted from an existing manifest', () => {
    const origin = originJob();
    expect(origin).toContain('verify_complete_manifest "$STAGE"');
    expect(origin).toContain('verify_complete_manifest "$FINAL"');
    expect(origin).toContain("find . -type f ! -path './.release-manifest.sha256' -print0");
    expect(origin).toContain('cmp -s "$check_path" "$release_dir/.release-manifest.sha256"');
  });

  it('bounds every job and every origin transport operation', () => {
    const jobTimeouts = [...publish.matchAll(/^ {4}timeout-minutes: (\d+)$/gm)].map((match) =>
      Number(match[1])
    );
    expect(jobTimeouts).toHaveLength(5);
    expect(jobTimeouts.every((minutes) => minutes > 0 && minutes <= 30)).toBe(true);
    const origin = originJob();
    expect(origin).toContain('timeout 35s ssh');
    expect(origin).toContain('timeout 240s rsync');
    expect(origin).toContain('-o ServerAliveCountMax=2');
  });

  it('cleans the exact staging path and credentials on every terminal path', () => {
    const origin = originJob();
    expect(origin).toContain("if: always() && steps.verdict.outputs.verdict == 'publish'");
    expect(origin).toContain('rm -rf -- "$ROOT/incoming/$STAGE_NAME"');
    expect(origin).toContain('- name: Remove origin credentials and control sockets');
    expect(origin).toMatch(
      /Remove origin credentials and control sockets[\s\S]*?if: always\(\)[\s\S]*?rm -f -- "\$HOME\/\.ssh\/ca_origin"/
    );
  });

  it('proves the exact ca_sha from the live origin before declaring success', () => {
    const origin = originJob();
    const proof = origin.slice(
      origin.indexOf('- name: Verify the origin serves this bundle'),
      origin.indexOf('- name: Restore the previously verified release after any publish failure')
    );
    expect(proof).toContain('$ORIGIN_URL/build-info.json?cb=$RANDOM');
    expect(proof).toContain('$PUBLIC_URL/build-info.json?cb=$RANDOM');
    expect(proof.match(/production-e2e-provenance\.mjs unchanged "\$SHA"/g)).toHaveLength(2);
    expect(proof).toContain('[ "$LIVE_ORIGIN" = "$SHA" ]');
    expect(proof).toContain('[ "$LIVE_PUBLIC" = "$SHA" ]');
    expect(proof).toContain('echo "sha=$SHA" >> "$GITHUB_OUTPUT"');
    expect(proof).toMatch(/origin serves '\$LIVE_ORIGIN'.*wanted \$SHA[\s\S]{0,80}exit 1/);
    expect(proof).not.toMatch(/sed -n[\s\S]*ca_sha/);
    const app = job(publish, 'publish-to-app');
    expect(app).toContain("needs.publish-to-origin.outputs.verified_sha != ''");
    expect(app).toContain(
      'needs.publish-to-origin.outputs.verified_sha == needs.publish-needed.outputs.target_sha'
    );
  });

  it('restores the exact prior immutable release when post-activation proof fails', () => {
    const origin = originJob();
    const verify = origin.indexOf('- name: Verify the origin serves this bundle');
    const rollback = origin.indexOf(
      '- name: Restore the previously verified release after any publish failure'
    );
    const credentialCleanup = origin.indexOf(
      '- name: Remove origin credentials and control sockets'
    );
    expect(rollback).toBeGreaterThan(verify);
    expect(credentialCleanup).toBeGreaterThan(rollback);
    const body = origin.slice(rollback, credentialCleanup);
    expect(body).toContain("if: failure() && steps.verdict.outputs.verdict == 'publish'");
    expect(body).toContain('flock -w 45 9');
    expect(body).toContain('if [ "$CURRENT_LINK" != "$CANDIDATE" ]');
    expect(body).toContain('refusing to overwrite it');
    expect(body).toContain('(cd "$PREVIOUS" && sha256sum --strict -c');
    expect(body).toContain('cmp -s "$CHECK" "$PREVIOUS/.release-manifest.sha256"');
    expect(body).toContain(
      'python3 - "$PREVIOUS/build-info.json" "$EXPECTED_SHA" <<\'PYTHON_ROLLBACK_BUILD_INFO\''
    );
    expect(body).toContain('mv -Tf "$NEXT" "$ROOT/current"');
    expect(body.match(/production-e2e-provenance\.mjs unchanged "\$EXPECTED_SHA"/g)).toHaveLength(
      2
    );
    expect(body).toContain('[ "$LIVE_ORIGIN" = "$EXPECTED_SHA" ]');
    expect(body).toContain('[ "$LIVE_PUBLIC" = "$EXPECTED_SHA" ]');
    expect(body).not.toMatch(/sed -n[\s\S]*ca_sha/);
  });
});
